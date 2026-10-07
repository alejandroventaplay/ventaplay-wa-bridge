import makeWASocket, {
  Browsers,
  fetchLatestWaWebVersion,
  makeCacheableSignalKeyStore,
  type WAVersion,
} from 'baileys';
import { HttpsProxyAgent } from 'https-proxy-agent';
import type { Logger } from 'pino';
import { enforceReadOnly } from './read-only.js';
import type { SocketFactory, WaSocketLike } from './types.js';

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

export function createBaileysFactory(opts: { proxyUrl?: string | undefined }): SocketFactory {
  const agent = opts.proxyUrl ? new HttpsProxyAgent(opts.proxyUrl) : undefined;

  return async ({ auth, logger }) => {
    const version = await resolveVersion(logger);
    const sock = makeWASocket({
      auth: {
        creds: auth.state.creds,
        keys: makeCacheableSignalKeyStore(auth.state.keys, logger),
      },
      logger,
      ...(version ? { version } : {}),
      // Nos presentamos como WhatsApp Desktop: así el teléfono entrega el historial completo
      browser: Browsers.macOS('Desktop'),
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

    const blocked = enforceReadOnly(sock);
    logger.debug({ blocked: blocked.length }, 'candado de solo lectura aplicado');
    return sock as unknown as WaSocketLike;
  };
}
