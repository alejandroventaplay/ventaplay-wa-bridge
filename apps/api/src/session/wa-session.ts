import { EventEmitter } from 'node:events';
import { BufferJSON, DisconnectReason, type BaileysEventMap } from 'baileys';
import type { Logger } from 'pino';
import QRCode from 'qrcode';
import type {
  ChatMessage,
  SearchHit,
  SearchResult,
  SendResult,
  PersonalChat,
  PersonalChatList,
  PersonalChatMessages,
  PersonalVaultInfo,
  QrCode,
  SessionStatus,
  SessionSummary,
  WaProfile,
} from '@wa-bridge/shared';
import type { SessionRecord, SessionStore } from '../store/types.js';
import { loadAuthState, type StoredAuthState } from '../wa/auth-state.js';
import type { MediaDownloader, SocketFactory, WaSocketLike } from '../wa/types.js';
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
      personal: this.personalInfo(),
      readOnly: true,
    };
  }

  // ------------------------------------------------------------------ Mi vista

  /**
   * ¿Es el WhatsApp del dueño? 'unknown' mientras no sabemos qué número se vinculó
   * (justo después de escanear): ahí guardamos en memoria pero no en disco.
   */
  private ownerState(): 'yes' | 'no' | 'unknown' {
    const owner = this.deps.ownerPhone?.replace(/\D/g, '');
    if (!owner) return 'no';
    const me = this.auth?.state.creds.me?.id ?? this.record.profile?.jid ?? null;
    if (!me) return 'unknown';
    const phone = (me.split('@')[0] ?? '').split(':')[0] ?? '';
    return phone === owner ? 'yes' : 'no';
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
      sendEnabled: Boolean(this.deps.allowSend),
    };
  }

  private requireOwner(): void {
    if (this.ownerState() !== 'yes')
      throw new HttpError(403, 'not_owner', '"Mi vista" solo está disponible para tu número');
  }

  /** guarda en la bóveda lo que llegue, si corresponde */
  private captureMessages(messages: Parameters<MessageVault['add']>[0]): void {
    const owner = this.ownerState();
    if (owner === 'no') {
      if (this.vault.size) this.vault.clear();
      return;
    }
    if (this.vault.add(messages) > 0) this.scheduleVaultPersist();
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
    const entries = this.vault.takeDirty();
    const keys = Object.keys(entries);
    if (!keys.length) return;
    try {
      await this.deps.store.writeAuth(this.id, entries);
      this.touch();
    } catch (err) {
      this.vault.markDirty(keys);
      this.log.error({ err }, 'no se pudieron guardar los mensajes de "Mi vista"');
      this.scheduleVaultPersist();
    }
  }

  private async loadVault(): Promise<void> {
    if (this.vaultLoaded) return;
    this.vaultLoaded = true;
    if (!this.deps.ownerPhone) return;
    try {
      const keys = await this.deps.store.listAuthKeys(this.id, VAULT_KEY_PREFIX);
      if (!keys.length) return;
      this.vault.load(await this.deps.store.readAuth(this.id, keys));
      this.log.info({ chats: this.vault.size }, 'mensajes de "Mi vista" cargados');
    } catch (err) {
      this.log.warn({ err }, 'no se pudieron cargar los mensajes de "Mi vista"');
    }
  }

  private resetVault(): void {
    this.vault = new MessageVault((v) => JSON.stringify(v, BufferJSON.replacer));
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
      sendEnabled: Boolean(this.deps.allowSend),
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
        const hay = fold(`${m.text ?? ''} ${m.media?.fileName ?? ''}`);
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
    this.requireOwner();
    if (!this.deps.allowSend)
      throw new HttpError(403, 'send_disabled', 'El envío no está habilitado (ALLOW_SEND)');
    const body = text.trim();
    if (!body) throw new HttpError(400, 'bad_request', 'El mensaje está vacío');
    if (body.length > 4096)
      throw new HttpError(400, 'bad_request', 'El mensaje es muy largo (máx. 4096)');
    const key = this.stats.canonicalJid(chatJid);
    const v = this.mergedVault().get(key);
    if (!v?.messages.length)
      throw new HttpError(
        404,
        'chat_not_found',
        'Solo se puede escribir a chats con conversación en los últimos 90 días',
      );
    const sock = this.sock;
    if (!sock?.sendText || this.record.status !== 'connected')
      throw new HttpError(409, 'not_connected', 'WhatsApp no está conectado ahora');
    const wait = this.sendLimiter.check(key, now);
    if (wait) throw new HttpError(429, 'rate_limited', wait);

    this.sendLimiter.record(key, now);
    let sent: unknown;
    try {
      sent = await withTimeout(sock.sendText(key, body), 20_000);
    } catch (err) {
      this.log.warn({ chat: key, err: errorMessage(err) }, 'no se pudo enviar el mensaje');
      throw new HttpError(502, 'send_failed', `WhatsApp no aceptó el envío: ${errorMessage(err)}`);
    }
    this.log.info({ chat: key, chars: body.length }, 'mensaje enviado por el dueño');
    const fallback = {
      key: { id: `OUT${now}`, remoteJid: key, fromMe: true },
      message: { conversation: body },
      messageTimestamp: Math.floor(now / 1000),
    };
    const msg = (sent && typeof sent === 'object' && 'key' in sent ? sent : fallback) as Parameters<
      MessageVault['add']
    >[0][number];
    this.vault.add([msg]);
    this.scheduleVaultPersist();
    this.touch();
    const names = await this.names();
    const list = this.mergedVault().get(key)?.messages ?? [];
    const stored = list.find((m) => m.id === msg.key?.id) ?? list[list.length - 1]!;
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
        const buffer = await withTimeout(this.deps.downloadMedia(parsed), 30_000);
        result = {
          buffer,
          mimetype: msg.media?.mimetype ?? 'application/octet-stream',
          thumbnail: false,
        };
      } catch (err) {
        this.log.info({ err: errorMessage(err), kind: msg.kind }, 'media no disponible');
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
      this.captureMessages(h.messages);
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
