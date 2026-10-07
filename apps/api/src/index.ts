import { join } from 'node:path';
import pino from 'pino';
import { loadConfig } from './config.js';
import { Cipher, resolveDevKey } from './crypto.js';
import { createAuthenticator } from './http/auth.js';
import { buildServer } from './http/server.js';
import { SessionManager } from './session/manager.js';
import { FileSessionStore } from './store/file-store.js';
import { PgSessionStore } from './store/pg-store.js';
import type { SessionStore } from './store/types.js';
import { createBaileysFactory } from './wa/baileys-socket.js';
import { createSimulator } from './wa/simulator.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = pino({
    level: config.LOG_LEVEL,
    redact: ['req.headers.authorization'],
    serializers: {
      // sin query string: en los streams SSE ahí viaja el token
      req: (req: { method?: string; url?: string; id?: string }) => ({
        id: req.id,
        method: req.method,
        url: req.url?.split('?')[0],
      }),
    },
  });

  // ---- cifrado
  let keyHex = config.ENCRYPTION_KEY;
  if (!keyHex) {
    const dev = await resolveDevKey(join(config.DATA_DIR, '.dev-encryption-key'));
    keyHex = dev.key;
    logger.warn(
      { generated: dev.generated },
      'ENCRYPTION_KEY no definida: usando una clave local de desarrollo (no usar en producción)',
    );
  }
  const cipher = new Cipher(keyHex);

  // ---- almacenamiento
  const store: SessionStore =
    config.STORAGE === 'postgres'
      ? new PgSessionStore(config.DATABASE_URL!, cipher)
      : new FileSessionStore(config.DATA_DIR, cipher);
  await store.init();

  // ---- WhatsApp
  const simulator = config.WA_DRIVER === 'simulator' ? createSimulator() : null;
  const socketFactory = simulator
    ? simulator.factory
    : createBaileysFactory({ proxyUrl: config.WA_PROXY_URL });

  const manager = new SessionManager({
    store,
    socketFactory,
    logger,
    maxSessions: config.MAX_SESSIONS,
    wipeOnLogout: config.WIPE_ON_LOGOUT,
  });

  const auth = createAuthenticator(config);
  if (auth.mode === 'none') {
    logger.warn(
      'API sin autenticación (define API_TOKEN o SUPABASE_URL). Solo aceptable en local.',
    );
  }

  const app = await buildServer({
    config,
    manager,
    auth,
    logger,
    storageKind: store.kind,
    simulator,
  });
  await manager.init();
  await app.listen({ host: config.HOST, port: config.PORT });
  logger.info(
    { port: config.PORT, driver: config.WA_DRIVER, storage: store.kind, auth: auth.mode },
    'VentaPlay WA Bridge listo (solo lectura)',
  );

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    logger.info({ signal }, 'apagando: cierro sockets sin desvincular');
    await app.close().catch(() => {});
    await manager.shutdown();
    await store.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
