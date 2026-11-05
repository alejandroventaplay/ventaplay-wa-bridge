import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import type { Config } from '../config.js';
import type { SessionManager } from '../session/manager.js';

/** lo que recibe una extensión local de la API */
export interface LocalApiContext {
  config: Config;
  manager: SessionManager;
  logger: Logger;
}

/** una extensión local exporta `register` y agrega rutas protegidas (ya pasaron el login) */
export interface LocalApiExtension {
  register(api: FastifyInstance, ctx: LocalApiContext): void | Promise<void>;
}

const EXT = /^[\w-]+\.(ts|js|mjs)$/;

/**
 * Extensiones locales opcionales de la API: archivos `privado/api/*.ts` en la raíz del repo.
 * Esa carpeta no se versiona (cada quien la ignora en su copia); si no existe, no hay nada.
 * Solo en desarrollo: en producción o en tests no se carga nada.
 */
export async function loadLocalExtensions(
  api: FastifyInstance,
  ctx: LocalApiContext,
  repoRoot: string | null,
): Promise<string[]> {
  if (ctx.config.NODE_ENV !== 'development' || !repoRoot) return [];
  const dir = join(repoRoot, 'privado', 'api');
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => EXT.test(f) && !f.endsWith('.d.ts')).sort();
  } catch {
    return [];
  }
  const log = ctx.logger.child({ mod: 'extensiones-locales' });
  const loaded: string[] = [];
  for (const file of files) {
    try {
      const mod = (await import(pathToFileURL(join(dir, file)).href)) as Partial<LocalApiExtension>;
      if (typeof mod.register !== 'function') continue;
      await mod.register(api, ctx);
      loaded.push(file);
    } catch (err) {
      log.warn({ err, file }, 'extensión local no cargó');
    }
  }
  if (loaded.length) log.info({ files: loaded }, 'extensiones locales cargadas');
  return loaded;
}
