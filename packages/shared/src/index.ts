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

export type SyncState = 'waiting' | 'running' | 'complete';

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
  /** siempre true: este servicio nunca envía mensajes */
  readOnly: true;
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
