import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Logger } from 'pino';
import { emptyStats, type SessionSummary } from '@wa-bridge/shared';
import type { SessionRecord, SessionStore } from '../store/types.js';
import type { MediaDownloader, SocketFactory } from '../wa/types.js';
import { HttpError } from './errors.js';
import { WaSession } from './wa-session.js';

export interface ManagerEvents {
  update: [SessionSummary];
  deleted: [string];
}

export { HttpError };

export interface SessionManagerOptions {
  store: SessionStore;
  socketFactory: SocketFactory;
  logger: Logger;
  maxSessions: number;
  wipeOnLogout: boolean;
  /** número (solo dígitos) del dueño: solo ese WhatsApp guarda mensajes para "Mi vista" */
  ownerPhone?: string | null;
  /** descarga la media de un mensaje guardado (fotos, audios…) */
  downloadMedia?: MediaDownloader | null;
}

/** Dueño de todas las sesiones vivas del proceso. */
export class SessionManager extends EventEmitter<ManagerEvents> {
  private readonly sessions = new Map<string, WaSession>();

  constructor(private readonly opts: SessionManagerOptions) {
    super();
  }

  /** Carga las sesiones guardadas y reconecta las que tenían un teléfono vinculado. */
  async init(): Promise<void> {
    const records = await this.opts.store.listSessions();
    for (const rec of records) {
      if (!rec.linked && ['starting', 'qr', 'connecting', 'reconnecting'].includes(rec.status)) {
        // un QR de una ejecución anterior ya no sirve
        rec.status = 'qr_expired';
      }
      const session = this.attach(rec);
      if (rec.linked && rec.status !== 'logged_out') {
        this.opts.logger.info({ session: rec.id }, 'reconectando sesión guardada');
        void session
          .start()
          .catch((err) =>
            this.opts.logger.error({ err, session: rec.id }, 'no se pudo reconectar'),
          );
      }
    }
    this.opts.logger.info({ total: records.length }, 'sesiones cargadas');
  }

  list(): SessionSummary[] {
    return [...this.sessions.values()]
      .map((s) => s.summary())
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id: string): WaSession {
    const s = this.sessions.get(id);
    if (!s) throw new HttpError(404, 'not_found', 'Sesión no encontrada');
    return s;
  }

  async create(label?: string | null): Promise<SessionSummary> {
    const active = [...this.sessions.values()].filter((s) => s.isActive).length;
    if (active >= this.opts.maxSessions) {
      throw new HttpError(
        429,
        'too_many_sessions',
        `Máximo ${this.opts.maxSessions} sesiones activas`,
      );
    }
    const now = Date.now();
    const record: SessionRecord = {
      id: randomUUID(),
      label: label?.trim() || null,
      createdAt: now,
      updatedAt: now,
      connectedAt: null,
      status: 'starting',
      linked: false,
      profile: null,
      stats: emptyStats(),
      statsState: null,
      lastError: null,
    };
    // primero el registro (en Postgres las credenciales dependen de él)
    await this.opts.store.saveSession(record);
    const session = this.attach(record);
    await session.start();
    return session.summary();
  }

  /** Pide un QR nuevo o reintenta la conexión. */
  async connect(id: string): Promise<SessionSummary> {
    const session = this.get(id);
    if (session.status === 'connected') return session.summary();
    await session.start();
    return session.summary();
  }

  /** Desvincula el teléfono pero conserva el registro (y sus estadísticas). */
  async logout(id: string): Promise<SessionSummary> {
    const session = this.get(id);
    await session.logout();
    return session.summary();
  }

  /** Desvincula y borra todo rastro de la sesión. */
  async remove(id: string): Promise<void> {
    const session = this.get(id);
    await session.logout();
    session.dispose();
    this.sessions.delete(id);
    await this.opts.store.deleteSession(id);
    this.emit('deleted', id);
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled([...this.sessions.values()].map((s) => s.stop()));
  }

  private attach(record: SessionRecord): WaSession {
    const session = new WaSession(record, {
      store: this.opts.store,
      socketFactory: this.opts.socketFactory,
      logger: this.opts.logger,
      wipeOnLogout: this.opts.wipeOnLogout,
      ownerPhone: this.opts.ownerPhone ?? null,
      downloadMedia: this.opts.downloadMedia ?? null,
    });
    session.on('update', (summary) => this.emit('update', summary));
    this.sessions.set(record.id, session);
    return session;
  }
}
