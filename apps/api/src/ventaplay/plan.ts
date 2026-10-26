import type { StoredMessage } from '../session/message-vault.js';
import type { Directory, DirectoryPerson } from '../session/stats.js';
import { isGroupJid, phoneOf } from '../session/stats.js';

/**
 * Arma lo que se manda a las APIs import-* de VentaPlay a partir de lo que llegó del
 * teléfono: los contactos con número (import-clients) y, si la sesión está en modo
 * migración, sus conversaciones individuales (import-messages). Los grupos no van: el
 * CRM no tiene grupos. Todo lleva `external_id` estable, así que repetir no duplica.
 */

export interface MigrationSource {
  /** número de la sesión, solo dígitos */
  sessionPhone: string;
  /** nombre con que se marcan los mensajes enviados desde este número */
  sessionName: string | null;
  directory: Directory;
  /** conversaciones guardadas (modo migración); null = solo contactos */
  chats: { jid: string; messages: StoredMessage[] }[] | null;
}

export interface ClientItem {
  external_id: string;
  nombre: string;
  telefono: string;
  phone_number_id?: string;
  tipo_de_fuente: string;
  campos_personalizados: Record<string, string | number>;
  created_at?: string;
  /** solo al crear (import-clients v14 deja NULL una columna NOT NULL si no viene) */
  valores_especiales?: [];
}

export interface MessageItem {
  external_id: string;
  cliente_external_id: string;
  contacto_mensaje?: string;
  organizacion_mensaje?: string;
  enviado_por?: string;
  canal: 'whatsapp';
  tipo_mensaje: string;
  created_at: string;
  debug_metadata: { origen: 'wa-bridge'; whatsapp_id: string; chat: string };
}

export interface MigrationItems {
  clients: ClientItem[];
  messages: MessageItem[];
  sinNumero: number;
  grupos: number;
  chatsConMensajes: number;
  mensajesFuera: number;
  /** dejados fuera por el filtro de privacidad (null = sin filtro) */
  privados: { clientes: number; mensajes: number } | null;
}

export const FUENTE = 'WA_BRIDGE';
export const importIdFor = (sessionPhone: string) => `wa-bridge-${sessionPhone}`;
export const clientExternalId = (sessionPhone: string, phone: string) =>
  `wabridge:${sessionPhone}:cliente:${phone}`;

const iso = (ms: number | null) => (ms ? new Date(ms).toISOString() : undefined);

function clientName(p: DirectoryPerson): string {
  return p.displayName ?? p.pushName ?? p.businessName ?? 'Contacto WhatsApp';
}

export function buildClient(
  p: DirectoryPerson,
  sessionPhone: string,
  phoneNumberId: string | null,
): ClientItem | null {
  if (!p.phone) return null;
  const campos: Record<string, string | number> = { wa_origen: `WhatsApp +${sessionPhone}` };
  if (p.pushName) campos.wa_nombre_whatsapp = p.pushName;
  if (p.businessName) campos.wa_empresa = p.businessName;
  if (p.savedName) campos.wa_nombre_agenda = p.savedName;
  if (p.messages) campos.wa_mensajes = p.messages;
  if (p.firstMessageAt) campos.wa_primer_mensaje = iso(p.firstMessageAt)!;
  if (p.lastMessageAt) campos.wa_ultimo_mensaje = iso(p.lastMessageAt)!;
  const item: ClientItem = {
    external_id: clientExternalId(sessionPhone, p.phone),
    nombre: clientName(p),
    telefono: p.phone,
    tipo_de_fuente: FUENTE,
    campos_personalizados: campos,
  };
  if (phoneNumberId) item.phone_number_id = phoneNumberId;
  const created = iso(p.firstMessageAt);
  if (created) item.created_at = created;
  return item;
}

/** tipo de mensaje de WhatsApp → `tipo_mensaje` de VentaPlay */
const TIPO: Record<StoredMessage['kind'], string> = {
  text: 'texto',
  image: 'imagen',
  gif: 'video',
  video: 'video',
  audio: 'audio',
  voice: 'audio',
  sticker: 'sticker',
  document: 'documento',
  location: 'ubicacion',
  contact: 'contacto',
  poll: 'texto',
  deleted: 'texto',
  other: 'texto',
};

/** nota para lo que la v1 no migra (archivos) */
const NOTA: Partial<Record<StoredMessage['kind'], string>> = {
  image: '[Imagen no migrada]',
  gif: '[GIF no migrado]',
  video: '[Video no migrado]',
  audio: '[Audio no migrado]',
  voice: '[Nota de voz no migrada]',
  sticker: '[Sticker]',
  contact: '[Contacto]',
  poll: '[Encuesta]',
};

/** texto que queda en VentaPlay; null = el mensaje no se migra */
export function messageText(m: StoredMessage): string | null {
  if (m.kind === 'deleted') return null;
  const text = m.text?.trim() || null;
  if (m.kind === 'document') {
    const name = m.media?.fileName ? `: ${m.media.fileName}` : '';
    return [`[Documento no migrado${name}]`, text].filter(Boolean).join(' ');
  }
  if (m.kind === 'location') {
    const l = m.location;
    const where = l ? [l.name, `${l.lat},${l.lng}`].filter(Boolean).join(' · ') : null;
    return ['[Ubicación]', where, text].filter(Boolean).join(' ');
  }
  const nota = NOTA[m.kind];
  if (nota) return [nota, text].filter(Boolean).join(' ');
  return text;
}

/**
 * @param exclude números que el filtro de privacidad deja fuera (ni cliente ni mensajes);
 *   null = filtro apagado
 */
export function buildItems(
  src: MigrationSource,
  phoneNumberId: string | null,
  exclude: Set<string> | null = null,
): MigrationItems {
  const { sessionPhone } = src;
  const clients: ClientItem[] = [];
  const byPhone = new Map<string, string>();
  let sinNumero = 0;
  const privados = exclude ? { clientes: 0, mensajes: 0 } : null;
  for (const p of src.directory.people) {
    if (p.phone === sessionPhone) continue; // el propio número no es cliente
    if (privados && p.phone && exclude!.has(p.phone)) {
      privados.clientes += 1;
      continue;
    }
    const c = buildClient(p, sessionPhone, phoneNumberId);
    if (!c) {
      sinNumero += 1;
      continue;
    }
    clients.push(c);
    byPhone.set(p.phone!, c.external_id);
  }

  const messages: MessageItem[] = [];
  let chatsConMensajes = 0;
  let mensajesFuera = 0;
  const sender = src.sessionName?.trim() || `WhatsApp +${sessionPhone}`;
  for (const chat of src.chats ?? []) {
    const phone = isGroupJid(chat.jid) ? null : phoneOf(chat.jid);
    const cliente = phone ? byPhone.get(phone) : undefined;
    if (!cliente) {
      if (privados && phone && exclude!.has(phone))
        privados.mensajes += chat.messages.filter((m) => messageText(m)).length;
      else mensajesFuera += chat.messages.length;
      continue;
    }
    let n = 0;
    for (const m of chat.messages) {
      const text = messageText(m);
      if (!text) continue;
      messages.push({
        external_id: `wabridge:${sessionPhone}:msg:${phone}:${m.id}`,
        cliente_external_id: cliente,
        ...(m.fromMe
          ? { organizacion_mensaje: text, enviado_por: sender }
          : { contacto_mensaje: text }),
        canal: 'whatsapp',
        tipo_mensaje: TIPO[m.kind],
        created_at: new Date(m.ts).toISOString(),
        debug_metadata: { origen: 'wa-bridge', whatsapp_id: m.id, chat: chat.jid },
      });
      n += 1;
    }
    if (n) chatsConMensajes += 1;
  }
  return {
    clients,
    messages,
    sinNumero,
    grupos: src.directory.groups.length,
    chatsConMensajes,
    mensajesFuera,
    privados,
  };
}
