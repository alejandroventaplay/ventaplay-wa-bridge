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
import { enforceReadOnly, ReadOnlyViolation } from './read-only.js';
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
    const blocked = enforceReadOnly(sock);
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
 * Si el archivo expiró, NO le pedimos al teléfono que lo vuelva a subir: eso es una
 * escritura (updateMediaMessage) y está bloqueada.
 */
export function createMediaDownloader(logger: Logger): MediaDownloader {
  return (message) =>
    downloadMediaMessage(
      message as WAMessage,
      'buffer',
      {},
      {
        logger,
        reuploadRequest: () => Promise.reject(new ReadOnlyViolation('updateMediaMessage')),
      },
    );
}
