import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Semaphore } from 'async-mutex';
import { BufferJSON, DisconnectReason, type BaileysEventMap } from 'baileys';
import type { Logger } from 'pino';
import QRCode from 'qrcode';
import type {
  ChatMessage,
  SearchHit,
  SearchResult,
  SendResult,
  GroupCreateResult,
  PersonalChat,
  PersonalChatList,
  PersonalChatMessages,
  PersonalVaultInfo,
  QrCode,
  SessionStatus,
  SessionSummary,
  WaProfile,
  ArchivedMessage,
  ProjectInfo,
  ProjectMessages,
  HistoryFetchStatus,
  AssistantRequest,
  AssistantSettings,
  ProjectMetrics,
} from '@wa-bridge/shared';
import { projectSlug, writeProjectExport } from '../export/project-export.js';
import { computeProjectMetrics } from './project-metrics.js';
import type { SessionRecord, SessionStore } from '../store/types.js';
import { loadAuthState, type StoredAuthState } from '../wa/auth-state.js';
import {
  type CreatedGroup,
  type HistoryAnchor,
  type MediaDownloader,
  type OutgoingMedia,
  type SocketFactory,
  SYNC_ON_DEMAND,
  type WaSocketLike,
} from '../wa/types.js';
import {
  ARCHIVE_PREFIX,
  type ArchiveRecord,
  ChatArchive,
  MEDIA_KEY,
  parseRaw,
} from './chat-archive.js';
import { HttpError } from './errors.js';
import {
  MessageVault,
  type StoredMessage,
  unwrapMessage,
  VAULT_KEY_PREFIX,
  VAULT_PER_CHAT,
  VAULT_WINDOW_DAYS,
  VIEW_PER_CHAT,
  VIEW_WINDOW_DAYS,
  VIEW_WINDOW_MS,
} from './message-vault.js';
import { SendLimiter } from './send-limiter.js';
import { type Transcriber, UnsupportedAudioError } from '../transcribe/transcriber.js';
import { type Directory, isGroupJid, normalizeJid, phoneOf, StatsAggregator } from './stats.js';

/** WhatsApp muestra el primer QR ~60 s y los siguientes ~20 s */
const FIRST_QR_TTL_MS = 60_000;
const NEXT_QR_TTL_MS = 20_000;
/** sin lotes de historial por este tiempo → damos el sync por terminado */
/** sin lotes por este tiempo, el sync se muestra "en pausa" */
const SYNC_PAUSE_MS = 120_000;
/** si el historial completo nunca empezó, tras este tiempo lo damos por terminado */
const SYNC_GIVE_UP_MS = 15 * 60_000;
const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
/** intentos fallidos antes de vincular (sin QR) antes de rendirnos */
const MAX_UNLINKED_ATTEMPTS = 5;
/** errores 500 seguidos antes de considerar la sesión inválida */
const MAX_BAD_SESSION_STREAK = 3;
const EMIT_THROTTLE_MS = 300;
const PERSIST_THROTTLE_MS = 2_000;
/** cada cuánto releemos los mapeos LID → número guardados por Baileys */
const LID_RELOAD_MS = 30_000;
/** cada cuánto guardamos los mensajes nuevos de "Mi vista" */
const VAULT_PERSIST_MS = 3_000;
/** "Traer toda la conversación": mensajes por tramo, tope de tramos y espera por tramo */
export const HISTORY_PAGE = 50;
export const HISTORY_MAX_PAGES = 60;
export const HISTORY_WAIT_MS = 40_000;
/** media descargada que mantenemos en memoria */
const MEDIA_CACHE_BYTES = 64 * 1024 * 1024;

export interface WaSessionDeps {
  store: SessionStore;
  socketFactory: SocketFactory;
  logger: Logger;
  wipeOnLogout: boolean;
  /** número (solo dígitos) del dueño; solo ese WhatsApp guarda mensajes */
  ownerPhone?: string | null;
  downloadMedia?: MediaDownloader | null;
  /** el dueño permite enviar mensajes desde su número (con límites) */
  allowSend?: boolean;
  /** carpeta donde se exportan los proyectos (chats aislados); null = no se exporta */
  exportDir?: string | null;
  /** transcribe notas de voz en el equipo (Whisper local); null = apagado */
  transcriber?: Transcriber | null;
  /** transcribe solas las notas de voz que lleguen en vivo */
  autoTranscribe?: boolean;
}

/** prefijo de las transcripciones guardadas (cifradas, junto a la bóveda) */
export const TRANSCRIPT_PREFIX = 'transcript:';

export interface StoredTranscript {
  chatJid: string;
  text: string;
  model: string;
  seconds: number;
  at: number;
}

export interface TranscriptResult extends StoredTranscript {
  messageId: string;
  cached: boolean;
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
  /** últimos mensajes por chat, solo si es el WhatsApp del dueño ("Mi vista") */
  private vault = new MessageVault((v) => JSON.stringify(v, BufferJSON.replacer));
  private vaultTimer: NodeJS.Timeout | null = null;
  private vaultLoaded = false;
  private mediaCache = new Map<string, { buffer: Buffer; mimetype: string; thumbnail: boolean }>();
  private mediaCacheBytes = 0;
  private sendLimiter = new SendLimiter();
  /** grupos creados en las últimas 24 h (freno aparte de los mensajes) */
  private groupsCreated: number[] = [];
  /** chats aislados ("proyectos"): todo lo que llega, sin tope, con metadatos y media */
  private archive = new ChatArchive((v) => JSON.stringify(v, BufferJSON.replacer));
  private mediaRunning = false;
  private exportTimer: NodeJS.Timeout | null = null;
  private exporting: Promise<unknown> = Promise.resolve();
  /** "Traer toda la conversación" en curso o terminado, por chat */
  /** transcripciones de notas de voz, por id de mensaje */
  private transcripts = new Map<string, StoredTranscript>();
  private transcriptsDirty = new Set<string>();
  private transcribing = new Map<string, Promise<TranscriptResult>>();
  private backfills = new Map<
    string,
    HistoryFetchStatus & { timer: NodeJS.Timeout | null; asked: number | null }
  >();

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

  /** hay un teléfono vinculado (credenciales guardadas) */
  get linked(): boolean {
    return this.record.linked;
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
      personal: this.personalInfo(),
      assistant: this.assistantSettings(),
      readOnly: true,
    };
  }

  // ------------------------------------------------------------------ Mi vista

  /**
   * ¿Es el WhatsApp del dueño? 'unknown' mientras no sabemos qué número se vinculó
   * (justo después de escanear): ahí guardamos en memoria pero no en disco.
   */
  private ownerState(): 'yes' | 'no' | 'unknown' {
    const a = this.record.assistant;
    if (a) return a.enabled ? 'yes' : 'no';
    // heredado: OWNER_PHONE en el .env (instalaciones anteriores al modo asistente)
    const owner = this.deps.ownerPhone?.replace(/\D/g, '');
    if (!owner) return 'no';
    const me = this.auth?.state.creds.me?.id ?? this.record.profile?.jid ?? null;
    if (!me) return 'unknown';
    const phone = (me.split('@')[0] ?? '').split(':')[0] ?? '';
    if (phone !== owner) return 'no';
    this.adoptLegacyOwner();
    return 'yes';
  }

  /** OWNER_PHONE del .env coincide: lo pasamos a modo asistente guardado en la sesión */
  private adoptLegacyOwner(): void {
    if (this.record.assistant) return;
    this.record.assistant = {
      enabled: true,
      send: Boolean(this.deps.allowSend),
      transcribe: Boolean(this.deps.transcriber),
      autoTranscribe: Boolean(this.deps.autoTranscribe),
      activatedAt: Date.now(),
      awaitingLink: false,
    };
    this.log.info('OWNER_PHONE heredado: la sesión queda en modo asistente');
    this.touch();
  }

  // ------------------------------------------------------------ modo asistente

  /** ajustes del asistente; null = respaldo */
  assistantSettings(): AssistantSettings | null {
    if (this.ownerState() === 'yes') return { ...this.record.assistant! };
    return null;
  }

  /** ¿esta sesión es (o va a ser, al escanear) la asistente? */
  get isAssistant(): boolean {
    return this.ownerState() === 'yes';
  }

  /** activa el modo asistente (el historial llega al escanear un QR nuevo) */
  enableAssistant(opts: Omit<AssistantRequest, 'enabled'>, awaitingLink: boolean): void {
    const prev = this.record.assistant?.enabled ? this.record.assistant : null;
    this.record.assistant = {
      enabled: true,
      send: opts.send ?? prev?.send ?? false,
      transcribe: opts.transcribe ?? prev?.transcribe ?? true,
      autoTranscribe: opts.autoTranscribe ?? prev?.autoTranscribe ?? true,
      activatedAt: prev?.activatedAt ?? Date.now(),
      awaitingLink: prev ? prev.awaitingLink : awaitingLink,
    };
    this.vaultLoaded = false;
    this.touch(true);
  }

  /** vuelve a respaldo: borra mensajes, transcripciones y proyectos guardados */
  async disableAssistant(): Promise<void> {
    const prev = this.record.assistant;
    this.record.assistant = {
      enabled: false,
      send: false,
      transcribe: prev?.transcribe ?? true,
      autoTranscribe: prev?.autoTranscribe ?? true,
      activatedAt: null,
      awaitingLink: false,
    };
    this.stopBackfills();
    this.resetVault();
    this.mediaCache.clear();
    this.mediaCacheBytes = 0;
    const keys = (
      await Promise.all(
        [VAULT_KEY_PREFIX, ARCHIVE_PREFIX, TRANSCRIPT_PREFIX].map((p) =>
          this.deps.store.listAuthKeys(this.id, p),
        ),
      )
    ).flat();
    if (keys.length)
      await this.deps.store.writeAuth(this.id, Object.fromEntries(keys.map((k) => [k, null])));
    this.log.info(
      { borradas: keys.length },
      'modo asistente desactivado: datos personales borrados',
    );
    this.touch(true);
  }

  /** guarda ya el registro (tras cambiar el modo asistente) */
  async saveNow(): Promise<void> {
    await this.persist();
  }

  private personalInfo(): PersonalVaultInfo | null {
    // desvinculado: los mensajes se borraron junto con las credenciales
    if (!this.record.linked || this.ownerState() !== 'yes') return null;
    const view = this.vault.counts(Date.now(), VIEW_WINDOW_MS);
    return {
      chats: view.chats,
      messages: this.vault.counts().messages,
      windowDays: VIEW_WINDOW_DAYS,
      perChat: VIEW_PER_CHAT,
      storeDays: VAULT_WINDOW_DAYS,
      storePerChat: VAULT_PER_CHAT,
      sendEnabled: this.canSend(),
      transcribeEnabled: this.canTranscribe(),
    };
  }

  private canSend(): boolean {
    return this.ownerState() === 'yes' && Boolean(this.record.assistant?.send);
  }

  private canTranscribe(): boolean {
    return (
      this.ownerState() === 'yes' &&
      Boolean(this.deps.transcriber) &&
      this.record.assistant?.transcribe !== false
    );
  }

  private requireOwner(): void {
    if (this.ownerState() !== 'yes')
      throw new HttpError(
        403,
        'not_owner',
        '"Mi vista" solo está disponible con el modo asistente activado',
      );
  }

  /** guarda en la bóveda lo que llegue, si corresponde */
  private captureMessages(
    messages: Parameters<MessageVault['add']>[0],
    source: 'history' | 'live' = 'live',
  ): void {
    const owner = this.ownerState();
    if (owner === 'no') {
      if (this.vault.size) this.vault.clear();
      this.archive.clear();
      return;
    }
    if (this.vault.add(messages) > 0) this.scheduleVaultPersist();
    this.archiveChanged(this.archive.ingest(messages, source, this.identity(), this.canon));
    if (source === 'live') this.autoTranscribe(messages);
  }

  // ------------------------------------------------------------ transcripción

  /** notas de voz que llegan en vivo: se transcriben solas, de a una */
  private autoTranscribe(messages: Parameters<MessageVault['add']>[0]): void {
    if (!this.canTranscribe() || !this.record.assistant?.autoTranscribe) return;
    for (const m of messages) {
      const jid = m?.key?.remoteJid;
      const id = m?.key?.id;
      if (!jid || !id || this.transcripts.has(id)) continue;
      const inner = unwrapMessage(m.message) as { audioMessage?: { ptt?: boolean | null } } | null;
      if (!inner?.audioMessage) continue;
      void this.transcribeMessage(jid, id).catch((err: unknown) =>
        this.log.info(
          { err: errorMessage(err).slice(0, 120) },
          'no se pudo transcribir la nota de voz',
        ),
      );
    }
  }

  private takeDirtyTranscripts(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const id of this.transcriptsDirty) {
      const t = this.transcripts.get(id);
      if (t) out[TRANSCRIPT_PREFIX + id] = JSON.stringify(t);
    }
    this.transcriptsDirty.clear();
    return out;
  }

  /** la transcripción guardada de un mensaje, si existe */
  transcriptOf(messageId: string): StoredTranscript | null {
    return this.transcripts.get(messageId) ?? null;
  }

  /**
   * Pasa a texto una nota de voz (o audio OGG) de un chat guardado o de un proyecto.
   * Corre en el equipo; el audio no sale a ningún servicio. Queda guardada (cifrada).
   */
  async transcribeMessage(
    chatJid: string,
    messageId: string,
    opts: { force?: boolean } = {},
  ): Promise<TranscriptResult> {
    this.requireOwner();
    const transcriber = this.canTranscribe() ? this.deps.transcriber : null;
    if (!transcriber)
      throw new HttpError(409, 'transcribe_disabled', 'La transcripción de audios está apagada');
    const existing = this.transcripts.get(messageId);
    if (existing && !opts.force) return { ...existing, messageId, cached: true };
    const running = this.transcribing.get(messageId);
    if (running) return running;

    const job = (async (): Promise<TranscriptResult> => {
      const audio = await this.audioFor(chatJid, messageId);
      let result;
      try {
        result = await transcriber.transcribe(audio.buffer, audio.mimetype);
      } catch (err) {
        if (err instanceof UnsupportedAudioError)
          throw new HttpError(415, 'unsupported_audio', err.message);
        throw err;
      }
      const stored: StoredTranscript = {
        chatJid: audio.chatJid,
        text: result.text,
        model: result.model,
        seconds: Math.round(result.seconds),
        at: Date.now(),
      };
      this.transcripts.set(messageId, stored);
      this.transcriptsDirty.add(messageId);
      this.scheduleVaultPersist();
      this.log.info(
        { seconds: stored.seconds, ms: result.tookMs, model: result.model },
        'nota de voz transcrita',
      );
      return { ...stored, messageId, cached: false };
    })().finally(() => this.transcribing.delete(messageId));
    this.transcribing.set(messageId, job);
    return job;
  }

  /** el audio de un mensaje: primero la bóveda, si no el archivo del proyecto */
  private async audioFor(
    chatJid: string,
    messageId: string,
  ): Promise<{ buffer: Buffer; mimetype: string; chatJid: string }> {
    const key = this.stats.canonicalJid(chatJid);
    const msg = this.mergedVault()
      .get(key)
      ?.messages.find((m) => m.id === messageId);
    if (msg) {
      if (msg.kind !== 'voice' && msg.kind !== 'audio')
        throw new HttpError(400, 'not_audio', 'Ese mensaje no es una nota de voz');
      const media = await this.personalMedia(chatJid, messageId);
      if (media.thumbnail)
        throw new HttpError(410, 'media_expired', 'El audio ya no se puede bajar de WhatsApp');
      return { buffer: media.buffer, mimetype: media.mimetype, chatJid: key };
    }
    const pj = this.canon(normalizeJid(chatJid));
    const rec = this.archive.tracked(pj) ? this.archive.get(pj, messageId) : null;
    if (!rec) throw new HttpError(404, 'message_not_found', 'Mensaje no encontrado');
    if (rec.kind !== 'voice' && rec.kind !== 'audio')
      throw new HttpError(400, 'not_audio', 'Ese mensaje no es una nota de voz');
    const media = await this.projectMedia(pj, messageId);
    return { buffer: media.buffer, mimetype: media.mimetype, chatJid: pj };
  }

  /** jid con el que se identifica un chat (LID y número = el mismo) */
  private readonly canon = (jid: string) => this.stats.canonicalJid(jid);

  private identity() {
    const p = this.record.profile;
    return {
      meJid: p?.jid ? normalizeJid(p.jid) : null,
      meLid: p?.lid ? normalizeJid(p.lid) : null,
    };
  }

  /** algo cambió en el archivo de proyectos: guardar, bajar media y reexportar */
  private archiveChanged(n: number): void {
    if (!n) return;
    this.scheduleVaultPersist();
    this.kickMedia();
    this.scheduleExport();
  }

  private scheduleVaultPersist(): void {
    if (this.vaultTimer) return;
    this.vaultTimer = setTimeout(() => {
      this.vaultTimer = null;
      void this.persistVault();
    }, VAULT_PERSIST_MS);
    this.vaultTimer.unref?.();
  }

  private async persistVault(): Promise<void> {
    if (this.disposed || this.loggingOut || !this.record.linked) return;
    if (this.ownerState() !== 'yes') {
      // aún no sabemos el número: reintentamos después
      if (this.ownerState() === 'unknown' && this.vault.size) this.scheduleVaultPersist();
      return;
    }
    if (this.stats.summary().state === 'complete') this.vault.prune();
    const vaultEntries = this.vault.takeDirty();
    const archiveEntries = this.archive.takeDirty();
    const transcriptEntries = this.takeDirtyTranscripts();
    const entries = { ...vaultEntries, ...archiveEntries, ...transcriptEntries };
    const keys = Object.keys(entries);
    if (!keys.length) return;
    try {
      await this.deps.store.writeAuth(this.id, entries);
      this.touch();
    } catch (err) {
      this.vault.markDirty(Object.keys(vaultEntries));
      this.archive.markDirty(Object.keys(archiveEntries));
      for (const k of Object.keys(transcriptEntries))
        this.transcriptsDirty.add(k.slice(TRANSCRIPT_PREFIX.length));
      this.log.error({ err }, 'no se pudieron guardar los mensajes de "Mi vista"');
      this.scheduleVaultPersist();
    }
  }

  private async loadVault(): Promise<void> {
    if (this.vaultLoaded) return;
    this.vaultLoaded = true;
    if (!this.deps.ownerPhone && !this.record.assistant?.enabled) return;
    try {
      const keys = await this.deps.store.listAuthKeys(this.id, VAULT_KEY_PREFIX);
      if (!keys.length) return;
      this.vault.load(await this.deps.store.readAuth(this.id, keys));
      this.log.info({ chats: this.vault.size }, 'mensajes de "Mi vista" cargados');
    } catch (err) {
      this.log.warn({ err }, 'no se pudieron cargar los mensajes de "Mi vista"');
    }
    try {
      const keys = await this.deps.store.listAuthKeys(this.id, TRANSCRIPT_PREFIX);
      if (keys.length) {
        for (const [k, v] of await this.deps.store.readAuth(this.id, keys)) {
          try {
            this.transcripts.set(
              k.slice(TRANSCRIPT_PREFIX.length),
              JSON.parse(v) as StoredTranscript,
            );
          } catch {
            // entrada corrupta: se ignora
          }
        }
      }
    } catch (err) {
      this.log.warn({ err }, 'no se pudieron cargar las transcripciones');
    }
    try {
      const keys = (await this.deps.store.listAuthKeys(this.id, ARCHIVE_PREFIX)).filter(
        (k) => !k.startsWith('archive:media:'),
      );
      if (keys.length) {
        this.archive.load(await this.deps.store.readAuth(this.id, keys));
        this.log.info({ proyectos: this.archive.list().length }, 'proyectos cargados');
        this.kickMedia();
      }
    } catch (err) {
      this.log.warn({ err }, 'no se pudieron cargar los proyectos');
    }
  }

  private resetVault(): void {
    this.vault = new MessageVault((v) => JSON.stringify(v, BufferJSON.replacer));
    this.transcripts.clear();
    this.transcriptsDirty.clear();
    this.archive = new ChatArchive((v) => JSON.stringify(v, BufferJSON.replacer));
    if (this.exportTimer) clearTimeout(this.exportTimer);
    this.exportTimer = null;
    this.vaultLoaded = true;
    if (this.vaultTimer) clearTimeout(this.vaultTimer);
    this.vaultTimer = null;
    this.mediaCache.clear();
    this.mediaCacheBytes = 0;
  }

  /** chats de la bóveda unificados por contacto (LID y número = el mismo chat) */
  private mergedVault(): Map<string, { jids: string[]; messages: StoredMessage[] }> {
    const out = new Map<string, { jids: string[]; messages: StoredMessage[] }>();
    for (const [jid, list] of this.vault.entries()) {
      const key = this.stats.canonicalJid(jid);
      const cur = out.get(key) ?? { jids: [], messages: [] };
      cur.jids.push(jid);
      cur.messages.push(...list);
      out.set(key, cur);
    }
    for (const v of out.values()) {
      v.messages.sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
      if (v.messages.length > VAULT_PER_CHAT) v.messages = v.messages.slice(-VAULT_PER_CHAT);
    }
    return out;
  }

  private async names() {
    const dir = await this.directory();
    return {
      people: new Map(dir.people.map((p) => [p.jid, p])),
      groups: new Map(dir.groups.map((g) => [g.jid, g.name])),
    };
  }

  private toChat(
    jid: string,
    messages: StoredMessage[],
    names: Awaited<ReturnType<WaSession['names']>>,
  ): PersonalChat {
    const group = isGroupJid(jid);
    const last = messages[messages.length - 1]!;
    const me = this.record.profile;
    const isSelf = !group && (jid === me?.jid || (me?.lid ? jid === me.lid : false));
    const phone = group ? null : phoneOf(jid);
    let name: string | null;
    if (group) name = names.groups.get(jid) ?? 'Grupo sin nombre';
    else if (isSelf) name = `${me?.name ?? 'Tú'} (tú)`;
    else
      name =
        names.people.get(jid)?.displayName ??
        [...messages].reverse().find((m) => !m.fromMe && m.pushName)?.pushName ??
        (phone ? prettyPhone(phone) : 'Contacto sin número');
    return {
      jid,
      name,
      phone,
      isGroup: group,
      isSelf,
      lastMessageAt: last.ts,
      preview: last.text,
      previewKind: last.kind,
      previewFromMe: last.fromMe,
      previewSender: group && !last.fromMe ? this.senderName(last, names) : null,
      stored: messages.length,
    };
  }

  private senderName(m: StoredMessage, names: Awaited<ReturnType<WaSession['names']>>) {
    if (m.fromMe) return 'Tú';
    if (!m.sender) return null;
    const key = this.stats.canonicalJid(m.sender);
    const alt = m.senderAlt ? this.stats.canonicalJid(m.senderAlt) : null;
    return (
      names.people.get(key)?.displayName ??
      (alt ? names.people.get(alt)?.displayName : null) ??
      m.pushName ??
      null
    );
  }

  // ------------------------------------------------------------ proyectos (chats aislados)

  /** chats aislados con su resumen */
  async projects(): Promise<ProjectInfo[]> {
    this.requireOwner();
    const names = await this.names();
    return this.archive.list().map((m) => this.projectInfo(m.jid, names));
  }

  /**
   * Aísla un chat: desde ahora se guarda TODO lo que llegue (sin tope), con metadatos
   * y media. Arranca con lo que ya había en la bóveda.
   */
  async isolate(chatJid: string, now = Date.now()): Promise<ProjectInfo> {
    this.requireOwner();
    const jid = this.canon(normalizeJid(chatJid));
    const v = this.mergedVaultFull().get(jid);
    if (!v?.messages.length && !this.archive.tracked(jid))
      throw new HttpError(404, 'chat_not_found', 'No hay mensajes guardados de ese chat');
    this.archive.track(jid, now);
    const n = this.archive.backfill(jid, v?.messages ?? [], this.identity(), now);
    this.log.info({ chat: jid, mensajes: n }, 'chat aislado como proyecto');
    this.archiveChanged(n || 1);
    const names = await this.names();
    return this.projectInfo(jid, names);
  }

  /** deja de aislar el chat y borra su archivo (la exportación en carpeta queda) */
  async unisolate(chatJid: string): Promise<void> {
    this.requireOwner();
    const jid = this.canon(normalizeJid(chatJid));
    if (!this.archive.tracked(jid))
      throw new HttpError(404, 'project_not_found', 'Ese chat no está aislado');
    const keys = this.archive.untrack(jid);
    await this.deps.store.writeAuth(this.id, Object.fromEntries(keys.map((k) => [k, null])));
  }

  async projectMessages(
    chatJid: string,
    opts: { limit?: number; before?: number | null; raw?: boolean } = {},
  ): Promise<ProjectMessages> {
    this.requireOwner();
    const jid = this.projectJid(chatJid);
    const names = await this.names();
    const all = this.archive.messages(jid);
    const upTo = opts.before ? all.filter((m) => m.timestamp < opts.before!) : all;
    const limit = Math.min(Math.max(opts.limit ?? 500, 1), 5000);
    const page = upTo.slice(-limit);
    return {
      project: this.projectInfo(jid, names),
      messages: page.map((r) => this.toArchived(r, names, Boolean(opts.raw))),
      hasMore: upTo.length > page.length,
    };
  }

  /** métricas por persona de un chat fijado */
  async projectMetrics(
    chatJid: string,
    opts: { days?: number | null } = {},
  ): Promise<ProjectMetrics> {
    this.requireOwner();
    const jid = this.projectJid(chatJid);
    const names = await this.names();
    const msgs = this.archive.messages(jid).map((r) => this.toArchived(r, names, false));
    return computeProjectMetrics(jid, msgs, { days: opts.days ?? null });
  }

  /** archivo bajado de un mensaje del proyecto */
  async projectMedia(
    chatJid: string,
    messageId: string,
  ): Promise<{ buffer: Buffer; mimetype: string; fileName: string | null }> {
    this.requireOwner();
    const jid = this.projectJid(chatJid);
    const rec = this.archive.get(jid, messageId);
    if (!rec?.media) throw new HttpError(404, 'media_not_found', 'Este mensaje no tiene archivo');
    const buffer = await this.readArchivedMedia(jid, messageId);
    if (!buffer)
      throw new HttpError(
        404,
        'media_not_downloaded',
        rec.media.error
          ? `No se pudo bajar: ${rec.media.error}`
          : 'Todavía no se baja este archivo',
      );
    return {
      buffer,
      mimetype: rec.media.mimetype ?? 'application/octet-stream',
      fileName: rec.media.fileName ?? null,
    };
  }

  /** escribe la carpeta del proyecto (JSONL, Excel, archivos) y devuelve el resumen */
  async exportProject(chatJid: string, now = Date.now()): Promise<ProjectInfo> {
    this.requireOwner();
    const jid = this.projectJid(chatJid);
    if (!this.deps.exportDir)
      throw new HttpError(409, 'export_disabled', 'No hay carpeta de exportación configurada');
    await this.runExport(jid, now);
    return this.projectInfo(jid, await this.names());
  }

  /** ruta de la carpeta del proyecto; si todavía no existe, la exporta primero */
  async projectFolder(chatJid: string): Promise<string> {
    this.requireOwner();
    const jid = this.projectJid(chatJid);
    if (!this.deps.exportDir)
      throw new HttpError(409, 'export_disabled', 'No hay carpeta de exportación configurada');
    const dir = this.projectInfo(jid, await this.names()).exportDir!;
    if (!existsSync(dir)) await this.runExport(jid);
    return dir;
  }

  // ------------------------------------------------------------ traer toda la conversación

  /**
   * Le pide al teléfono del dueño el historial antiguo de un chat, por tramos de
   * HISTORY_PAGE, hasta que no quede más (o el tope). El chat se aísla como proyecto
   * para guardarlo completo, sin el tope de 300 / 90 días de la bóveda.
   */
  async fetchFullHistory(chatJid: string, now = Date.now()): Promise<HistoryFetchStatus> {
    this.requireOwner();
    const sock = this.sock;
    if (!sock?.fetchHistory)
      throw new HttpError(409, 'history_unavailable', 'WhatsApp no está conectado ahora');
    const jid = this.canon(normalizeJid(chatJid));
    const cur = this.backfills.get(jid);
    if (cur?.state === 'running') return this.backfillStatus(jid);
    await this.isolate(jid, now);
    const st = {
      jid,
      state: 'running' as const,
      pages: 0,
      added: 0,
      total: 0,
      oldest: null,
      startedAt: now,
      finishedAt: null,
      reason: null,
      error: null,
      timer: null,
      asked: null,
    };
    this.backfills.set(jid, st);
    this.log.info({ chat: jid }, 'pidiendo historial completo al teléfono');
    await this.askNextPage(jid);
    return this.backfillStatus(jid);
  }

  /** estado de "traer toda la conversación" de un chat */
  historyStatus(chatJid: string): HistoryFetchStatus {
    this.requireOwner();
    return this.backfillStatus(this.canon(normalizeJid(chatJid)));
  }

  private backfillStatus(jid: string): HistoryFetchStatus {
    const list = this.archive.tracked(jid) ? this.archive.messages(jid) : [];
    const st = this.backfills.get(jid);
    const base: HistoryFetchStatus = {
      jid,
      state: 'idle',
      pages: 0,
      added: 0,
      total: list.length,
      oldest: list[0]?.timestamp ?? null,
      startedAt: null,
      finishedAt: null,
      reason: null,
      error: null,
    };
    if (!st) return base;
    const { timer: _t, asked: _a, ...rest } = st;
    return { ...rest, total: base.total, oldest: base.oldest };
  }

  /** mensaje más antiguo guardado del chat, con la key original de WhatsApp */
  private oldestAnchor(jid: string): { anchor: HistoryAnchor; ts: number } | null {
    const first = this.archive.messages(jid)[0];
    if (!first) return null;
    const raw = parseRaw(first.rawJson) as { key?: { remoteJid?: string } } | null;
    return {
      anchor: { remoteJid: raw?.key?.remoteJid ?? jid, id: first.id, fromMe: first.fromMe },
      ts: first.timestamp,
    };
  }

  private async askNextPage(jid: string): Promise<void> {
    const st = this.backfills.get(jid);
    if (!st || st.state !== 'running') return;
    const sock = this.sock;
    const from = this.oldestAnchor(jid);
    if (!sock?.fetchHistory || !from) {
      this.finishBackfill(
        jid,
        sock?.fetchHistory ? 'complete' : null,
        sock ? null : 'Se cortó la conexión con WhatsApp',
      );
      return;
    }
    st.asked = from.ts;
    if (st.timer) clearTimeout(st.timer);
    st.timer = setTimeout(
      () => this.finishBackfill(jid, st.pages ? 'complete' : 'timeout'),
      HISTORY_WAIT_MS,
    );
    try {
      await sock.fetchHistory(HISTORY_PAGE, from.anchor, from.ts);
    } catch (err) {
      this.finishBackfill(jid, null, errorMessage(err));
    }
  }

  /** cuántos mensajes tiene guardados cada chat con historial en curso */
  private backfillSizes(): Map<string, number> {
    const out = new Map<string, number>();
    for (const [jid, st] of this.backfills)
      if (st.state === 'running') out.set(jid, this.archive.messages(jid).length);
    return out;
  }

  /**
   * Llegó un tramo pedido: si trajo algo más antiguo, se pide el siguiente. Un tramo
   * vacío es la forma en que el teléfono dice "no hay más".
   */
  private onDemandBatch(before: Map<string, number>, empty: boolean): void {
    for (const [jid, prev] of before) {
      const st = this.backfills.get(jid);
      if (!st || st.state !== 'running') continue;
      if (empty) {
        st.pages += 1;
        this.finishBackfill(jid, 'complete');
        continue;
      }
      const now = this.archive.messages(jid).length;
      const oldest = this.archive.messages(jid)[0]?.timestamp ?? null;
      const gotOlder = now > prev && oldest !== null && st.asked !== null && oldest < st.asked;
      if (now === prev && !gotOlder) continue; // el tramo era de otro chat
      st.pages += 1;
      st.added += Math.max(now - prev, 0);
      if (!gotOlder) this.finishBackfill(jid, 'complete');
      else if (st.pages >= HISTORY_MAX_PAGES) this.finishBackfill(jid, 'limit');
      else void this.askNextPage(jid);
    }
  }

  private finishBackfill(
    jid: string,
    reason: HistoryFetchStatus['reason'],
    error: string | null = null,
  ): void {
    const st = this.backfills.get(jid);
    if (!st || st.state !== 'running') return;
    if (st.timer) clearTimeout(st.timer);
    st.timer = null;
    st.state = error ? 'error' : 'done';
    st.reason = reason;
    st.error = error;
    st.finishedAt = Date.now();
    this.log.info(
      { chat: jid, tramos: st.pages, nuevos: st.added, motivo: reason, error },
      'historial completo: terminado',
    );
  }

  private stopBackfills(): void {
    for (const jid of this.backfills.keys())
      this.finishBackfill(jid, null, 'Se cortó la conexión con WhatsApp');
  }

  private projectJid(chatJid: string): string {
    const jid = this.canon(normalizeJid(chatJid));
    if (!this.archive.tracked(jid))
      throw new HttpError(404, 'project_not_found', 'Ese chat no está aislado');
    return jid;
  }

  private async readArchivedMedia(jid: string, id: string): Promise<Buffer | null> {
    const key = MEDIA_KEY(jid, id);
    const v = (await this.deps.store.readAuth(this.id, [key])).get(key);
    return v ? Buffer.from(v, 'base64') : null;
  }

  private chatName(jid: string, names: Awaited<ReturnType<WaSession['names']>>): string {
    if (isGroupJid(jid)) return names.groups.get(jid) ?? 'Grupo sin nombre';
    return names.people.get(jid)?.displayName ?? phoneOf(jid) ?? jid;
  }

  private personName(
    p: ArchiveRecord['sender'],
    fromMe: boolean,
    names: Awaited<ReturnType<WaSession['names']>>,
  ): string | null {
    if (fromMe) return this.record.profile?.name ?? 'Tú';
    for (const j of [p.jid, p.lid]) {
      if (!j) continue;
      const n = names.people.get(this.canon(j))?.displayName;
      if (n) return n;
    }
    return p.pushName ?? p.phone ?? null;
  }

  private toArchived(
    r: ArchiveRecord,
    names: Awaited<ReturnType<WaSession['names']>>,
    withRaw: boolean,
  ): ArchivedMessage {
    const { rawJson, mediaAttempts: _a, ...rest } = r;
    // quien vino solo por LID: completamos su número con el mapeo LID → número
    const sender = { ...r.sender };
    if (!sender.jid && sender.lid) {
      const pn = this.canon(sender.lid);
      if (pn.endsWith('@s.whatsapp.net')) {
        sender.jid = pn;
        sender.phone = phoneOf(pn);
      }
    }
    const out: ArchivedMessage = {
      ...rest,
      sender: { ...sender, name: this.personName(sender, r.fromMe, names) },
    };
    const tr = this.transcripts.get(r.id);
    if (tr) out.transcript = tr.text;
    if (withRaw) out.raw = parseRaw(rawJson);
    return out;
  }

  private projectInfo(jid: string, names: Awaited<ReturnType<WaSession['names']>>): ProjectInfo {
    const meta = this.archive.meta(jid)!;
    const list = this.archive.messages(jid);
    const kinds: ProjectInfo['kinds'] = {};
    const people = new Set<string>();
    const media = { total: 0, downloaded: 0, failed: 0, bytes: 0 };
    for (const m of list) {
      kinds[m.kind] = (kinds[m.kind] ?? 0) + 1;
      people.add(m.fromMe ? 'me' : (m.sender.lid ?? m.sender.jid ?? '?'));
      if (m.media && !m.deleted) {
        media.total += 1;
        if (m.media.downloaded) {
          media.downloaded += 1;
          media.bytes += m.media.size ?? 0;
        } else if (m.media.error && m.mediaAttempts >= 3) media.failed += 1;
      }
    }
    return {
      jid,
      name: this.chatName(jid, names),
      isGroup: isGroupJid(jid),
      since: meta.since,
      messages: list.length,
      participants: people.size,
      first: list[0]?.timestamp ?? null,
      last: list[list.length - 1]?.timestamp ?? null,
      kinds,
      media,
      exportDir: this.deps.exportDir
        ? join(this.deps.exportDir, projectSlug(this.chatName(jid, names)))
        : null,
      exportedAt: meta.exportedAt,
    };
  }

  /** bóveda unificada por contacto, sin recortar a VAULT_PER_CHAT */
  private mergedVaultFull(): Map<string, { messages: StoredMessage[] }> {
    const out = new Map<string, { messages: StoredMessage[] }>();
    for (const [jid, list] of this.vault.entries()) {
      const key = this.canon(jid);
      const cur = out.get(key) ?? { messages: [] };
      cur.messages.push(...list);
      out.set(key, cur);
    }
    return out;
  }

  /** baja la media pendiente de los proyectos, de a una (HTTPS al CDN, no envía nada) */
  private kickMedia(): void {
    if (this.mediaRunning || !this.deps.downloadMedia || this.disposed) return;
    if (!this.archive.pendingMedia().length) return;
    this.mediaRunning = true;
    void this.runMedia().finally(() => {
      this.mediaRunning = false;
    });
  }

  private async runMedia(): Promise<void> {
    for (;;) {
      if (this.disposed || this.loggingOut || !this.record.linked) return;
      if (this.ownerState() !== 'yes') return;
      const next = this.archive.pendingMedia()[0];
      if (!next) return;
      const { chatJid: jid, id } = next;
      try {
        const buffer = await this.downloadWithRetry(parseRaw(next.rawJson));
        const sha = createHash('sha256').update(buffer).digest('base64');
        const verified = next.media?.sha256 ? sha === next.media.sha256 : null;
        await this.deps.store.writeAuth(this.id, {
          [MEDIA_KEY(jid, id)]: buffer.toString('base64'),
        });
        this.archive.mediaDone(jid, id, { ok: true, size: buffer.length, verified });
      } catch (err) {
        this.log.info({ chat: jid, err: errorMessage(err) }, 'no se pudo bajar media del proyecto');
        this.archive.mediaDone(jid, id, { ok: false, error: errorMessage(err) });
      }
      this.scheduleVaultPersist();
      this.scheduleExport();
    }
  }

  /** reexporta las carpetas de los proyectos un rato después del último cambio */
  private scheduleExport(): void {
    if (!this.deps.exportDir || this.exportTimer) return;
    this.exportTimer = setTimeout(() => {
      this.exportTimer = null;
      for (const p of this.archive.list())
        void this.runExport(p.jid).catch((err) =>
          this.log.warn({ err: errorMessage(err) }, 'no se pudo exportar el proyecto'),
        );
    }, EXPORT_DEBOUNCE_MS);
    this.exportTimer.unref?.();
  }

  private runExport(jid: string, now = Date.now()): Promise<unknown> {
    const job = this.exporting
      .catch(() => {})
      .then(async () => {
        if (!this.archive.tracked(jid) || !this.deps.exportDir) return;
        const names = await this.names();
        const info = this.projectInfo(jid, names);
        const messages = this.archive.messages(jid).map((r) => this.toArchived(r, names, true));
        await writeProjectExport(info.exportDir!, info, messages, (id) =>
          this.readArchivedMedia(jid, id),
        );
        this.archive.markExported(jid, now);
        this.scheduleVaultPersist();
      });
    this.exporting = job;
    return job;
  }

  /** chats de "Mi vista": con actividad en la ventana, del más reciente al más antiguo */
  async personalChats(opts: { days?: number } = {}, now = Date.now()): Promise<PersonalChatList> {
    this.requireOwner();
    const days = clamp(opts.days ?? VIEW_WINDOW_DAYS, 1, VAULT_WINDOW_DAYS);
    const cutoff = now - days * 86_400_000;
    const names = await this.names();
    const items: PersonalChat[] = [];
    for (const [jid, v] of this.mergedVault()) {
      const last = v.messages[v.messages.length - 1];
      if (!last || last.ts < cutoff) continue;
      items.push(this.toChat(jid, v.messages, names));
    }
    items.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
    const groups = items.filter((c) => c.isGroup).length;
    let messages = 0;
    for (const c of items) messages += c.stored;
    return {
      items,
      groups,
      individual: items.length - groups,
      chats: items.length,
      messages,
      windowDays: days,
      perChat: VIEW_PER_CHAT,
      storeDays: VAULT_WINDOW_DAYS,
      storePerChat: VAULT_PER_CHAT,
      sendEnabled: this.canSend(),
      transcribeEnabled: this.canTranscribe(),
    };
  }

  /** últimos mensajes de un chat (de más antiguo a más nuevo) */
  async personalMessages(
    chatJid: string,
    opts: { limit?: number; before?: number } = {},
  ): Promise<PersonalChatMessages> {
    this.requireOwner();
    const key = this.stats.canonicalJid(chatJid);
    const v = this.mergedVault().get(key);
    if (!v?.messages.length) throw new HttpError(404, 'chat_not_found', 'Chat no encontrado');
    const names = await this.names();
    const limit = clamp(opts.limit ?? VIEW_PER_CHAT, 1, VAULT_PER_CHAT);
    const pool = opts.before ? v.messages.filter((m) => m.ts < opts.before!) : v.messages;
    const page = pool.slice(-limit);
    return {
      chat: this.toChat(key, v.messages, names),
      messages: page.map((m) => this.toMessage(key, m, names)),
      hasMore: pool.length > page.length,
    };
  }

  private toMessage(
    chatKey: string,
    m: StoredMessage,
    names: Awaited<ReturnType<WaSession['names']>>,
  ): ChatMessage {
    const group = isGroupJid(chatKey);
    const sender = m.sender ? this.stats.canonicalJid(m.sender) : null;
    return {
      id: m.id,
      fromMe: m.fromMe,
      timestamp: m.ts,
      kind: m.kind,
      text: m.text,
      senderJid: group ? sender : null,
      senderName: group ? this.senderName(m, names) : null,
      senderPhone: group ? (phoneOf(sender) ?? phoneOf(m.senderAlt ?? null)) : null,
      media: m.media,
      location: m.location ?? null,
      ...(m.edited ? { edited: true } : {}),
      ...(this.transcripts.has(m.id) ? { transcript: this.transcripts.get(m.id)!.text } : {}),
    };
  }

  /**
   * Busca texto en los mensajes guardados (sin distinguir mayúsculas ni tildes;
   * todas las palabras deben aparecer). Del más nuevo al más antiguo.
   */
  async searchPersonal(
    query: string,
    opts: { days?: number; chatJid?: string | null; limit?: number } = {},
    now = Date.now(),
  ): Promise<SearchResult> {
    this.requireOwner();
    const terms = fold(query).split(/\s+/).filter(Boolean);
    if (!terms.length) throw new HttpError(400, 'bad_request', 'Escribe algo para buscar');
    const days = clamp(opts.days ?? VAULT_WINDOW_DAYS, 1, VAULT_WINDOW_DAYS);
    const limit = clamp(opts.limit ?? 50, 1, 200);
    const cutoff = now - days * 86_400_000;
    const only = opts.chatJid ? this.stats.canonicalJid(opts.chatJid) : null;
    const names = await this.names();
    const found: { key: string; msgs: StoredMessage[]; m: StoredMessage }[] = [];
    for (const [key, v] of this.mergedVault()) {
      if (only && key !== only) continue;
      for (const m of v.messages) {
        if (m.ts < cutoff) continue;
        const hay = fold(
          `${m.text ?? ''} ${m.media?.fileName ?? ''} ${this.transcripts.get(m.id)?.text ?? ''}`,
        );
        if (terms.every((t) => hay.includes(t))) found.push({ key, msgs: v.messages, m });
      }
    }
    found.sort((a, b) => b.m.ts - a.m.ts);
    const chats = new Map<string, SearchHit['chat']>();
    const hits: SearchHit[] = found.slice(0, limit).map(({ key, msgs, m }) => {
      let chat = chats.get(key);
      if (!chat) {
        const c = this.toChat(key, msgs, names);
        chat = { jid: c.jid, name: c.name, isGroup: c.isGroup, phone: c.phone };
        chats.set(key, chat);
      }
      return { chat, message: this.toMessage(key, m, names) };
    });
    return { query, days, total: found.length, hits };
  }

  /**
   * Envía un texto desde el número del dueño. Solo con ALLOW_SEND, solo a chats que
   * ya existen en la bóveda y con límites por minuto/hora/día. El log no guarda el texto.
   */
  async sendPersonal(chatJid: string, text: string, now = Date.now()): Promise<SendResult> {
    const body = text.trim();
    if (!body) throw new HttpError(400, 'bad_request', 'El mensaje está vacío');
    if (body.length > 4096)
      throw new HttpError(400, 'bad_request', 'El mensaje es muy largo (máx. 4096)');
    const { key, sock } = this.prepareSend(chatJid, now);
    if (!sock.sendText)
      throw new HttpError(409, 'not_connected', 'WhatsApp no está conectado ahora');
    const sent = await this.deliver(key, () => sock.sendText!(key, body));
    this.log.info({ chat: key, chars: body.length }, 'mensaje enviado por el dueño');
    return this.storeSent(key, sent, { conversation: body }, now);
  }

  /**
   * Envía una foto, video, audio o documento (mismas reglas que el texto). El log
   * guarda el tipo y el tamaño, nunca el contenido ni el nombre del archivo.
   */
  async sendPersonalMedia(
    chatJid: string,
    input: {
      data: Buffer;
      mimetype: string;
      fileName: string;
      caption?: string | null;
      asDocument?: boolean;
    },
    now = Date.now(),
  ): Promise<SendResult> {
    if (!input.data.length) throw new HttpError(400, 'bad_request', 'El archivo está vacío');
    if (input.data.length > MAX_SEND_BYTES)
      throw new HttpError(
        413,
        'too_large',
        `El archivo pesa más de ${MAX_SEND_BYTES / 1024 / 1024} MB, el máximo que se puede enviar`,
      );
    const caption = input.caption?.trim() || undefined;
    if (caption && caption.length > 1024)
      throw new HttpError(400, 'bad_request', 'El texto del archivo es muy largo (máx. 1024)');
    const media: OutgoingMedia = {
      kind: input.asDocument ? 'document' : mediaKindFor(input.mimetype),
      data: input.data,
      mimetype: input.mimetype || 'application/octet-stream',
      fileName: cleanFileName(input.fileName),
      caption,
    };
    const { key, sock } = this.prepareSend(chatJid, now);
    if (!sock.sendMedia)
      throw new HttpError(409, 'not_connected', 'WhatsApp no está conectado ahora');
    const sent = await this.deliver(key, () => sock.sendMedia!(key, media), 90_000);
    this.log.info(
      { chat: key, kind: media.kind, bytes: media.data.length, mimetype: media.mimetype },
      'archivo enviado por el dueño',
    );
    return this.storeSent(key, sent, null, now);
  }

  /**
   * Crea un grupo nuevo desde el número del dueño (ALLOW_SEND), con él como admin.
   * Máximo 50 participantes y 10 grupos por día. Opcionalmente manda un primer
   * mensaje. El log guarda cuántos participantes, nunca los números ni el texto.
   */
  async createPersonalGroup(
    input: { subject: string; participants: string[]; text?: string | null },
    now = Date.now(),
  ): Promise<GroupCreateResult> {
    this.requireOwner();
    if (!this.canSend())
      throw new HttpError(
        403,
        'send_disabled',
        'El envío no está habilitado (actívalo en los ajustes del asistente)',
      );
    const subject = input.subject.trim();
    if (!subject) throw new HttpError(400, 'bad_request', 'El grupo necesita un nombre');
    if (subject.length > 100)
      throw new HttpError(400, 'bad_request', 'El nombre del grupo es muy largo (máx. 100)');
    const me = this.auth?.state.creds.me?.id ?? this.record.profile?.jid ?? '';
    const owner = (me.split('@')[0] ?? '').split(':')[0] ?? '';
    const jids: string[] = [];
    const invalid: string[] = [];
    for (const raw of input.participants) {
      const phone = toPhoneDigits(raw);
      if (!phone) invalid.push(raw);
      else if (phone !== owner && !jids.includes(`${phone}@s.whatsapp.net`))
        jids.push(`${phone}@s.whatsapp.net`);
    }
    if (invalid.length)
      throw new HttpError(400, 'bad_request', `Números no válidos: ${invalid.join(', ')}`);
    if (!jids.length) throw new HttpError(400, 'bad_request', 'Agrega al menos un participante');
    if (jids.length > 50)
      throw new HttpError(400, 'bad_request', 'Máximo 50 participantes por grupo');
    const text = input.text?.trim() || null;
    if (text && text.length > 4096)
      throw new HttpError(400, 'bad_request', 'El mensaje es muy largo (máx. 4096)');
    const sock = this.sock;
    if (!sock || this.record.status !== 'connected' || !sock.createGroup)
      throw new HttpError(409, 'not_connected', 'WhatsApp no está conectado ahora');
    this.groupsCreated = this.groupsCreated.filter((t) => t > now - 86_400_000);
    if (this.groupsCreated.length >= 10)
      throw new HttpError(429, 'rate_limited', 'Límite de 10 grupos nuevos por día alcanzado');
    const wait = this.sendLimiter.check('group:create', now);
    if (wait) throw new HttpError(429, 'rate_limited', wait);
    this.sendLimiter.record('group:create', now);
    this.groupsCreated.push(now);
    let created: CreatedGroup;
    try {
      created = await withTimeout(sock.createGroup(subject, jids), 30_000);
    } catch (err) {
      this.log.warn({ err: errorMessage(err) }, 'no se pudo crear el grupo');
      throw new HttpError(502, 'send_failed', `WhatsApp no creó el grupo: ${errorMessage(err)}`);
    }
    this.log.info({ group: created.id, participants: jids.length }, 'grupo creado por el dueño');
    // WhatsApp puede devolver LIDs en vez de números: si no podemos comparar por número,
    // confiamos en el conteo (dueño + pedidos) para no dar falsos "no agregados"
    const inGroup = new Set(
      created.participants
        .filter((p) => !p.endsWith('@lid'))
        .map((p) => p.split(':')[0]!.split('@')[0]),
    );
    const allThere = created.participants.length >= jids.length + 1;
    const missing = allThere
      ? []
      : jids.filter((j) => !inGroup.has(j.split('@')[0]!)).map((j) => `+${j.split('@')[0]}`);
    let message: GroupCreateResult['message'] = null;
    if (text && sock.sendText) {
      const sent = await this.deliver(created.id, () => sock.sendText!(created.id, text));
      message = (await this.storeSent(created.id, sent, { conversation: text }, now)).message;
    }
    return {
      group: { jid: created.id, name: created.subject || subject },
      participants: jids.length,
      notAdded: missing,
      message,
    };
  }

  /** reglas comunes de envío: dueño, ALLOW_SEND, chat existente, conectado y frenos */
  private prepareSend(chatJid: string, now: number): { key: string; sock: WaSocketLike } {
    this.requireOwner();
    if (!this.canSend())
      throw new HttpError(
        403,
        'send_disabled',
        'El envío no está habilitado (actívalo en los ajustes del asistente)',
      );
    const key = this.stats.canonicalJid(chatJid);
    const v = this.mergedVault().get(key);
    if (!v?.messages.length)
      throw new HttpError(
        404,
        'chat_not_found',
        'Solo se puede escribir a chats con conversación en los últimos 90 días',
      );
    const sock = this.sock;
    if (!sock || this.record.status !== 'connected')
      throw new HttpError(409, 'not_connected', 'WhatsApp no está conectado ahora');
    const wait = this.sendLimiter.check(key, now);
    if (wait) throw new HttpError(429, 'rate_limited', wait);
    this.sendLimiter.record(key, now);
    return { key, sock };
  }

  private async deliver(key: string, send: () => Promise<unknown>, ms = 20_000): Promise<unknown> {
    try {
      return await withTimeout(send(), ms);
    } catch (err) {
      this.log.warn({ chat: key, err: errorMessage(err) }, 'no se pudo enviar el mensaje');
      throw new HttpError(502, 'send_failed', `WhatsApp no aceptó el envío: ${errorMessage(err)}`);
    }
  }

  /** guarda lo enviado en la bóveda y arma la respuesta */
  private async storeSent(
    key: string,
    sent: unknown,
    fallbackMessage: { conversation: string } | null,
    now: number,
  ): Promise<SendResult> {
    const ok = sent && typeof sent === 'object' && 'key' in sent;
    if (ok || fallbackMessage) {
      const msg = (
        ok
          ? sent
          : {
              key: { id: `OUT${now}`, remoteJid: key, fromMe: true },
              message: fallbackMessage,
              messageTimestamp: Math.floor(now / 1000),
            }
      ) as Parameters<MessageVault['add']>[0][number];
      this.vault.add([msg]);
      this.scheduleVaultPersist();
      this.archiveChanged(this.archive.ingest([msg], 'sent', this.identity(), this.canon, now));
    }
    this.touch();
    const names = await this.names();
    const list = this.mergedVault().get(key)?.messages ?? [];
    const sentId = ok ? (sent as { key?: { id?: string } }).key?.id : `OUT${now}`;
    const stored = list.find((m) => m.id === sentId) ?? list[list.length - 1]!;
    const c = this.toChat(key, list, names);
    return {
      chat: { jid: c.jid, name: c.name, isGroup: c.isGroup, phone: c.phone },
      message: this.toMessage(key, stored, names),
      remaining: this.sendLimiter.remaining(now),
    };
  }

  /** media de un mensaje guardado; si ya no se puede bajar, su miniatura */
  async personalMedia(
    chatJid: string,
    messageId: string,
  ): Promise<{ buffer: Buffer; mimetype: string; thumbnail: boolean }> {
    this.requireOwner();
    const key = this.stats.canonicalJid(chatJid);
    const msg = this.mergedVault()
      .get(key)
      ?.messages.find((m) => m.id === messageId);
    if (!msg?.raw) throw new HttpError(404, 'media_not_found', 'Este mensaje no tiene media');
    const cacheKey = `${key}|${messageId}`;
    const cached = this.mediaCache.get(cacheKey);
    if (cached) return cached;

    const parsed = JSON.parse(msg.raw, BufferJSON.reviver) as { message?: object };
    let result: { buffer: Buffer; mimetype: string; thumbnail: boolean } | null = null;
    if (this.deps.downloadMedia) {
      try {
        const buffer = await this.downloadWithRetry(parsed, (updated) => {
          // guardamos la ruta nueva: la próxima vez baja directo, sin molestar al teléfono
          msg.raw = JSON.stringify(updated, BufferJSON.replacer);
          this.vault.touch(msg.id);
          this.scheduleVaultPersist();
        });
        result = {
          buffer,
          mimetype: msg.media?.mimetype ?? 'application/octet-stream',
          thumbnail: false,
        };
      } catch (err) {
        this.log.info(
          {
            err: errorMessage(err).slice(0, 80),
            status: (err as { output?: { statusCode?: number } })?.output?.statusCode ?? null,
            retry: Boolean(this.sock?.reuploadMedia),
            kind: msg.kind,
          },
          'media no disponible',
        );
      }
    }
    if (!result) {
      const inner = unwrapMessage(parsed.message) as Record<string, Record<string, unknown>> | null;
      const content = inner
        ? (inner.imageMessage ??
          inner.videoMessage ??
          inner.stickerMessage ??
          inner.documentMessage)
        : undefined;
      const thumb = content?.jpegThumbnail;
      const buf =
        typeof thumb === 'string'
          ? Buffer.from(thumb, 'base64')
          : thumb instanceof Uint8Array
            ? Buffer.from(thumb)
            : null;
      if (!buf?.length)
        throw new HttpError(410, 'media_expired', 'WhatsApp ya no tiene este archivo');
      result = { buffer: buf, mimetype: 'image/jpeg', thumbnail: true };
    }
    this.cacheMedia(cacheKey, result);
    return result;
  }

  /** solo unas pocas re-subidas a la vez: cada una despierta al teléfono */
  private reuploads = new Semaphore(2);

  /**
   * Baja la media; si el archivo venció en el CDN y es el WhatsApp del dueño, le pide
   * a su teléfono que lo vuelva a subir (no le escribe a nadie más) y reintenta.
   */
  private async downloadWithRetry(
    parsed: unknown,
    onUpdated?: (updated: unknown) => void,
  ): Promise<Buffer> {
    const sock = this.sock;
    const canRetry =
      Boolean(sock?.reuploadMedia) &&
      this.record.status === 'connected' &&
      this.ownerState() === 'yes';
    const reupload = canRetry
      ? async (m: unknown) => {
          const updated = await this.reuploads.runExclusive(() =>
            withTimeout(sock!.reuploadMedia!(m), 25_000),
          );
          const u = updated as { key?: unknown; message?: unknown } | null;
          if (u?.message) {
            const base = parsed as Record<string, unknown>;
            onUpdated?.({ ...base, key: u.key ?? base.key, message: u.message });
          }
          this.log.info('media vencida recuperada desde el teléfono');
          return updated;
        }
      : undefined;
    return withTimeout(this.deps.downloadMedia!(parsed, { reupload }), canRetry ? 60_000 : 30_000);
  }

  private cacheMedia(key: string, value: { buffer: Buffer; mimetype: string; thumbnail: boolean }) {
    if (value.buffer.length > MEDIA_CACHE_BYTES / 4) return;
    this.mediaCache.set(key, value);
    this.mediaCacheBytes += value.buffer.length;
    for (const [k, v] of this.mediaCache) {
      if (this.mediaCacheBytes <= MEDIA_CACHE_BYTES) break;
      this.mediaCache.delete(k);
      this.mediaCacheBytes -= v.buffer.length;
    }
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
      this.resetVault();
      this.record.profile = null;
      this.record.connectedAt = null;
    } else await this.loadVault();
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
    if (this.vaultTimer) clearTimeout(this.vaultTimer);
    this.vaultTimer = null;
    await this.persistVault();
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
    this.resetVault();
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
      const open = this.ownerState() !== 'no';
      const sock = await this.deps.socketFactory({
        sessionId: this.id,
        auth: this.auth,
        logger: this.log,
        capabilities: { send: open, mediaRetry: open, historyFetch: open },
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
    this.stopBackfills();
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
      const onDemand = h.syncType === SYNC_ON_DEMAND;
      const before = onDemand ? this.backfillSizes() : null;
      this.stats.addHistoryBatch({
        chats: h.chats,
        contacts: h.contacts,
        messages: h.messages,
        lidPnMappings: h.lidPnMappings ?? null,
        progress: h.progress ?? null,
        syncType: h.syncType ?? null,
        isLatest: h.isLatest ?? null,
      });
      this.captureMessages(h.messages, 'history');
      if (before) this.onDemandBatch(before, h.messages.length === 0);
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
      this.captureMessages(messages);
      this.touch();
    });
    on('messages.update', (u) => {
      this.archiveChanged(this.archive.updates(u as never, this.canon));
    });
    on('messages.reaction', (r) => {
      this.archiveChanged(this.archive.reactions(r as never, this.identity(), this.canon));
    });
    on('message-receipt.update', (r) => {
      this.archiveChanged(this.archive.receipts(r as never, this.canon));
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
      // si mientras se dibujaba llegó otro QR, cambió la generación, se vinculó o el socket
      // ya se cerró (p.ej. 408 → qr_expired), este QR ya no sirve y no debe pisar el estado
      if (
        sequence !== this.qrSequence ||
        gen !== this.generation ||
        this.record.linked ||
        this.sock !== sock
      )
        return;
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
      if (this.record.assistant?.awaitingLink) this.record.assistant.awaitingLink = false;
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
    this.stopBackfills();
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

    // 408 sin vincular y después de haber recibido al menos un QR = el QR expiró sin ser
    // escaneado (aunque el último QR todavía no haya terminado de dibujarse en una máquina lenta).
    // Un 408 antes de cualquier QR es un problema de red: ahí sí reintentamos.
    if (!this.record.linked && this.qrSequence > 0 && code === DisconnectReason.timedOut) {
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
    if (this.deps.wipeOnLogout) this.resetVault();
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
    if (this.vaultTimer) clearTimeout(this.vaultTimer);
    if (this.exportTimer) clearTimeout(this.exportTimer);
    this.exportTimer = null;
    this.persistTimer = null;
    this.emitTimer = null;
    this.vaultTimer = null;
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
      if (this.stats.checkIdle({ pauseMs: SYNC_PAUSE_MS, giveUpMs: SYNC_GIVE_UP_MS })) {
        const { state, progress } = this.stats.summary();
        this.log.info(
          { state, progress },
          state === 'paused'
            ? 'historial en pausa: el teléfono dejó de enviar'
            : 'historial terminado',
        );
        this.touch(true);
        if (state === 'complete') this.clearIdleTimer();
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

/** espera tras el último cambio antes de reescribir la carpeta del proyecto */
const EXPORT_DEBOUNCE_MS = 8_000;

/** tope de lo que se puede enviar (WhatsApp comprime fotos y videos sobre ~16 MB) */
export const MAX_SEND_BYTES = 16 * 1024 * 1024;

/** cómo se manda un archivo según su tipo: lo raro va como documento */
export function mediaKindFor(mimetype: string): OutgoingMedia['kind'] {
  const m = mimetype.toLowerCase();
  // otros formatos (HEIC, GIF, MOV…) WhatsApp no los muestra bien en línea: van como documento
  if (/^image\/(jpeg|png)$/.test(m)) return 'image';
  if (/^video\/(mp4|3gpp)$/.test(m)) return 'video';
  if (/^audio\/(ogg|mpeg|mp4|aac|amr|x-m4a|mp3)/.test(m)) return 'audio';
  return 'document';
}

/** nombre de archivo sin rutas ni caracteres de control */
export function cleanFileName(name: string): string {
  const base = [...(name.split(/[\\/]/).pop() ?? '')]
    .filter((ch) => ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) !== 127)
    .join('')
    .trim()
    .slice(0, 120);
  return base || 'archivo';
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

/** 56912345678 → +56 9 1234 5678 */
function prettyPhone(phone: string): string {
  const d = phone.replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('569')) return `+56 9 ${d.slice(3, 7)} ${d.slice(7)}`;
  return `+${d}`;
}

const clamp = (n: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Number.isFinite(n) ? Math.round(n) : min));

/** minúsculas y sin tildes, para buscar */
const fold = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');

/** número en formato internacional sin "+": acepta +56 9…, 9… (Chile) o 8–15 dígitos */
export function toPhoneDigits(raw: string): string | null {
  const d = raw.replace(/\D/g, '');
  if (/^9\d{8}$/.test(d)) return `56${d}`;
  if (/^\d{8,15}$/.test(d)) return d;
  return null;
}
