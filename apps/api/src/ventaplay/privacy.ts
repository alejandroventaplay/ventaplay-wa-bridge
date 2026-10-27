import type {
  PrivacyApproval,
  PrivacyCategory,
  PrivacyCounts,
  PrivacyDecision,
  PrivacyRow,
  PrivacyState,
} from '@wa-bridge/shared';
import type { StoredMessage } from '../session/message-vault.js';
import type { Directory, DirectoryPerson } from '../session/stats.js';
import { isGroupJid, phoneOf } from '../session/stats.js';
import { messageText } from './plan.js';

/**
 * Filtro de privacidad (voluntario) antes de importar a VentaPlay.
 *
 * En un WhatsApp que se usa para el negocio y para lo personal, sugiere por contacto si la
 * conversación es comercial (clientes, prospectos), privada (familia, amigos) o dudosa.
 * Todo corre en el Bridge, sin mandar nada afuera: busca palabras y frases en el nombre
 * de agenda y en los mensajes. La persona revisa la lista y decide; lo que decide pisa la
 * sugerencia. Con el filtro activo, lo excluido no se importa ni sale en los Excel.
 */

/** término → peso (texto normalizado: minúsculas, sin tildes, ñ → n) */
type Terms = Record<string, number>;

/** señales de negocio: agenda, precios, pagos, servicios y rubros comunes */
const COMERCIAL: Terms = {
  // agenda
  agendar: 2,
  agendo: 2,
  agende: 2,
  agendada: 2,
  agendado: 2,
  agendamiento: 2,
  agenda: 1,
  reservar: 2,
  reserva: 2,
  reservo: 2,
  cita: 2,
  'una hora': 2,
  'tomar hora': 3,
  'pedir hora': 3,
  'agendar hora': 3,
  'hora para': 2,
  'su hora': 2,
  'tu hora': 1,
  'mi hora': 2,
  'hora disponible': 3,
  'horas disponibles': 3,
  disponibilidad: 2,
  horario: 1,
  horarios: 2,
  cupo: 2,
  cupos: 2,
  reagendar: 3,
  'confirmo la hora': 3,
  'confirmar la hora': 3,
  'confirmar su hora': 3,
  'confirmar tu hora': 3,
  'confirmar asistencia': 3,
  // precios y pagos
  precio: 2,
  precios: 2,
  valor: 1,
  valores: 2,
  'cuanto sale': 3,
  'cuanto cuesta': 3,
  'cuanto vale': 3,
  'cuanto cobra': 3,
  'cuanto cobran': 3,
  'que valor': 3,
  cotizacion: 2,
  cotizar: 2,
  presupuesto: 2,
  promocion: 2,
  promociones: 2,
  promo: 2,
  descuento: 2,
  oferta: 1,
  pack: 2,
  'gift card': 3,
  giftcard: 3,
  abono: 2,
  abonar: 2,
  transferencia: 1,
  'datos bancarios': 2,
  'datos de transferencia': 2,
  'datos para transferir': 2,
  comprobante: 1,
  boleta: 2,
  factura: 1,
  efectivo: 1,
  'link de pago': 3,
  // consultas
  informacion: 1,
  info: 1,
  consulta: 1,
  consultar: 1,
  'queria saber': 1,
  'quisiera saber': 2,
  'me gustaria saber': 2,
  'queria consultar': 2,
  'quisiera consultar': 2,
  'queria agendar': 3,
  'quiero agendar': 3,
  // belleza y estética
  peluqueria: 2,
  corte: 1,
  peinado: 2,
  brushing: 2,
  tinte: 2,
  tintura: 2,
  mechas: 2,
  balayage: 3,
  visos: 2,
  decoloracion: 2,
  alisado: 2,
  keratina: 3,
  'botox capilar': 3,
  barberia: 2,
  manicure: 3,
  manicura: 3,
  pedicure: 3,
  esmaltado: 3,
  'esmalte permanente': 3,
  acrilicas: 3,
  polygel: 3,
  kapping: 3,
  cejas: 2,
  pestanas: 2,
  lifting: 2,
  laminado: 2,
  depilacion: 3,
  depilar: 2,
  laser: 2,
  facial: 2,
  'limpieza facial': 3,
  peeling: 3,
  dermapen: 3,
  hydrafacial: 3,
  hidrafacial: 3,
  radiofrecuencia: 3,
  cavitacion: 3,
  lipolaser: 3,
  masaje: 2,
  masajes: 2,
  drenaje: 2,
  linfatico: 2,
  reductivo: 3,
  reductor: 2,
  moldeador: 3,
  corporal: 2,
  maderoterapia: 3,
  presoterapia: 3,
  hifu: 3,
  botox: 2,
  'acido hialuronico': 3,
  hialuronico: 3,
  relleno: 2,
  ojeras: 2,
  mesoterapia: 3,
  bioestimulador: 3,
  tratamiento: 2,
  tratamientos: 2,
  sesion: 1,
  sesiones: 2,
  evaluacion: 2,
  estetica: 2,
  podologia: 3,
  // medicina estética y consulta médica
  doctora: 2,
  dra: 2,
  doctor: 1,
  'consulta medica': 3,
  control: 1,
  'hora medica': 3,
  receta: 2,
  examen: 1,
  examenes: 2,
  'toxina botulinica': 3,
  bruxismo: 3,
  rinomodelacion: 3,
  pomulo: 2,
  pomulos: 2,
  menton: 2,
  labios: 1,
  plasma: 2,
  plaquetas: 2,
  exosomas: 3,
  polinucleotidos: 3,
  'skin booster': 3,
  sculptra: 3,
  endolaser: 3,
  acrocordones: 3,
  verrugas: 2,
  fibromas: 2,
  auriculoterapia: 3,
  'flores de bach': 3,
  sueroterapia: 3,
  'suero terapia': 3,
  bioimpedanciometria: 3,
  'control de peso': 3,
  hiperhidrosis: 3,
  estrias: 2,
  cicatrices: 2,
  flacidez: 3,
  manchas: 1,
  arrugas: 2,
  surcos: 2,
  microneedling: 3,
  plasmage: 3,
  blefaroplastia: 3,
  despigmentante: 3,
  colageno: 2,
  hidroxiapatita: 3,
  rejuvenecimiento: 3,
  inyeccion: 1,
  procedimiento: 2,
  // local
  direccion: 1,
  ubicacion: 1,
  estacionamiento: 1,
  'como llego': 2,
  sucursal: 2,
  // del lado del negocio
  'le esperamos': 3,
  'te esperamos': 3,
  'quedo agendada': 3,
  'quedo agendado': 3,
  'queda agendada': 3,
  'queda agendado': 3,
  'le recordamos': 3,
  'te recordamos': 2,
  recordatorio: 2,
  estimada: 2,
  estimado: 2,
  preferirnos: 3,
  // comercio y taller (otros rubros)
  pedido: 1,
  despacho: 2,
  stock: 2,
  catalogo: 2,
  delivery: 1,
  mantencion: 2,
  'revision tecnica': 3,
  frenos: 2,
  neumaticos: 2,
  repuesto: 2,
  repuestos: 2,
  patente: 1,
};

/** nombre de agenda que delata un vínculo personal */
const NOMBRE_PRIVADO = [
  'mama',
  'mami',
  'mamita',
  'madre',
  'papa',
  'papi',
  'papito',
  'padre',
  'hijo',
  'hija',
  'hijito',
  'hijita',
  'hermano',
  'hermana',
  'hermanito',
  'hermanita',
  'herma',
  'tio',
  'tia',
  'tita',
  'abuelo',
  'abuela',
  'abue',
  'tata',
  'lela',
  'primo',
  'prima',
  'sobrino',
  'sobrina',
  'suegro',
  'suegra',
  'cunado',
  'cunada',
  'esposo',
  'esposa',
  'marido',
  'amor',
  'mi vida',
  'gordo',
  'gorda',
  'gordi',
  'pololo',
  'polola',
  'amiga',
  'amigo',
  'vecino',
  'vecina',
  'nana',
  'padrino',
  'madrina',
  'ahijado',
  'ahijada',
  'yerno',
  'nuera',
  'familia',
  'colegio',
  'jardin',
  'mi hermoso',
  'mi hermosa',
  'mi bebe',
  'mi princesa',
  'mi rey',
  'mi reina',
  'mi nino',
  'mi nina',
  'mi gordo',
  'mi gorda',
  'mi cielo',
  'mi corazon',
];

/**
 * nombre de agenda que delata a un cliente: muchos negocios guardan así a sus clientes
 * ("Andrea Pac Labios", "Karen Laser Co2", "Ana Paciente", "María depilación")
 */
const NOMBRE_COMERCIAL = [
  'paciente',
  'pacientes',
  'pac',
  'paci',
  'pacie',
  'pacien',
  'pacient',
  'paciebte',
  'pacinte',
  'pacente',
  'oac',
  'cliente',
  'clienta',
  'co2',
  'laser',
  'endolaser',
  'botox',
  'toxina',
  'labios',
  'acido',
  'hialuronico',
  'peeling',
  'mesoterapia',
  'ojeras',
  'rino',
  'rinomodelacion',
  'plasma',
  'bioestimulador',
  'sculptra',
  'depilacion',
  'facial',
  'masaje',
  'masajes',
  'drenaje',
  'manicure',
  'pedicure',
  'pestanas',
  'cejas',
  'keratina',
  'mechas',
];

/** lo que una empresa le escribe al dueño cuando él es el cliente (no es cliente suyo) */
const PROVEEDOR: Terms = {
  'tu pedido': 3,
  entregaremos: 3,
  repartidor: 3,
  'estamos en la puerta': 3,
  'tu compra': 2,
  'tu envio': 2,
  'en camino': 2,
  despachado: 2,
  'codigo de verificacion': 3,
  'tu codigo': 2,
  'con el ejecutivo': 3,
  ejecutivo: 1,
  catalogo: 2,
  'tu cuenta': 1,
  'tu boleta': 2,
  'tu suscripcion': 3,
};

/** trato cercano en los mensajes */
const PRIVADO: Terms = {
  'te amo': 4,
  'te quiero': 3,
  'te extrano': 3,
  'mi amor': 3,
  amorcito: 3,
  'mi vida': 3,
  'mi cielo': 3,
  'mi reina': 2,
  'mi nina': 2,
  mamita: 2,
  papito: 2,
  hijita: 2,
  hijito: 2,
  mami: 2,
  papi: 2,
  suegra: 2,
  cunada: 2,
  abuela: 1,
  abue: 2,
  'feliz cumple': 1,
  cumpleanos: 1,
  'los ninos': 1,
  colegio: 1,
  almuerzo: 1,
  asado: 1,
  carrete: 2,
  vacaciones: 1,
  'buenas noches': 1,
  'que duermas': 2,
};

COMERCIAL.retoque = 3;
COMERCIAL.toxina = 2;
COMERCIAL.acido = 2;
COMERCIAL.indicaciones = 2;
COMERCIAL.procedimientos = 2;
COMERCIAL.paciente = 2;
delete COMERCIAL.catalogo;

export const normalize = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** una sola expresión por lista, palabras completas, las frases largas primero */
function matcher(terms: string[]): RegExp {
  const sorted = [...terms].sort((a, b) => b.length - a.length).map(escape);
  return new RegExp(`(?<![a-z0-9])(?:${sorted.join('|')})(?![a-z0-9])`, 'g');
}

const RE_COMERCIAL = matcher(Object.keys(COMERCIAL));
const RE_PRIVADO = matcher(Object.keys(PRIVADO));
const RE_NOMBRE = matcher(NOMBRE_PRIVADO);
const RE_NOMBRE_COMERCIAL = matcher(NOMBRE_COMERCIAL);
const RE_PROVEEDOR = matcher(Object.keys(PROVEEDOR));

export interface ClassifyContext {
  /** nombre del negocio (perfil de WhatsApp): aparece en los mensajes a clientes */
  businessName?: string | null;
  /** quien autorizó la migración ("Doctora Ana Rivas Soto"): su apellido delata familia */
  ownerName?: string | null;
}

/** trato íntimo: con varios mensajes así no es un cliente cualquiera */
const INTIMO = [
  'te amo',
  'te quiero',
  'te extrano',
  'mi amor',
  'amorcito',
  'mi vida',
  'mi cielo',
  'mami',
  'papi',
  'mamita',
  'papito',
  'hijita',
  'hijito',
  'mi nina',
  'mi reina',
  'carrete',
  'feliz cumple',
  'que duermas',
];
const RE_INTIMO = matcher(INTIMO);
/** desde aquí una conversación suele ser equipo, familia o socio, no un cliente */
export const LARGA = 800;
const TITULOS = new Set(['doctora', 'doctor', 'dra', 'dr', 'sra', 'sr', 'don', 'dona', 'srta']);

/** apellidos de quien autorizó: las palabras después del primer nombre (de 4+ letras) */
export function ownerSurnames(owner: string | null | undefined): string[] {
  if (!owner) return [];
  const words = normalize(owner)
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !TITULOS.has(w));
  return words.slice(1).filter((w) => w.length >= 4);
}

export interface Classification {
  category: PrivacyCategory;
  score: { comercial: number; privado: number };
  reasons: string[];
}

/** suma pesos de términos distintos; devuelve los encontrados de mayor a menor peso */
function scan(texts: string[], re: RegExp, weights: Terms | null) {
  const hits = new Map<string, number>();
  for (const t of texts) for (const m of t.matchAll(re)) hits.set(m[0], (hits.get(m[0]) ?? 0) + 1);
  let score = 0;
  for (const term of hits.keys()) score += weights ? (weights[term] ?? 1) : 1;
  const top = [...hits.entries()]
    .sort((a, b) => (weights?.[b[0]] ?? 1) - (weights?.[a[0]] ?? 1) || b[1] - a[1])
    .map(([t]) => t);
  return { score, top, hits };
}

export function classify(
  person: Pick<DirectoryPerson, 'displayName' | 'savedName' | 'pushName' | 'inAddressBook'>,
  messages: StoredMessage[],
  ctx: ClassifyContext = {},
): Classification {
  const reasons: string[] = [];
  const saved = person.savedName ?? (person.inAddressBook ? person.displayName : null);
  const surnames = ownerSurnames(ctx.ownerName);
  const anyName = normalize(
    [saved, person.pushName, person.displayName].filter(Boolean).join(' '),
  ).replace(/[^a-z\s]/g, ' ');
  const sameSurname = surnames.find((w) => new RegExp(`(^|\\s)${w}(\\s|$)`).test(anyName));
  if (saved) {
    const n = normalize(saved);
    const priv = n.match(RE_NOMBRE);
    const com = n.match(RE_NOMBRE_COMERCIAL);
    if (priv && com) {
      // "Catalina Mamá Paciente": vínculo personal y además cliente → que decida una persona
      reasons.push(`Nombre en agenda mezcla lo personal y lo comercial: "${saved}"`);
      return { category: 'revisar', score: { comercial: 10, privado: 10 }, reasons };
    }
    if (priv) {
      reasons.push(`Nombre en agenda: "${saved}"`);
      return { category: 'privado', score: { comercial: 0, privado: 10 }, reasons };
    }
    if (com) {
      reasons.push(`Guardado como cliente: "${saved}"`);
      return { category: 'comercial', score: { comercial: 10, privado: 0 }, reasons };
    }
  }

  const texts = messages.map((m) => messageText(m)).filter((t): t is string => Boolean(t));
  const norm = texts.map(normalize);
  const com = scan(norm, RE_COMERCIAL, COMERCIAL);
  const pri = scan(norm, RE_PRIVADO, PRIVADO);
  const incomingNorm = messages
    .filter((m) => !m.fromMe)
    .map((m) => messageText(m))
    .filter((t): t is string => Boolean(t))
    .map(normalize);
  const prov = scan(incomingNorm, RE_PROVEEDOR, PROVEEDOR);
  let comercial = Math.min(com.score, 30);
  const privado = Math.min(pri.score, 30);

  const business = ctx.businessName ? normalize(ctx.businessName).trim() : '';
  if (business.length >= 6 && business.includes(' ') && norm.some((t) => t.includes(business))) {
    comercial += 3;
    reasons.push(`Menciona "${ctx.businessName}"`);
  }
  if (com.top.length) reasons.push(`Habla de: ${com.top.slice(0, 5).join(', ')}`);
  if (pri.top.length) reasons.push(`Trato cercano: ${pri.top.slice(0, 4).join(', ')}`);
  if (prov.score >= 3 && comercial < 6) {
    reasons.unshift(
      `Le escribe una empresa (aquí el cliente es el dueño): ${prov.top.slice(0, 3).join(', ')}`,
    );
    return { category: 'privado', score: { comercial, privado: privado + prov.score }, reasons };
  }

  const incoming = messages.filter((m) => !m.fromMe).length;
  if (sameSurname) {
    reasons.unshift(`Mismo apellido que quien autorizó ("${sameSurname}"): ¿familia?`);
    return { category: 'revisar', score: { comercial, privado }, reasons };
  }
  if (!messages.length) {
    reasons.push('Sin conversación guardada');
    return { category: 'revisar', score: { comercial, privado }, reasons };
  }
  const intimos = norm.filter((t) => {
    RE_INTIMO.lastIndex = 0;
    return RE_INTIMO.test(t);
  }).length;
  if (intimos >= 5) {
    reasons.unshift(`Trato íntimo en ${intimos} mensajes`);
    return { category: 'privado', score: { comercial, privado: privado + intimos }, reasons };
  }
  if (messages.length >= LARGA) {
    reasons.unshift(
      `Conversación muy larga (${messages.length} mensajes): suele ser equipo, familia o socio`,
    );
    return { category: 'revisar', score: { comercial, privado }, reasons };
  }
  // contacto que escribe y no está en la agenda: típico de un cliente nuevo
  if (person.inAddressBook === false && incoming > 0) comercial += 1;

  let category: PrivacyCategory;
  if (privado >= 4 && privado >= comercial) category = 'privado';
  else if (comercial >= 3 && comercial >= privado * 1.5) category = 'comercial';
  else if (privado >= 3 && comercial <= 1) category = 'privado';
  else category = 'revisar';
  if (category === 'comercial' && intimos >= 2) {
    category = 'revisar';
    reasons.unshift(`Habla de negocio pero con trato íntimo (${intimos} mensajes)`);
  }
  if (category === 'revisar' && !com.top.length && !pri.top.length)
    reasons.push('Sin palabras de negocio ni de trato cercano');
  return { category, score: { comercial, privado }, reasons };
}

// ------------------------------------------------------------ lista y decisiones

export interface PrivacySettings {
  active: boolean;
  reviewIncluded: boolean;
  decisions: Record<string, PrivacyDecision>;
  updatedAt: number | null;
  approval: PrivacyApproval | null;
}

export const emptySettings = (): PrivacySettings => ({
  active: false,
  reviewIncluded: false,
  decisions: {},
  updatedAt: null,
  approval: null,
});

export function parseSettings(json: string | null): PrivacySettings {
  if (!json) return emptySettings();
  try {
    const v = JSON.parse(json) as Partial<PrivacySettings>;
    const decisions: Record<string, PrivacyDecision> = {};
    for (const [k, d] of Object.entries(v.decisions ?? {}))
      if (d === 'incluir' || d === 'excluir') decisions[k] = d;
    return {
      active: v.active === true,
      reviewIncluded: v.reviewIncluded === true,
      decisions,
      updatedAt: typeof v.updatedAt === 'number' ? v.updatedAt : null,
      approval:
        v.approval && typeof v.approval.at === 'number' && typeof v.approval.by === 'string'
          ? v.approval
          : null,
    };
  } catch {
    return emptySettings();
  }
}

export interface PrivacySource {
  sessionPhone: string;
  businessName: string | null;
  /** quien autorizó la migración */
  ownerName?: string | null;
  directory: Directory;
  chats: { jid: string; messages: StoredMessage[] }[] | null;
}

const MAX_TEXT = 280;

/** una fila por contacto importable (con número, sin el propio número) */
export function buildPrivacyRows(src: PrivacySource, settings: PrivacySettings): PrivacyRow[] {
  const byPhone = new Map<string, StoredMessage[]>();
  for (const c of src.chats ?? []) {
    if (isGroupJid(c.jid)) continue;
    const phone = phoneOf(c.jid);
    if (!phone) continue;
    byPhone.set(phone, [...(byPhone.get(phone) ?? []), ...c.messages]);
  }
  const rows: PrivacyRow[] = [];
  for (const p of src.directory.people) {
    if (!p.phone || p.phone === src.sessionPhone) continue;
    const messages = (byPhone.get(p.phone) ?? []).sort((a, b) => a.ts - b.ts);
    const c = classify(p, messages, { businessName: src.businessName, ownerName: src.ownerName });
    let last: StoredMessage | null = null;
    let lastText: string | null = null;
    for (let i = messages.length - 1; i >= 0 && !lastText; i--) {
      lastText = messageText(messages[i]!);
      last = messages[i]!;
    }
    const decision = settings.decisions[p.phone] ?? null;
    rows.push({
      phone: p.phone,
      name: p.displayName ?? p.pushName ?? p.businessName ?? `+${p.phone}`,
      savedName: p.savedName ?? null,
      messages: messages.length || p.messages,
      firstAt: messages[0]?.ts ?? p.firstMessageAt,
      lastAt: messages.at(-1)?.ts ?? p.lastMessageAt,
      lastText: lastText ? lastText.slice(0, MAX_TEXT) : null,
      lastFromMe: last ? last.fromMe : null,
      suggestion: c.category,
      reasons: c.reasons,
      decision,
      include: included(c.category, decision, settings.reviewIncluded),
    });
  }
  return rows.sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0));
}

export function included(
  suggestion: PrivacyCategory,
  decision: PrivacyDecision | null,
  reviewIncluded: boolean,
): boolean {
  if (decision) return decision === 'incluir';
  if (suggestion === 'comercial') return true;
  if (suggestion === 'revisar') return reviewIncluded;
  return false;
}

export function countRows(rows: PrivacyRow[]): PrivacyCounts {
  const c: PrivacyCounts = {
    comercial: 0,
    privado: 0,
    revisar: 0,
    incluidos: 0,
    excluidos: 0,
    manuales: 0,
    mensajesIncluidos: 0,
    conversacionesIncluidas: 0,
  };
  for (const r of rows) {
    c[r.suggestion] += 1;
    if (r.include) {
      c.incluidos += 1;
      c.mensajesIncluidos += r.messages;
      if (r.messages) c.conversacionesIncluidas += 1;
    } else c.excluidos += 1;
    if (r.decision) c.manuales += 1;
  }
  return c;
}

export function privacyState(rows: PrivacyRow[], settings: PrivacySettings): PrivacyState {
  return {
    active: settings.active,
    reviewIncluded: settings.reviewIncluded,
    updatedAt: settings.updatedAt,
    approval: settings.approval,
    counts: countRows(rows),
    rows,
  };
}
