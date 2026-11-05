import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { loadLocalExtensions } from '../src/dev/local-extensions.js';
import type { SessionManager } from '../src/session/manager.js';
import { silentLogger } from './helpers.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function repoWith(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'wa-ext-'));
  dirs.push(root);
  await mkdir(join(root, 'privado', 'api'), { recursive: true });
  for (const [name, src] of Object.entries(files))
    await writeFile(join(root, 'privado', 'api', name), src);
  return root;
}

const ctx = (NODE_ENV: 'development' | 'test' | 'production') => ({
  config: loadConfig({
    NODE_ENV,
    API_TOKEN: 'x'.repeat(16),
    ENCRYPTION_KEY: 'a'.repeat(64),
  }),
  manager: {} as SessionManager,
  logger: silentLogger,
});

const DEMO = `export function register(api) { api.get('/privado/demo', async () => ({ ok: true })); }`;

describe('extensiones locales de la API', () => {
  it('en desarrollo carga privado/api/*.mjs y registra sus rutas', async () => {
    const root = await repoWith({ 'demo.mjs': DEMO, 'nota.txt': 'no es código' });
    const app = Fastify();
    const loaded = await loadLocalExtensions(app, ctx('development'), root);
    expect(loaded).toEqual(['demo.mjs']);
    const res = await app.inject({ method: 'GET', url: '/privado/demo' });
    expect(res.json()).toEqual({ ok: true });
  });

  it('una extensión que falla no tumba la API', async () => {
    const root = await repoWith({ 'a.mjs': 'throw new Error("rota")', 'b.mjs': DEMO });
    const app = Fastify();
    expect(await loadLocalExtensions(app, ctx('development'), root)).toEqual(['b.mjs']);
  });

  it('en tests, producción o sin carpeta no carga nada', async () => {
    const root = await repoWith({ 'demo.mjs': DEMO });
    expect(await loadLocalExtensions(Fastify(), ctx('test'), root)).toEqual([]);
    expect(await loadLocalExtensions(Fastify(), ctx('development'), null)).toEqual([]);
    const empty = await mkdtemp(join(tmpdir(), 'wa-ext-'));
    dirs.push(empty);
    expect(await loadLocalExtensions(Fastify(), ctx('development'), empty)).toEqual([]);
  });
});
