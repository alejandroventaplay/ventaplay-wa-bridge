import makeWASocket, {
  Browsers,
  downloadMediaMessage,
  fetchLatestWaWebVersion,
  makeCacheableSignalKeyStore,
  type AnyMessageContent,
  type WAMessage,
  type WAVersion,
} from 'baileys';
import { HttpsProxyAgent } from 'https-proxy-agent';
import type { Logger } from 'pino';
import { enforceReadOnly } from './read-only.js';
import type { MediaDownloader, OutgoingMedia, SocketFactory, WaSocketLike } from './types.js';

const VERSION_TTL_MS = 6 * 60 * 60 * 1000;
let cachedVersion: { version: WAVersion; at: number } | null = null;

/**
 * WhatsApp corta la conexión si el cliente anuncia una versión de WA Web vieja,
 * así que consultamos la vigente (cacheada 6 h). Si falla, Baileys usa la suya.
 */
async function resolveVersion(logger: Logger): Promise<WAVersion | undefined> {
  if (cachedVersion && Date.now() - cachedVersion.at < VERSION_TTL_MS) return cachedVersion.version;
  try {
    const { version, isLatest } = await fetchLatestWaWebVersion({});
    if (isLatest) {
      cachedVersion = { version, at: Date.now() };
      logger.info({ version: version.join('.') }, 'versión de WA Web vigente');
    }
    return version;
  } catch (err) {
    logger.warn({ err }, 'no se pudo consultar la versión de WA Web; uso la de Baileys');
    return cachedVersion?.version;
  }
}

export interface BaileysFactoryOptions {
  proxyUrl?: string | undefined;
  /** 'chrome' = WhatsApp Web (por defecto) · 'desktop' = WhatsApp Desktop (hoy WhatsApp lo rechaza) */
  browser?: 'chrome' | 'desktop';
  /** 'latest' = versión vigente de WA Web · 'bundled' = la de Baileys */
  version?: 'latest' | 'bundled';
  /** expone sendText (solo texto) antes de cerrar el candado; lo demás sigue bloqueado */
  allowSend?: boolean;
  /** expone reuploadMedia: pedirle al teléfono del dueño que re-suba media vencida */
  allowMediaRetry?: boolean;
}

export function createBaileysFactory(opts: BaileysFactoryOptions = {}): SocketFactory {
  const agent = opts.proxyUrl ? new HttpsProxyAgent(opts.proxyUrl) : undefined;

  return async ({ auth, logger }) => {
    const version = opts.version === 'bundled' ? undefined : await resolveVersion(logger);
    const sock = makeWASocket({
      auth: {
        creds: auth.state.creds,
        keys: makeCacheableSignalKeyStore(auth.state.keys, logger),
      },
      logger,
      ...(version ? { version } : {}),
      // Nos presentamos como WhatsApp Web en Chrome. Como 'Desktop' el teléfono entregaría
      // más historial, pero hoy WhatsApp corta la conexión al registrar (428).
      browser: opts.browser === 'desktop' ? Browsers.macOS('Desktop') : Browsers.macOS('Chrome'),
      syncFullHistory: true,
      shouldSyncHistoryMessage: () => true,
      // Bajo perfil: no aparecemos "en línea" y el teléfono sigue recibiendo notificaciones
      markOnlineOnConnect: false,
      emitOwnEvents: false,
      generateHighQualityLinkPreview: false,
      // No guardamos mensajes en el Sprint 1; Baileys solo lo usa para reenvíos (que no hacemos)
      getMessage: async () => undefined,
      ...(agent ? { agent, fetchAgent: agent } : {}),
    });

    // Única puerta de salida: guardamos el envío original ANTES del candado y solo
    // exponemos texto plano. La sesión decide quién y cuánto puede enviar.
    const original = opts.allowSend ? sock.sendMessage : null;
    const reupload = opts.allowMediaRetry ? sock.updateMediaMessage : null;
    const blocked = enforceReadOnly(sock);
    if (reupload) {
      (sock as unknown as WaSocketLike).reuploadMedia = (m) => reupload(m as WAMessage);
    }
    if (original) {
      (sock as unknown as WaSocketLike).sendText = (jid, text) => original(jid, { text });
      (sock as unknown as WaSocketLike).sendMedia = (jid, m) => original(jid, toContent(m));
    }
    logger.debug({ blocked: blocked.length }, 'candado de solo lectura aplicado');
    return sock as unknown as WaSocketLike;
  };
}

/** arma el contenido de Baileys para un archivo saliente (sin reenvíos ni menciones) */
export function toContent(m: OutgoingMedia): AnyMessageContent {
  const caption = m.caption?.trim() || undefined;
  switch (m.kind) {
    case 'image':
      return { image: m.data, mimetype: m.mimetype, ...(caption ? { caption } : {}) };
    case 'video':
      return { video: m.data, mimetype: m.mimetype, ...(caption ? { caption } : {}) };
    case 'audio':
      return { audio: m.data, mimetype: m.mimetype };
    default:
      return {
        document: m.data,
        mimetype: m.mimetype,
        fileName: m.fileName,
        ...(caption ? { caption } : {}),
      };
  }
}

/**
 * Baja y descifra la media de un mensaje guardado desde el CDN de WhatsApp (HTTPS).
 * Si el archivo expiró y la sesión lo permite (solo el dueño), le pide a su propio
 * teléfono que lo vuelva a subir; si no, falla y se muestra la miniatura.
 */
export function createMediaDownloader(logger: Logger): MediaDownloader {
  const download = (m: unknown) => downloadMediaMessage(m as WAMessage, 'buffer', {}, undefined);
  return async (raw, opts) => {
    // lo guardado pasó por JSON: las llaves binarias pueden venir como base64
    const message = withBinaryKeys(raw);
    try {
      return await download(message);
    } catch (err) {
      // Baileys solo reintenta si error.status es 404/410, pero su Boom trae el código en
      // output.statusCode: lo detectamos nosotros y pedimos la re-subida al teléfono.
      if (!opts?.reupload || !isExpiredMedia(err)) throw err;
      logger.info({ key: (message as WAMessage).key?.id }, 'media vencida: se la pido al teléfono');
      const updated = (await opts.reupload(message)) as WAMessage;
      return download(withBinaryKeys(updated));
    }
  };
}

/**
 * 403/404/410 del CDN = el enlace venció (403, el parámetro `oe`) o el archivo ya no
 * está (404/410): hay que pedir la re-subida.
 */
export function isExpiredMedia(err: unknown): boolean {
  const code = mediaErrorStatus(err);
  return code === 403 || code === 404 || code === 410;
}

export function mediaErrorStatus(err: unknown): number | null {
  const e = err as { status?: number; output?: { statusCode?: number } } | null;
  return e?.output?.statusCode ?? e?.status ?? null;
}

/** campos binarios de un mensaje con media que Baileys necesita como Buffer */
const BINARY_FIELDS = new Set(['mediaKey', 'fileSha256', 'fileEncSha256', 'jpegThumbnail']);

/**
 * Copia del mensaje con los campos binarios como Buffer. Si quedaron como texto base64
 * (al serializar el protobuf), la petición de re-subida no se puede descifrar.
 */
export function withBinaryKeys<T>(value: T, depth = 0): T {
  if (!value || typeof value !== 'object' || Buffer.isBuffer(value) || depth > 8) return value;
  if (Array.isArray(value)) return value.map((v) => withBinaryKeys(v, depth + 1)) as T;
  if (value instanceof Uint8Array) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (BINARY_FIELDS.has(k) && typeof v === 'string') out[k] = Buffer.from(v, 'base64');
    else if (BINARY_FIELDS.has(k) && v instanceof Uint8Array && !Buffer.isBuffer(v))
      out[k] = Buffer.from(v);
    else out[k] = withBinaryKeys(v, depth + 1);
  }
  return out as T;
}
