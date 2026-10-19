import type { AssistantSettings, SessionStatus, SyncStats, WaProfile } from '@wa-bridge/shared';
import type { StatsSnapshot } from '../session/stats.js';

/** Lo que persistimos de cada sesión (siempre cifrado en reposo). */
export interface SessionRecord {
  id: string;
  label: string | null;
  createdAt: number;
  updatedAt: number;
  connectedAt: number | null;
  /** último estado conocido; al arrancar se usa para decidir si reconectar */
  status: SessionStatus;
  /** true si hay credenciales de WhatsApp vinculadas guardadas */
  linked: boolean;
  profile: WaProfile | null;
  stats: SyncStats;
  /** estado interno del agregador de estadísticas, para seguir contando tras un reinicio */
  statsState: StatsSnapshot | null;
  lastError: string | null;
  /** modo asistente (ausente en registros antiguos = respaldo, salvo OWNER_PHONE heredado) */
  assistant?: AssistantSettings | null;
}

/**
 * Almacenamiento de sesiones y credenciales de WhatsApp.
 * Las implementaciones reciben y devuelven texto plano (JSON) y cifran por dentro.
 */
export interface SessionStore {
  readonly kind: 'file' | 'postgres';
  init(): Promise<void>;
  close(): Promise<void>;

  listSessions(): Promise<SessionRecord[]>;
  getSession(id: string): Promise<SessionRecord | null>;
  saveSession(record: SessionRecord): Promise<void>;
  /** borra la sesión y todas sus credenciales */
  deleteSession(id: string): Promise<void>;

  /** credenciales / llaves Signal de una sesión (clave → JSON) */
  readAuth(sessionId: string, keys: string[]): Promise<Map<string, string>>;
  /** `null` borra la clave */
  writeAuth(sessionId: string, entries: Record<string, string | null>): Promise<void>;
  clearAuth(sessionId: string): Promise<void>;
  /** claves guardadas que empiezan con `prefix` (sin sus valores) */
  listAuthKeys(sessionId: string, prefix: string): Promise<string[]>;
}
