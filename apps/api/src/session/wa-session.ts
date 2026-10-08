import { EventEmitter } from 'node:events';
import { DisconnectReason, type BaileysEventMap } from 'baileys';
import type { Logger } from 'pino';
import QRCode from 'qrcode';
import type { QrCode, SessionStatus, SessionSummary, WaProfile } from '@wa-bridge/shared';
import type { SessionRecord, SessionStore } from '../store/types.js';
import { loadAuthState, type StoredAuthState } from '../wa/auth-state.js';
import type { SocketFactory, WaSocketLike } from '../wa/types.js';
import { type Directory, normalizeJid, phoneOf, StatsAggregator } from './stats.js';

/** WhatsApp muestra el primer QR ~60 s y los siguientes ~20 s */
const FIRST_QR_TTL_MS = 60_000;
const NEXT_QR_TTL_MS = 20_000;
/** sin lotes de historial por este tiempo → damos el sync por terminado */
const SYNC_IDLE_MS = 90_000;
const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
/** intentos fallidos antes de vincular (sin QR) antes de rendirnos */
const MAX_UNLINKED_ATTEMPTS = 5;
/** errores 500 seguidos antes de considerar la sesión inválida */
const MAX_BAD_SESSION_STREAK = 3;
const EMIT_THROTTLE_MS = 300;
const PERSIST_THROTTLE_MS = 2_000;
/** cada cuánto releemos los mapeos LID → número guardados por Baileys */
const LID_RELOAD_MS = 30_000;

export interface WaSessionDeps {
  store: SessionStore;
  socketFactory: SocketFactory;
  logger: Logger;
  wipeOnLogout: boolean;
}

export interface WaSessionEvents {
  update: [SessionSummary];
}

const QR_COLOR_DARK = '#1A0B2E';

/**
 * Una sesión = un WhatsApp vinculado como dispositivo.
 * Maneja el ciclo QR → conectado → (re)conexión → desvinculación y
 * va agregando estadísticas de lo que llega por History Sync.
 */
export class WaSession extends EventEmitter<WaSessionEvents> {
  readonly id: string;
  private record: SessionRecord;
  private readonly log: Logger;
  private stats: StatsAggregator;

  private sock: WaSocketLike | null = null;
  private auth: StoredAuthState | null = null;
  /** sube con cada socket nuevo; los eventos de sockets viejos se ignoran */
  private generation = 0;
  private qr: QrCode | null = null;
  private qrSequence = 0;
  private attempts = 0;
  private badSessionStreak = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private emitTimer: NodeJS.Timeout | null = null;
  private persistTimer: NodeJS.Timeout | null = null;
  private credsChain: Promise<void> = Promise.resolve();
  private loggingOut = false;
  private stopped = false;
  /** eliminada: no vuelve a escribir nada en el store */
  private disposed = false;

  constructor(
    record: SessionRecord,
    private readonly deps: WaSessionDeps,
  ) {
    super();
    this.id = record.id;
    this.record = record;
    this.log = deps.logger.child({ session: record.id });
    this.stats = new StatsAggregator(record.statsState);
  }

  get status(): SessionStatus {
    return this.record.status;
  }

  get isLinked(): boolean {
    return this.record.linked;
  }

  get isActive(): boolean {
    return ['starting', 'qr', 'connecting', 'connected', 'reconnecting'].includes(
      this.record.status,
    );
  }

  /**
   * Contactos y grupos para exportar (sin contenido de mensajes). Antes suma los
   * pares LID → número que Baileys guardó en sus llaves: son muchos más que los
   * que llegan como eventos y permiten mostrar el celular de quien solo vino por LID.
   */
  async directory(): Promise<Directory> {
    await this.loadStoredLidMappings();
    return this.stats.directory();
  }

  private lidMappingsLoadedAt = 0;

  private async loadStoredLidMappings(): Promise<void> {
    if (Date.now() - this.lidMappingsLoadedAt < LID_RELOAD_MS) return;
    this.lidMappingsLoadedAt = Date.now();
    try {
      const keys = (await this.deps.store.listAuthKeys(this.id, 'lid-mapping:')).filter((k) =>
        k.endsWith('_reverse'),
      );
      const values = await this.deps.store.readAuth(this.id, keys);
      let added = 0;
      for (const [key, json] of values) {
        const lidUser = key.slice('lid-mapping:'.length, -'_reverse'.length);
        const pnUser = JSON.parse(json) as unknown;
        if (!lidUser || typeof pnUser !== 'string' || !/^\d{6,15}$/.test(pnUser)) continue;
        if (this.stats.addLidMapping({ lid: `${lidUser}@lid`, pn: `${pnUser}@s.whatsapp.net` }))
          added += 1;
      }
      if (added) {
        this.log.info({ added, total: keys.length }, 'números recuperados de las llaves LID');
        this.touch();
      }
    } catch (err) {
      this.log.warn({ err }, 'no se pudieron leer los mapeos LID guardados');
    }
  }

  summary(): SessionSummary {
    return {
      id: this.record.id,
      label: this.record.label,
      status: this.record.status,
      createdAt: this.record.createdAt,
      updatedAt: this.record.updatedAt,
      connectedAt: this.record.connectedAt,
      qr: this.record.status === 'qr' ? this.qr : null,
      profile: this.record.profile,
      stats: this.stats.summary(),
      lastError: this.record.lastError,
      readOnly: true,
    };
  }

  // ------------------------------------------------------------------ acciones

  /**
   * Arranca (o retoma) la conexión. Si no hay un teléfono vinculado parte con
   * credenciales nuevas y emite QR.
   */
  async start(): Promise<void> {
    this.stopped = false;
    this.loggingOut = false;
    this.clearReconnect();
    // cerrar el socket anterior ANTES de tocar credenciales, para que no reescriba nada
    this.closeSocket();
    await this.credsChain.catch(() => {});
    if (!this.record.linked) {
      // QR nuevo = credenciales nuevas; nunca reutilizamos un intento anterior
      await this.deps.store.clearAuth(this.id);
      this.qrSequence = 0;
      this.qr = null;
      // puede ser otro teléfono: las estadísticas parten de cero
      this.stats = new StatsAggregator();
      this.record.profile = null;
      this.record.connectedAt = null;
    }
    this.attempts = 0;
    this.setStatus(this.record.linked ? 'connecting' : 'starting', { lastError: null });
    await this.openSocket();
  }

  /** Cierra el socket sin desvincular (apagado del servidor). */
  async stop(): Promise<void> {
    this.stopped = true;
    this.clearReconnect();
    this.clearIdleTimer();
    this.closeSocket();
    await this.credsChain.catch(() => {});
    await this.flush();
  }

  /**
   * Desvincula el dispositivo del teléfono y borra las credenciales.
   * Es lo que hace el botón "Desconectar WhatsApp".
   */
  async logout(): Promise<void> {
    this.loggingOut = true;
    this.stopped = true;
    this.clearReconnect();
    this.clearIdleTimer();
    const sock = this.sock;
    const wasOpen = this.record.status === 'connected';
    const wasLinked = this.record.linked;
    let warning: string | null = null;

    if (sock && wasOpen) {
      try {
        await withTimeout(sock.logout('VentaPlay WA Bridge'), 10_000);
      } catch (err) {
        this.log.warn({ err }, 'logout falló; cierro el socket igual');
        warning = 'No se pudo avisar a WhatsApp. Revisa "Dispositivos vinculados" en el teléfono.';
      }
    } else if (wasLinked) {
      warning =
        'La sesión no estaba conectada. Revisa "Dispositivos vinculados" en el teléfono y elimínala ahí.';
    }
    this.closeSocket();
    await this.credsChain.catch(() => {});
    await this.deps.store.clearAuth(this.id);
    this.qr = null;
    this.record.linked = false;
    this.setStatus('logged_out', { lastError: warning });
    await this.flush();
  }

  // ------------------------------------------------------------------ socket

  private async openSocket(): Promise<void> {
    const gen = ++this.generation;
    this.closeSocket(false);
    try {
      // tras escanear, WhatsApp manda creds.update y enseguida pide reiniciar (515):
      // hay que esperar a que esas credenciales estén guardadas antes de releerlas
      await this.credsChain.catch(() => {});
      if (gen !== this.generation || this.stopped) return;
      this.auth = await loadAuthState(this.deps.store, this.id);
      const sock = await this.deps.socketFactory({
        sessionId: this.id,
        auth: this.auth,
        logger: this.log,
      });
      if (gen !== this.generation || this.stopped) {
        sock.end(undefined);
        return;
      }
      this.sock = sock;
      this.bind(sock, gen);
    } catch (err) {
      this.log.error({ err }, 'no se pudo crear el socket');
      this.scheduleReconnect(`No se pudo iniciar la conexión: ${errorMessage(err)}`);
    }
  }

  private closeSocket(bump = true): void {
    if (bump) this.generation++;
    const sock = this.sock;
    this.sock = null;
    if (!sock) return;
    // solo end(): borrar listeners rompería la limpieza interna de Baileys;
    // los eventos de este socket viejo se ignoran por la generación
    try {
      sock.end(undefined);
    } catch {
      /* noop */
    }
  }

  private bind(sock: WaSocketLike, gen: number): void {
    const on = <K extends keyof BaileysEventMap>(event: K, fn: (arg: BaileysEventMap[K]) => void) =>
      sock.ev.on(event, (arg) => {
        if (gen !== this.generation) return;
        try {
          fn(arg);
        } catch (err) {
          this.log.error({ err, event }, 'error procesando evento');
        }
      });

    on('connection.update', (u) => void this.onConnectionUpdate(u, sock));

    on('creds.update', () => {
      const auth = this.auth;
      if (!auth) return;
      this.credsChain = this.credsChain
        .then(() => auth.saveCreds())
        .catch((err) => this.log.error({ err }, 'no se pudieron guardar credenciales'));
      const linked = auth.isLinked();
      if (linked !== this.record.linked) {
        this.record.linked = linked;
        this.touch(true);
      }
    });

    on('messaging-history.set', (h) => {
      this.stats.addHistoryBatch({
        chats: h.chats,
        contacts: h.contacts,
        messages: h.messages,
        lidPnMappings: h.lidPnMappings ?? null,
        progress: h.progress ?? null,
        syncType: h.syncType ?? null,
        isLatest: h.isLatest ?? null,
      });
      this.log.info(
        {
          chats: h.chats.length,
          contacts: h.contacts.length,
          messages: h.messages.length,
          progress: h.progress,
          syncType: h.syncType,
        },
        'lote de historial',
      );
      this.armIdleTimer();
      this.touch();
    });

    on('messaging-history.status', (s) => {
      this.stats.markSyncStatus(s.syncType, s.status);
      this.touch();
    });

    on('contacts.upsert', (c) => {
      this.stats.addContacts(c);
      this.touch();
    });
    on('contacts.update', (c) => {
      this.stats.addContacts(c);
      this.touch();
    });
    on('chats.upsert', (c) => {
      this.stats.addChats(c);
      this.touch();
    });
    on('messages.upsert', ({ messages }) => {
      this.stats.addMessages(messages);
      this.touch();
    });
    on('lid-mapping.update', (m) => {
      this.stats.addLidMapping(m);
      this.touch();
    });
  }

  private async onConnectionUpdate(
    u: BaileysEventMap['connection.update'],
    sock: WaSocketLike,
  ): Promise<void> {
    if (u.qr) {
      // la secuencia se fija ANTES del await: si llega otro QR mientras se dibuja este,
      // el viejo se descarta y nunca pisa al nuevo
      const sequence = ++this.qrSequence;
      const gen = this.generation;
      const expiresAt = Date.now() + (sequence === 1 ? FIRST_QR_TTL_MS : NEXT_QR_TTL_MS);
      const dataUrl = await QRCode.toDataURL(u.qr, {
        errorCorrectionLevel: 'H', // tolera el logo de VentaPlay al centro
        margin: 1,
        width: 512,
        color: { dark: QR_COLOR_DARK, light: '#FFFFFF' },
      });
      if (sequence !== this.qrSequence || gen !== this.generation || this.record.linked) return;
      this.qr = { dataUrl, expiresAt, sequence };
      this.attempts = 0;
      this.setStatus('qr', { lastError: null });
      return;
    }

    if (u.isNewLogin) {
      // el teléfono escaneó el QR; WhatsApp va a pedir reiniciar el socket (515)
      this.qr = null;
      this.setStatus('connecting');
    }

    if (u.connection === 'open') {
      this.attempts = 0;
      this.badSessionStreak = 0;
      this.qr = null;
      this.record.linked = true;
      this.record.connectedAt = Date.now();
      this.setStatus('connected', { lastError: null });
      void this.loadProfile(sock, this.generation);
      this.armIdleTimer();
      return;
    }

    if (u.connection === 'close') {
      const code = (u.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)
        ?.output?.statusCode;
      this.handleClose(code, u.lastDisconnect?.error);
    }
  }

  private handleClose(code: number | undefined, error: unknown): void {
    this.sock = null;
    if (this.loggingOut || this.stopped) return;
    this.log.info({ code, err: errorMessage(error) }, 'conexión cerrada');

    switch (code) {
      case DisconnectReason.loggedOut: {
        // desvinculado desde el teléfono (o WhatsApp invalidó la sesión)
        void this.onRemoteLogout();
        return;
      }
      case DisconnectReason.restartRequired: {
        // normal justo después de escanear el QR
        this.setStatus('connecting');
        void this.openSocket();
        return;
      }
      case DisconnectReason.connectionReplaced: {
        this.setStatus('error', {
          lastError: 'Otra instancia abrió esta misma sesión. Detén la otra y vuelve a conectar.',
        });
        return;
      }
      case DisconnectReason.forbidden: {
        this.setStatus('error', { lastError: 'WhatsApp rechazó la conexión (403).' });
        return;
      }
      case DisconnectReason.multideviceMismatch: {
        void this.onRemoteLogout('La sesión quedó inválida. Vuelve a vincular con un QR nuevo.');
        return;
      }
      case DisconnectReason.badSession: {
        // Baileys usa 500 para cualquier error de stream desconocido: casi siempre es transitorio.
        // Solo si se repite varias veces seguidas la damos por inválida.
        this.badSessionStreak += 1;
        if (this.record.linked && this.badSessionStreak >= MAX_BAD_SESSION_STREAK) {
          void this.onRemoteLogout(
            'WhatsApp rechazó la sesión varias veces. Vuelve a vincular con un QR nuevo.',
          );
          return;
        }
        break;
      }
      default:
        break;
    }

    // 408 sin vincular = el QR expiró sin ser escaneado
    if (!this.record.linked && this.record.status === 'qr' && code === DisconnectReason.timedOut) {
      this.qr = null;
      this.setStatus('qr_expired', { lastError: null });
      return;
    }

    this.scheduleReconnect(`Conexión perdida (${code ?? 'sin código'}): ${errorMessage(error)}`);
  }

  private async onRemoteLogout(
    message = 'El dispositivo fue desvinculado desde el teléfono.',
  ): Promise<void> {
    this.clearIdleTimer();
    this.qr = null;
    this.record.linked = false;
    if (this.deps.wipeOnLogout) {
      await this.credsChain.catch(() => {});
      await this.deps.store
        .clearAuth(this.id)
        .catch((err) => this.log.error({ err }, 'clearAuth falló'));
    }
    this.setStatus('logged_out', { lastError: message });
  }

  private scheduleReconnect(reason: string): void {
    if (this.stopped) return;
    this.clearReconnect();
    this.attempts += 1;
    if (!this.record.linked && this.attempts > MAX_UNLINKED_ATTEMPTS) {
      this.setStatus('error', { lastError: `No se pudo conectar con WhatsApp. ${reason}` });
      return;
    }
    const delay =
      RECONNECT_DELAYS_MS[Math.min(this.attempts - 1, RECONNECT_DELAYS_MS.length - 1)] ?? 30_000;
    this.setStatus(this.record.linked ? 'reconnecting' : 'starting', { lastError: reason });
    this.log.info({ delay, attempt: this.attempts }, 'reintentando conexión');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.openSocket();
    }, delay);
  }

  private async loadProfile(sock: WaSocketLike, gen: number): Promise<void> {
    const stale = () => gen !== this.generation || this.stopped || this.disposed;
    const user = sock.user;
    if (!user?.id) return;
    const jid = normalizeJid(user.id);
    const platform = this.auth?.state.creds.platform ?? null;
    const profile: WaProfile = {
      jid,
      lid: user.lid ? normalizeJid(user.lid) : null,
      phone: phoneOf(jid) ?? jid.split('@')[0] ?? '',
      name: user.name ?? user.notify ?? this.auth?.state.creds.me?.name ?? null,
      pictureUrl: this.record.profile?.pictureUrl ?? null,
      isBusiness: Boolean(platform?.startsWith('smb')),
      business: this.record.profile?.business ?? null,
      platform,
    };
    this.record.profile = profile;
    this.touch(true);

    const [picture, business] = await Promise.allSettled([
      withTimeout(sock.profilePictureUrl(jid, 'image'), 8_000),
      withTimeout(sock.getBusinessProfile(jid), 8_000),
    ]);
    // pudo haberse desconectado o eliminado mientras esperábamos
    if (stale()) return;
    if (picture.status === 'fulfilled') profile.pictureUrl = picture.value ?? null;
    if (business.status === 'fulfilled' && business.value) {
      const b = business.value;
      profile.isBusiness = true;
      profile.business = {
        description: b.description ?? null,
        category: b.category ?? null,
        email: b.email ?? null,
        website: b.website ?? null,
        address: b.address ?? null,
      };
    }
    this.record.profile = { ...profile };
    this.touch(true);
  }

  // ------------------------------------------------------------------ estado

  private setStatus(
    status: SessionStatus,
    patch: Partial<Pick<SessionRecord, 'lastError'>> = {},
  ): void {
    const changed =
      this.record.status !== status ||
      ('lastError' in patch && patch.lastError !== this.record.lastError);
    this.record.status = status;
    if ('lastError' in patch) this.record.lastError = patch.lastError ?? null;
    if (status !== 'connected') this.clearIdleTimer();
    if (changed || status === 'qr') this.touch(true);
  }

  /** marca cambios: emite a la UI (throttled) y persiste (throttled) */
  private touch(immediate = false): void {
    this.record.updatedAt = Date.now();
    if (immediate) {
      if (this.emitTimer) clearTimeout(this.emitTimer);
      this.emitTimer = null;
      this.emit('update', this.summary());
    } else if (!this.emitTimer) {
      this.emitTimer = setTimeout(() => {
        this.emitTimer = null;
        this.emit('update', this.summary());
      }, EMIT_THROTTLE_MS);
    }
    if (!this.persistTimer) {
      this.persistTimer = setTimeout(
        () => {
          this.persistTimer = null;
          void this.persist();
        },
        immediate ? 50 : PERSIST_THROTTLE_MS,
      );
    }
  }

  private async persist(): Promise<void> {
    if (this.disposed) return;
    this.record.stats = this.stats.summary();
    this.record.statsState = this.stats.snapshot();
    try {
      await this.deps.store.saveSession(this.record);
    } catch (err) {
      this.log.error({ err }, 'no se pudo guardar la sesión');
    }
  }

  /** la sesión se eliminó: corta timers y bloquea escrituras futuras */
  dispose(): void {
    this.disposed = true;
    this.stopped = true;
    this.clearReconnect();
    this.clearIdleTimer();
    if (this.persistTimer) clearTimeout(this.persistTimer);
    if (this.emitTimer) clearTimeout(this.emitTimer);
    this.persistTimer = null;
    this.emitTimer = null;
    this.removeAllListeners();
  }

  /** guarda ya, cancelando lo pendiente */
  async flush(): Promise<void> {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = null;
    if (this.emitTimer) clearTimeout(this.emitTimer);
    this.emitTimer = null;
    await this.persist();
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setInterval(() => {
      if (this.stats.inferCompletionIfIdle(SYNC_IDLE_MS)) {
        this.log.info('sin lotes nuevos: historial dado por completo');
        this.touch(true);
        this.clearIdleTimer();
      }
    }, 15_000);
    this.idleTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = null;
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }
}

function errorMessage(err: unknown): string {
  if (!err) return 'desconocido';
  if (err instanceof Error) return err.message;
  return String(err);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout ${ms} ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
