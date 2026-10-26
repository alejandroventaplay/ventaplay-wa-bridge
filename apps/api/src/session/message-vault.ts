import type { ChatMedia, MessageKind } from '@wa-bridge/shared';
import { isGroupJid, isLidJid, isUserJid, type MessageLike, normalizeJid, toMs } from './stats.js';

/**
 * Bóveda de mensajes del dueño ("Mi vista" y el asistente de Claude).
 *
 * Solo existe para el WhatsApp del dueño (OWNER_PHONE). Guarda los últimos
 * VAULT_PER_CHAT mensajes de cada chat con actividad en los últimos VAULT_WINDOW_DAYS
 * días. Mi vista muestra menos (VIEW_*). Todo se persiste cifrado (como las
 * credenciales) y se borra al desvincular.
 */
export const VAULT_PER_CHAT = 300;
export const VAULT_WINDOW_DAYS = 90;
export const VAULT_WINDOW_MS = VAULT_WINDOW_DAYS * 24 * 3600 * 1000;
/** lo que muestra Mi vista por defecto */
export const VIEW_PER_CHAT = 10;
export const VIEW_WINDOW_DAYS = 30;
export const VIEW_WINDOW_MS = VIEW_WINDOW_DAYS * 24 * 3600 * 1000;
/** solo los mensajes más recientes de cada chat conservan su miniatura (pesa) */
const THUMBS_PER_CHAT = 10;
/** prefijo de las claves en el SessionStore (junto a las credenciales, se borra con ellas) */
export const VAULT_KEY_PREFIX = 'vault:chat:';

export interface StoredMessage {
  id: string;
  fromMe: boolean;
  ts: number;
  kind: MessageKind;
  text: string | null;
  /** autor normalizado (grupos) */
  sender: string | null;
  /** autor alternativo (número si el autor vino por LID, o al revés) */
  senderAlt?: string | null;
  /** nombre que el autor tenía en WhatsApp al escribir */
  pushName: string | null;
  media: ChatMedia | null;
  location?: { lat: number; lng: number; name?: string | null } | null;
  edited?: boolean;
  /** key + message originales (JSON con Buffers), solo si hay media para descargar */
  raw?: string | null;
}

type AnyMsg = Record<string, unknown>;
type RawSerializer = (value: unknown) => string;

/** quita los envoltorios (efímero, ver una vez, documento con pie, …) */
export function unwrapMessage(message: object | null | undefined): AnyMsg | null {
  let m = (message ?? null) as AnyMsg | null;
  for (let i = 0; i < 5 && m; i++) {
    const inner =
      (m.ephemeralMessage as AnyMsg | undefined)?.message ??
      (m.viewOnceMessage as AnyMsg | undefined)?.message ??
      (m.viewOnceMessageV2 as AnyMsg | undefined)?.message ??
      (m.viewOnceMessageV2Extension as AnyMsg | undefined)?.message ??
      (m.documentWithCaptionMessage as AnyMsg | undefined)?.message ??
      (m.editedMessage as AnyMsg | undefined)?.message ??
      (m.groupMentionedMessage as AnyMsg | undefined)?.message ??
      (m.botInvokeMessage as AnyMsg | undefined)?.message ??
      (m.associatedChildMessage as AnyMsg | undefined)?.message ??
      (m.lottieStickerMessage as AnyMsg | undefined)?.message ??
      null;
    if (!inner) break;
    m = inner as AnyMsg;
  }
  return m;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const num = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v && Number.isFinite(Number(v))) return Number(v);
  if (v && typeof (v as { toNumber?: unknown }).toNumber === 'function')
    return (v as { toNumber(): number }).toNumber();
  return null;
};

export interface Extracted {
  kind: MessageKind;
  text: string | null;
  media: ChatMedia | null;
  location?: StoredMessage['location'];
  /** el mensaje trae media descargable */
  downloadable: boolean;
}

/** Tipo y texto de un mensaje. null = no se muestra (reacciones, avisos de sistema…). */
export function extractContent(message: object | null | undefined): Extracted | null {
  const m = unwrapMessage(message);
  if (!m) return null;
  const get = (k: string) => m[k] as AnyMsg | undefined;

  const conv = str(m.conversation);
  if (conv) return { kind: 'text', text: conv, media: null, downloadable: false };
  const ext = get('extendedTextMessage');
  if (ext) return { kind: 'text', text: str(ext.text), media: null, downloadable: false };

  const media = (x: AnyMsg, extra: Partial<ChatMedia> = {}): ChatMedia => ({
    mimetype: str(x.mimetype),
    size: num(x.fileLength),
    ...extra,
  });

  const img = get('imageMessage');
  if (img)
    return {
      kind: 'image',
      text: str(img.caption),
      media: media(img, { width: num(img.width), height: num(img.height) }),
      downloadable: true,
    };
  const vid = get('videoMessage') ?? get('ptvMessage');
  if (vid)
    return {
      kind: vid.gifPlayback ? 'gif' : 'video',
      text: str(vid.caption),
      media: media(vid, {
        seconds: num(vid.seconds),
        width: num(vid.width),
        height: num(vid.height),
      }),
      downloadable: true,
    };
  const aud = get('audioMessage');
  if (aud)
    return {
      kind: aud.ptt ? 'voice' : 'audio',
      text: null,
      media: media(aud, { seconds: num(aud.seconds) }),
      downloadable: true,
    };
  const stk = get('stickerMessage');
  if (stk)
    return {
      kind: 'sticker',
      text: null,
      media: media(stk, { width: num(stk.width), height: num(stk.height) }),
      downloadable: true,
    };
  const doc = get('documentMessage');
  if (doc)
    return {
      kind: 'document',
      text: str(doc.caption),
      media: media(doc, { fileName: str(doc.fileName) ?? str(doc.title) }),
      downloadable: true,
    };

  const loc = get('locationMessage') ?? get('liveLocationMessage');
  if (loc) {
    const lat = num(loc.degreesLatitude);
    const lng = num(loc.degreesLongitude);
    const name = str(loc.name) ?? str(loc.address);
    return {
      kind: 'location',
      text: name ?? str(loc.caption),
      media: null,
      location: lat !== null && lng !== null ? { lat, lng, name } : null,
      downloadable: false,
    };
  }
  const contact = get('contactMessage');
  if (contact)
    return { kind: 'contact', text: str(contact.displayName), media: null, downloadable: false };
  const contacts = get('contactsArrayMessage');
  if (contacts) {
    const list = (contacts.contacts as AnyMsg[] | undefined) ?? [];
    const names = list.map((c) => str(c.displayName)).filter(Boolean);
    return {
      kind: 'contact',
      text: str(contacts.displayName) ?? (names.join(', ') || null),
      media: null,
      downloadable: false,
    };
  }
  const poll =
    get('pollCreationMessage') ?? get('pollCreationMessageV2') ?? get('pollCreationMessageV3');
  if (poll) {
    const opts = ((poll.options as AnyMsg[] | undefined) ?? [])
      .map((o) => str(o.optionName))
      .filter(Boolean);
    const name = str(poll.name) ?? 'Encuesta';
    return {
      kind: 'poll',
      text: opts.length ? `${name}\n${opts.map((o) => `○ ${o}`).join('\n')}` : name,
      media: null,
      downloadable: false,
    };
  }

  // mensajes de negocio / botones: mostramos el texto que traigan
  const tpl = get('templateMessage');
  const hydrated = (tpl?.hydratedTemplate ?? tpl?.hydratedFourRowTemplate) as AnyMsg | undefined;
  const buttons = get('buttonsMessage');
  const list = get('listMessage');
  const interactive = get('interactiveMessage');
  const biz =
    str(hydrated?.hydratedContentText) ??
    str(buttons?.contentText) ??
    str(list?.description) ??
    str((interactive?.body as AnyMsg | undefined)?.text) ??
    str((get('buttonsResponseMessage') ?? {}).selectedDisplayText) ??
    str(((get('listResponseMessage') ?? {}) as AnyMsg).title) ??
    str(((get('templateButtonReplyMessage') ?? {}) as AnyMsg).selectedDisplayText);
  if (biz) return { kind: 'text', text: biz, media: null, downloadable: false };

  const keys = Object.keys(m);
  // reacciones, llaves, avisos internos: no son mensajes que se lean
  const silent = new Set([
    'reactionMessage',
    'encReactionMessage',
    'protocolMessage',
    'senderKeyDistributionMessage',
    'messageContextInfo',
    'pollUpdateMessage',
    'keepInChatMessage',
    'pinInChatMessage',
    'call',
  ]);
  if (keys.length === 0 || keys.every((k) => silent.has(k))) return null;
  return { kind: 'other', text: null, media: null, downloadable: false };
}

/** protocolMessage: borrado (0) o edición (14) de un mensaje anterior */
export function protocolAction(
  message: object | null | undefined,
): { type: 'revoke' | 'edit'; id: string; edited?: Extracted | null } | null {
  const m = unwrapMessage(message);
  const p = m?.protocolMessage as AnyMsg | undefined;
  if (!p) return null;
  const id = str((p.key as AnyMsg | undefined)?.id);
  if (!id) return null;
  const type = num(p.type);
  if (type === 0) return { type: 'revoke', id };
  if (type === 14) return { type: 'edit', id, edited: extractContent(p.editedMessage as object) };
  return null;
}

/** un mensaje de WhatsApp ya leído: o es contenido para guardar, o borra/edita uno anterior */
export type ParsedVaultMessage =
  | { jid: string; action: NonNullable<ReturnType<typeof protocolAction>> }
  | { jid: string; stored: StoredMessage };

/**
 * Lee un mensaje de WhatsApp como lo guardan la bóveda y la migración. `serialize` = null
 * no guarda el original (sin media para descargar después).
 */
export function parseVaultMessage(
  m: MessageLike,
  serialize: RawSerializer | null,
): ParsedVaultMessage | null {
  const jidRaw = m?.key?.remoteJid;
  const id = m?.key?.id;
  if (!jidRaw || !id || !m.message) return null;
  const jid = normalizeJid(jidRaw);
  if (!isUserJid(jid) && !isGroupJid(jid)) return null;

  const action = protocolAction(m.message);
  if (action) return { jid, action };
  const content = extractContent(m.message);
  if (!content) return null;
  const ts = toMs(m.messageTimestamp);
  if (!ts) return null;
  const key = m.key as { fromMe?: boolean | null; participant?: string | null } & NonNullable<
    MessageLike['key']
  >;
  const group = isGroupJid(jid);
  const part = group && key.participant ? normalizeJid(key.participant) : null;
  const partAlt = group && key.participantAlt ? normalizeJid(key.participantAlt) : null;
  // preferimos el número como autor; el LID queda de alternativo
  const sender = part && isLidJid(part) && partAlt && !isLidJid(partAlt) ? partAlt : part;
  const senderAlt = sender === part ? partAlt : part;
  return {
    jid,
    stored: {
      id,
      fromMe: Boolean(key.fromMe),
      ts,
      kind: content.kind,
      text: content.text,
      sender,
      senderAlt: senderAlt ?? null,
      pushName: m.pushName ?? null,
      media: content.media,
      ...(content.location ? { location: content.location } : {}),
      raw:
        content.downloadable && serialize
          ? serialize({ key: m.key, message: m.message, messageTimestamp: m.messageTimestamp })
          : null,
    },
  };
}

export class MessageVault {
  private chats = new Map<string, StoredMessage[]>();
  private dirty = new Set<string>();

  constructor(private readonly serialize: RawSerializer = (v) => JSON.stringify(v)) {}

  get size(): number {
    return this.chats.size;
  }

  /** Agrega mensajes (History Sync o en vivo). Devuelve cuántos cambiaron algo. */
  add(messages: MessageLike[]): number {
    let changed = 0;
    for (const m of messages) {
      const p = parseVaultMessage(m, this.serialize);
      if (!p) continue;
      if ('action' in p) {
        if (this.applyAction(p.jid, p.action)) changed += 1;
      } else if (this.insert(p.jid, p.stored)) changed += 1;
    }
    return changed;
  }

  private insert(jid: string, msg: StoredMessage): boolean {
    const list = this.chats.get(jid) ?? [];
    const prev = list.findIndex((x) => x.id === msg.id);
    if (prev >= 0) {
      // ya lo teníamos (llega dos veces: history sync + en vivo): conserva borrado/edición
      const old = list[prev]!;
      if (old.kind === 'deleted' || old.edited) return false;
      list[prev] = { ...msg, pushName: msg.pushName ?? old.pushName };
      this.dirty.add(jid);
      return true;
    }
    // ¿cabe entre los últimos N?
    if (list.length >= VAULT_PER_CHAT && msg.ts <= list[0]!.ts) return false;
    list.push(msg);
    list.sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
    while (list.length > VAULT_PER_CHAT) list.shift();
    this.chats.set(jid, list);
    this.dirty.add(jid);
    return true;
  }

  private applyAction(
    jid: string,
    action: NonNullable<ReturnType<typeof protocolAction>>,
  ): boolean {
    const list = this.chats.get(jid);
    const msg = list?.find((x) => x.id === action.id);
    if (!msg) return false;
    if (action.type === 'revoke') {
      msg.kind = 'deleted';
      msg.text = null;
      msg.media = null;
      msg.raw = null;
      delete msg.location;
    } else if (action.edited) {
      msg.text = action.edited.text;
      msg.edited = true;
    } else {
      return false;
    }
    this.dirty.add(jid);
    return true;
  }

  /** chats guardados (jid → mensajes de más antiguo a más nuevo) */
  entries(): [string, StoredMessage[]][] {
    return [...this.chats.entries()];
  }

  /** marca para guardar el chat que contiene este mensaje (tras cambiarle el raw) */
  touch(id: string): void {
    for (const [jid, list] of this.chats)
      if (list.some((m) => m.id === id)) {
        this.dirty.add(jid);
        return;
      }
  }

  get(jid: string): StoredMessage[] {
    return this.chats.get(jid) ?? [];
  }

  /** suelta los chats sin actividad en la ventana; devuelve cuántos quitó */
  prune(now = Date.now()): number {
    const cutoff = now - VAULT_WINDOW_MS;
    let removed = 0;
    for (const [jid, list] of this.chats) {
      const newest = list[list.length - 1]?.ts ?? 0;
      if (newest < cutoff) {
        this.chats.delete(jid);
        this.dirty.add(jid);
        removed += 1;
      }
    }
    return removed;
  }

  /** chats y mensajes dentro de la ventana */
  counts(now = Date.now(), windowMs = VAULT_WINDOW_MS): { chats: number; messages: number } {
    const cutoff = now - windowMs;
    let chats = 0;
    let messages = 0;
    for (const list of this.chats.values()) {
      if ((list[list.length - 1]?.ts ?? 0) < cutoff) continue;
      chats += 1;
      messages += list.length;
    }
    return { chats, messages };
  }

  clear(): void {
    for (const jid of this.chats.keys()) this.dirty.add(jid);
    this.chats.clear();
  }

  /** cambios pendientes de guardar: clave → JSON (null = borrar) */
  takeDirty(now = Date.now()): Record<string, string | null> {
    const cutoff = now - VAULT_WINDOW_MS;
    const out: Record<string, string | null> = {};
    for (const jid of this.dirty) {
      const list = this.chats.get(jid);
      const active = list && (list[list.length - 1]?.ts ?? 0) >= cutoff;
      // en disco solo quedan los chats con actividad en la ventana
      out[VAULT_KEY_PREFIX + jid] = active ? JSON.stringify(this.lighten(list)) : null;
    }
    this.dirty.clear();
    return out;
  }

  /** quita las miniaturas de los mensajes que ya no están entre los más recientes */
  private lighten(list: StoredMessage[]): StoredMessage[] {
    const keepFrom = list.length - THUMBS_PER_CHAT;
    list.forEach((m, i) => {
      if (i < keepFrom && m.raw && m.raw.includes('jpegThumbnail')) m.raw = stripThumbnails(m.raw);
    });
    return list;
  }

  /** vuelve a marcar como pendientes (si falló el guardado) */
  markDirty(keys: string[]): void {
    for (const k of keys)
      if (k.startsWith(VAULT_KEY_PREFIX)) this.dirty.add(k.slice(VAULT_KEY_PREFIX.length));
  }

  /** carga lo guardado (clave del store → JSON) */
  load(entries: Map<string, string>): void {
    for (const [key, json] of entries) {
      if (!key.startsWith(VAULT_KEY_PREFIX)) continue;
      try {
        const list = JSON.parse(json) as StoredMessage[];
        if (Array.isArray(list) && list.length)
          this.chats.set(key.slice(VAULT_KEY_PREFIX.length), list.slice(-VAULT_PER_CHAT));
      } catch {
        /* un archivo dañado no bota el resto */
      }
    }
  }
}

/** borra los campos jpegThumbnail de un mensaje serializado */
export function stripThumbnails(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), (k, v) => (k === 'jpegThumbnail' ? undefined : v));
  } catch {
    return raw;
  }
}
