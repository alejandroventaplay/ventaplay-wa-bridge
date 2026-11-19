import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Cipher } from '../src/crypto.js';
import { IntegrationStore, maskKey } from '../src/settings/integrations.js';
import { TEST_KEY } from './helpers.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function store(env: NodeJS.ProcessEnv = {}, fetchFn?: typeof fetch) {
  const dir = await mkdtemp(join(tmpdir(), 'wa-bridge-int-'));
  dirs.push(dir);
  const file = join(dir, 'integraciones.enc');
  const s = new IntegrationStore(file, new Cipher(TEST_KEY), env, fetchFn);
  await s.init();
  return { s, file };
}

const FAKE = 'sk-ant-api03-clave-de-prueba-0000000000000000';

describe('IntegrationStore', () => {
  it('guarda cifrado y nunca devuelve la clave completa en la lista', async () => {
    const { s, file } = await store();
    const v = await s.set('anthropic', `  ${FAKE}  `);
    expect(v.source).toBe('config');
    expect(v.masked).toBe(maskKey(FAKE));
    expect(JSON.stringify(s.list())).not.toContain(FAKE);
    expect((await readFile(file)).toString('latin1')).not.toContain('sk-ant');
    expect(s.get('anthropic')).toBe(FAKE);

    // sobrevive un reinicio
    const again = new IntegrationStore(file, new Cipher(TEST_KEY), {});
    await again.init();
    expect(again.get('anthropic')).toBe(FAKE);
  });

  it('cae al entorno si no hay clave guardada, y la de Configuración manda', async () => {
    const { s } = await store({ OPENAI_API_KEY: 'sk-desde-env-123456' });
    expect(s.list().find((x) => x.id === 'openai')?.source).toBe('env');
    expect(s.get('openai')).toBe('sk-desde-env-123456');
    await s.set('openai', 'sk-proj-desde-config-999');
    expect(s.get('openai')).toBe('sk-proj-desde-config-999');
    await s.remove('openai');
    expect(s.get('openai')).toBe('sk-desde-env-123456');
  });

  it('avisa si la clave no tiene el formato del proveedor', async () => {
    const { s } = await store();
    const v = await s.set('openai', FAKE.replace('sk-ant-', 'xx-'));
    expect(v.warning).toMatch(/sk-/);
  });

  it('rechaza integraciones desconocidas y claves vacías o con espacios', async () => {
    const { s } = await store();
    await expect(s.set('nada', 'x')).rejects.toMatchObject({ statusCode: 404 });
    await expect(s.set('openai', '   ')).rejects.toMatchObject({ statusCode: 400 });
    await expect(s.set('openai', 'sk- con espacio')).rejects.toMatchObject({ statusCode: 400 });
  });

  it('prueba la clave con la lista de modelos del proveedor', async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, headers: init.headers as Record<string, string> });
      return new Response('{}', { status: url.includes('anthropic') ? 200 : 401 });
    }) as unknown as typeof fetch;
    const { s } = await store({}, fakeFetch);
    expect((await s.test('anthropic')).message).toMatch(/No hay clave/);
    await s.set('anthropic', FAKE);
    await s.set('openai', 'sk-proj-mala-123456');
    expect(await s.test('anthropic')).toMatchObject({ ok: true });
    expect(await s.test('openai')).toMatchObject({ ok: false });
    expect(calls[0]?.headers['x-api-key']).toBe(FAKE);
    expect(calls[1]?.headers.authorization).toBe('Bearer sk-proj-mala-123456');
  });
});
