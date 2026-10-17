/**
 * Tipos compartidos entre la API y la web del WA Bridge.
 * La API emite siempre un `SessionSummary` completo; la web solo lo pinta.
 */

/** Estado de la conexión de una sesión de WhatsApp. */
export type SessionStatus =
  /** creando el socket */
  | 'starting'
  /** QR visible, esperando que lo escaneen */
  | 'qr'
  /** QR escaneado o reconectando credenciales ya vinculadas */
  | 'connecting'
  /** conectado (la sincronización del historial puede seguir corriendo) */
  | 'connected'
  /** se cayó la conexión y se reintenta solo */
  | 'reconnecting'
  /** el QR expiró sin ser escaneado; hay que pedir uno nuevo */
  | 'qr_expired'
  /** desvinculado (desde la UI o desde el teléfono) */
  | 'logged_out'
  /** error irrecuperable */
  | 'error';

export const ACTIVE_STATUSES: readonly SessionStatus[] = [
  'starting',
  'qr',
  'connecting',
  'connected',
  'reconnecting',
];

export interface QrCode {
  /** imagen PNG del QR como data URL, lista para un <img> */
  dataUrl: string;
  /** epoch ms en que WhatsApp rota el QR */
  expiresAt: number;
  /** número de QR emitido en este intento (WhatsApp emite ~6 antes de expirar) */
  sequence: number;
}

export interface BusinessInfo {
  description?: string | null;
  category?: string | null;
  email?: string | null;
  website?: string[] | null;
  address?: string | null;
}

export interface WaProfile {
  /** JID de la cuenta, p.ej. 56912345678@s.whatsapp.net */
  jid: string;
  /** LID de la cuenta, si WhatsApp lo entregó */
  lid?: string | null;
  /** número en formato E.164 sin '+', p.ej. 56912345678 */
  phone: string;
  /** nombre público (push name) */
  name?: string | null;
  pictureUrl?: string | null;
  isBusiness: boolean;
  business?: BusinessInfo | null;
  /** plataforma del teléfono reportada por WhatsApp (android, iphone, smba, smbi…) */
  platform?: string | null;
}

/**
 * waiting: aún no llega nada · running: llegando lotes · paused: el teléfono dejó de
 * enviar antes de terminar (suele seguir cuando se abre WhatsApp en el teléfono) ·
 * complete: terminó.
 */
export type SyncState = 'waiting' | 'running' | 'paused' | 'complete';

export interface TopChat {
  jid: string;
  name: string | null;
  /** número si es un chat individual y lo conocemos */
  phone: string | null;
  isGroup: boolean;
  messages: number;
  lastMessageAt: number | null;
}

export interface SyncStats {
  state: SyncState;
  /** 0–100 según WhatsApp; null si no lo informa */
  progress: number | null;
  /** avance de los mensajes recientes (RECENT), 0–100; null si no empezó */
  recentProgress?: number | null;
  /** avance del historial completo (FULL), 0–100; null si no empezó */
  fullProgress?: number | null;
  /** lotes de History Sync recibidos */
  batches: number;
  lastBatchAt: number | null;
  /** el estado 'complete' se dedujo por inactividad y no porque WhatsApp lo confirmara */
  completionInferred: boolean;
  contacts: number;
  chats: number;
  individualChats: number;
  groups: number;
  messages: number;
  /** epoch ms del mensaje más antiguo / más nuevo visto */
  oldestMessageAt: number | null;
  newestMessageAt: number | null;
  /** mapeos LID → número conocidos */
  lidMappings: number;
  topChats: TopChat[];
}

export interface SessionSummary {
  id: string;
  /** etiqueta libre, p.ej. el nombre del cliente */
  label: string | null;
  status: SessionStatus;
  createdAt: number;
  updatedAt: number;
  connectedAt: number | null;
  qr: QrCode | null;
  profile: WaProfile | null;
  stats: SyncStats;
  lastError: string | null;
  /**
   * Solo si el WhatsApp vinculado es el del dueño (OWNER_PHONE): cuántos chats y
   * mensajes hay guardados para "Mi vista". null para cualquier otro número.
   */
  personal: PersonalVaultInfo | null;
  /** siempre true: este servicio nunca envía mensajes */
  readOnly: true;
}

// ------------------------------------------------------------- Mi vista (solo el dueño)

export interface PersonalVaultInfo {
  /** chats con actividad dentro de la ventana */
  chats: number;
  /** mensajes guardados en esos chats */
  messages: number;
  /** ventana de días que se muestra */
  windowDays: number;
  /** máximo de mensajes que muestra Mi vista por chat */
  perChat: number;
  /** días y mensajes por chat que se guardan (para búsquedas y el asistente) */
  storeDays?: number;
  storePerChat?: number;
  /** el dueño habilitó el envío (ALLOW_SEND): solo con confirmación y con límites */
  sendEnabled?: boolean;
}

export type MessageKind =
  | 'text'
  | 'image'
  | 'video'
  | 'gif'
  | 'audio'
  | 'voice'
  | 'sticker'
  | 'document'
  | 'location'
  | 'contact'
  | 'poll'
  | 'deleted'
  | 'other';

export interface ChatMedia {
  mimetype: string | null;
  fileName?: string | null;
  /** duración de audios y videos */
  seconds?: number | null;
  width?: number | null;
  height?: number | null;
  /** bytes */
  size?: number | null;
}

export interface ChatMessage {
  id: string;
  fromMe: boolean;
  /** epoch ms */
  timestamp: number;
  kind: MessageKind;
  /** texto del mensaje o pie de foto */
  text: string | null;
  /** autor (en grupos) */
  senderJid: string | null;
  senderName: string | null;
  senderPhone: string | null;
  media: ChatMedia | null;
  /** coordenadas, si es una ubicación */
  location?: { lat: number; lng: number; name?: string | null } | null;
  edited?: boolean;
}

export interface PersonalChat {
  jid: string;
  name: string;
  phone: string | null;
  isGroup: boolean;
  /** chat contigo mismo */
  isSelf: boolean;
  lastMessageAt: number;
  preview: string | null;
  previewKind: MessageKind;
  previewFromMe: boolean;
  previewSender: string | null;
  /** mensajes guardados del chat (máx. storePerChat) */
  stored: number;
}

export interface PersonalChatList extends PersonalVaultInfo {
  items: PersonalChat[];
  individual: number;
  groups: number;
}

export interface PersonalChatMessages {
  chat: PersonalChat;
  messages: ChatMessage[];
  /** hay mensajes guardados más antiguos que los devueltos */
  hasMore: boolean;
}

export interface SearchHit {
  chat: Pick<PersonalChat, 'jid' | 'name' | 'isGroup' | 'phone'>;
  message: ChatMessage;
}

export interface SearchResult {
  query: string;
  days: number;
  total: number;
  hits: SearchHit[];
}

export interface SendResult {
  chat: Pick<PersonalChat, 'jid' | 'name' | 'isGroup' | 'phone'>;
  message: ChatMessage;
  /** envíos que quedan en la hora / el día */
  remaining: { hour: number; day: number };
}

export interface CreateSessionBody {
  label?: string | null;
}

export interface ApiError {
  error: string;
  message: string;
}

/** Evento SSE emitido por GET /sessions/:id/events */
export type SessionStreamEvent =
  { type: 'snapshot'; session: SessionSummary } | { type: 'deleted'; id: string };

export const emptyStats = (): SyncStats => ({
  state: 'waiting',
  progress: null,
  batches: 0,
  lastBatchAt: null,
  completionInferred: false,
  contacts: 0,
  chats: 0,
  individualChats: 0,
  groups: 0,
  messages: 0,
  oldestMessageAt: null,
  newestMessageAt: null,
  lidMappings: 0,
  topChats: [],
});

// ------------------------------------------------------------------ proyectos (grupos aislados)

/**
 * Un chat "aislado" del dueño: se guarda TODO (sin tope ni ventana), con cada metadato
 * y la media descargada, para analizarlo después.
 */
export interface ProjectInfo {
  jid: string;
  name: string;
  isGroup: boolean;
  /** cuándo se aisló (epoch ms) */
  since: number;
  messages: number;
  participants: number;
  first: number | null;
  last: number | null;
  /** cuántos mensajes por tipo */
  kinds: Partial<Record<MessageKind, number>>;
  media: { total: number; downloaded: number; failed: number; bytes: number };
  /** carpeta del equipo donde se exporta (JSONL, Excel y archivos) */
  exportDir: string | null;
  exportedAt: number | null;
}

/**
 * "Traer toda la conversación": le pide al teléfono del dueño el historial antiguo de
 * un chat por tramos (History Sync a pedido) y lo guarda completo en su proyecto.
 */
export interface HistoryFetchStatus {
  jid: string;
  state: 'idle' | 'running' | 'done' | 'error';
  /** tramos que ya respondió el teléfono */
  pages: number;
  /** mensajes nuevos que llegaron (más antiguos que lo que ya había) */
  added: number;
  /** total guardado del chat */
  total: number;
  /** mensaje más antiguo guardado (epoch ms) */
  oldest: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  /** por qué terminó: 'complete' (no hay más), 'limit' (tope de tramos), 'timeout' (el teléfono no respondió) */
  reason: 'complete' | 'limit' | 'timeout' | null;
  error: string | null;
}

export interface ProjectPerson {
  jid: string | null;
  lid: string | null;
  phone: string | null;
  /** nombre de la agenda o, si no hay, el que la persona usa en WhatsApp */
  name: string | null;
  pushName: string | null;
}

/** Un mensaje del archivo con todos sus datos y metadatos. */
export interface ArchivedMessage {
  id: string;
  chatJid: string;
  /** epoch ms (UTC) */
  timestamp: number;
  fromMe: boolean;
  sender: ProjectPerson;
  /** tipo de mensaje de WhatsApp tal cual (imageMessage, extendedTextMessage, …) */
  type: string | null;
  kind: MessageKind;
  /** texto o pie de foto/documento */
  text: string | null;
  quoted: { id: string; participant: string | null; text: string | null } | null;
  mentions: string[];
  forwarded: boolean;
  forwardingScore: number | null;
  /** mensaje temporal: segundos de expiración */
  ephemeralSeconds: number | null;
  media:
    | (ChatMedia & {
        sha256: string | null;
        pageCount: number | null;
        /** se bajó y se guardó cifrado en el equipo */
        downloaded: boolean;
        /** el hash del archivo bajado coincide con el de WhatsApp */
        verified: boolean | null;
        downloadedAt: number | null;
        error: string | null;
      })
    | null;
  location: { lat: number; lng: number; name?: string | null } | null;
  /** versiones anteriores del texto (la última edición queda en `text`) */
  edits: { timestamp: number; previousText: string | null }[];
  deleted: { timestamp: number } | null;
  /** última reacción de cada persona */
  reactions: { sender: string; emoji: string; timestamp: number }[];
  /** recibos de entrega/lectura (solo de tus mensajes) */
  receipts: { jid: string; delivered: number | null; read: number | null; played: number | null }[];
  /** de dónde salió: historial al vincular, en vivo, enviado desde aquí o la bóveda previa */
  source: 'history' | 'live' | 'sent' | 'vault';
  capturedAt: number;
  updatedAt: number;
  /** mensaje original de WhatsApp (JSON) — solo si se pide con ?raw=1 */
  raw?: unknown;
}

export interface ProjectMessages {
  project: ProjectInfo;
  messages: ArchivedMessage[];
  hasMore: boolean;
}
