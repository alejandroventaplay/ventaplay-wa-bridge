import { afterEach, describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import { loadConfig } from '../src/config.js';
import { createAuthenticator } from '../src/http/auth.js';
import { buildServer } from '../src/http/server.js';
import { SessionManager } from '../src/session/manager.js';
import { createSimulator } from '../src/wa/simulator.js';
import { silentLogger, tempStore } from './helpers.js';

const TOKEN = 'token-de-prueba-ventaplay-123';
const JWT_SECRET = 'super-secreto-supabase-de-prueba-1234567890';
const SUPABASE_URL = 'https://demo.supabase.co';

let cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

async function setup(env: Record<string, string> = {}) {
  const config = loadConfig({ NODE_ENV: 'test', API_TOKEN: TOKEN, WA_DRIVER: 'simulator', ...env });
  const t = await tempStore();
  const sim = createSimulator({
    firstQrMs: 10,
    qrRotateMs: 5000,
    maxQrs: 3,
    openMs: 20,
    batchEveryMs: 15,
  });
  const manager = new SessionManager({
    store: t.store,
    socketFactory: sim.factory,
    logger: silentLogger,
    maxSessions: 5,
    wipeOnLogout: true,
  });
  await manager.init();
  const app = await buildServer({
    config,
    manager,
    auth: createAuthenticator(config),
    logger: silentLogger,
    storageKind: 'file',
    simulator: sim,
  });
  cleanups.push(
    t.cleanup,
    () => manager.shutdown(),
    () => app.close(),
  );
  return { app, manager, store: t.store };
}

const auth = { authorization: `Bearer ${TOKEN}` };

describe('API HTTP', () => {
  it('/health es público y declara solo lectura', async () => {
    const { app } = await setup();
    const r = await app.inject({ method: 'GET', url: '/health' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({
      ok: true,
      readOnly: true,
      driver: 'simulator',
      auth: 'token',
    });
  });

  it('rechaza sin token o con token malo', async () => {
    const { app } = await setup();
    expect((await app.inject({ method: 'GET', url: '/sessions' })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/sessions',
          headers: { authorization: 'Bearer nop' },
        })
      ).statusCode,
    ).toBe(401);
  });

  it('crea, consulta, conecta por simulador, desvincula y elimina', async () => {
    const { app } = await setup();
    const created = await app.inject({
      method: 'POST',
      url: '/sessions',
      headers: auth,
      payload: { label: 'Cliente X' },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().session.id as string;
    expect(created.json().session).toMatchObject({ label: 'Cliente X', readOnly: true });

    const get = async () =>
      (await app.inject({ method: 'GET', url: `/sessions/${id}`, headers: auth })).json().session;
    for (let i = 0; i < 100 && (await get()).status !== 'qr'; i++)
      await new Promise((r) => setTimeout(r, 20));
    expect((await get()).qr.dataUrl).toMatch(/^data:image\/png/);

    expect(
      (await app.inject({ method: 'POST', url: `/sessions/${id}/simulate-scan`, headers: auth }))
        .statusCode,
    ).toBe(200);
    for (let i = 0; i < 150 && (await get()).status !== 'connected'; i++)
      await new Promise((r) => setTimeout(r, 20));
    expect((await get()).profile.phone).toBe('56912345678');

    const list = await app.inject({ method: 'GET', url: '/sessions', headers: auth });
    expect(list.json().sessions).toHaveLength(1);

    const out = await app.inject({ method: 'POST', url: `/sessions/${id}/logout`, headers: auth });
    expect(out.json().session.status).toBe('logged_out');

    expect(
      (await app.inject({ method: 'DELETE', url: `/sessions/${id}`, headers: auth })).statusCode,
    ).toBe(204);
    expect(
      (await app.inject({ method: 'GET', url: `/sessions/${id}`, headers: auth })).statusCode,
    ).toBe(404);
  });

  it('exporta los contactos a Excel solo con sesión iniciada', async () => {
    const { app, store } = await setup();
    const id = (
      await app.inject({
        method: 'POST',
        url: '/sessions',
        headers: auth,
        payload: { label: 'Cliente Y' },
      })
    ).json().session.id as string;
    const get = async () =>
      (await app.inject({ method: 'GET', url: `/sessions/${id}`, headers: auth })).json().session;
    for (let i = 0; i < 100 && (await get()).status !== 'qr'; i++)
      await new Promise((r) => setTimeout(r, 20));
    await app.inject({ method: 'POST', url: `/sessions/${id}/simulate-scan`, headers: auth });
    for (let i = 0; i < 200 && (await get()).stats.batches < 5; i++)
      await new Promise((r) => setTimeout(r, 20));

    // un par LID → número que Baileys guardó en sus llaves se suma al exportar
    await store.writeAuth(id, {
      'lid-mapping:999999999999_reverse': JSON.stringify('56977778888'),
    });
    const before = (await get()).stats.lidMappings as number;
    const preview = (
      await app.inject({ method: 'GET', url: `/sessions/${id}/export/preview`, headers: auth })
    ).json();
    expect(preview).toMatchObject({ total: 48, noPhone: 0, groups: 6 });
    expect(preview.useful).toBeGreaterThan(0);
    for (let i = 0; i < 50 && (await get()).stats.lidMappings === before; i++)
      await new Promise((r) => setTimeout(r, 20));
    expect((await get()).stats.lidMappings).toBe(before + 1);

    const url = `/sessions/${id}/export/contacts.xlsx`;
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
    const r = await app.inject({ method: 'GET', url, headers: auth });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('spreadsheetml');
    expect(r.headers['content-disposition']).toMatch(
      /attachment; filename="contactos-util-cliente-y-/,
    );
    const full = await app.inject({ method: 'GET', url: `${url}?modo=completo`, headers: auth });
    expect(full.headers['content-disposition']).toMatch(/filename="contactos-cliente-y-/);
    expect(
      (await app.inject({ method: 'GET', url: `${url}?modo=raro`, headers: auth })).statusCode,
    ).toBe(400);
    // un .xlsx es un zip
    expect(r.rawPayload.subarray(0, 2).toString()).toBe('PK');
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/sessions/nope/export/contacts.xlsx',
          headers: auth,
        })
      ).statusCode,
    ).toBeGreaterThanOrEqual(400);
  });

  it('valida ids y cuerpos', async () => {
    const { app } = await setup();
    expect(
      (await app.inject({ method: 'GET', url: '/sessions/../../etc', headers: auth })).statusCode,
    ).toBeGreaterThanOrEqual(400);
    expect(
      (await app.inject({ method: 'GET', url: '/sessions/no-es-uuid', headers: auth })).statusCode,
    ).toBe(400);
    const long = await app.inject({
      method: 'POST',
      url: '/sessions',
      headers: auth,
      payload: { label: 'x'.repeat(200) },
    });
    expect(long.statusCode).toBe(400);
  });

  it('el stream SSE manda el snapshot inicial y los cambios (token por query)', async () => {
    const { app } = await setup();
    const id = (
      await app.inject({ method: 'POST', url: '/sessions', headers: auth, payload: {} })
    ).json().session.id;
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const ctrl = new AbortController();
    const res = await fetch(`${address}/sessions/${id}/events?access_token=${TOKEN}`, {
      signal: ctrl.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    let buf = '';
    const dec = new TextDecoder();
    const deadline = Date.now() + 3000;
    while (!buf.includes('"status":"qr"') && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value);
    }
    ctrl.abort();
    expect(buf).toContain('event: snapshot');
    expect(buf).toContain('"status":"qr"');
  });
});

describe('auth con Supabase', () => {
  const sign = (claims: Record<string, unknown>) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(`${SUPABASE_URL}/auth/v1`)
      .setSubject('user-1')
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(JWT_SECRET));

  it('acepta solo correos del dominio permitido', async () => {
    const { app } = await setup({ SUPABASE_URL, SUPABASE_JWT_SECRET: JWT_SECRET, API_TOKEN: '' });
    const ok = await sign({ role: 'authenticated', email: 'Alejandro@VentaPlay.com' });
    const otro = await sign({ role: 'authenticated', email: 'alguien@gmail.com' });
    const anon = await sign({ role: 'anon', email: 'x@ventaplay.com' });
    const me = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: `Bearer ${ok}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().principal).toMatchObject({
      via: 'supabase',
      email: 'alejandro@ventaplay.com',
    });
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/me',
          headers: { authorization: `Bearer ${otro}` },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/me',
          headers: { authorization: `Bearer ${anon}` },
        })
      ).statusCode,
    ).toBe(401);
  });
});

describe('config', () => {
  it('en producción exige clave de cifrado, auth y prohíbe el simulador', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/ENCRYPTION_KEY/);
    expect(() => loadConfig({ NODE_ENV: 'production', ENCRYPTION_KEY: 'a'.repeat(64) })).toThrow(
      /SUPABASE_URL o API_TOKEN/,
    );
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        ENCRYPTION_KEY: 'a'.repeat(64),
        API_TOKEN: TOKEN,
        WA_DRIVER: 'simulator',
      }),
    ).toThrow(/simulator/);
  });

  it('por defecto se presenta como WhatsApp Web en Chrome y usa los puertos locales', () => {
    const c = loadConfig({});
    expect(c.WA_BROWSER).toBe('chrome');
    expect(c.WA_VERSION).toBe('latest');
    expect(c.PORT).toBe(4010);
    expect(c.webOrigins).toContain('http://localhost:5190');
    expect(() => loadConfig({ WA_BROWSER: 'firefox' })).toThrow();
  });
});

describe('seguridad del token', () => {
  it('el token por query solo vale en los streams SSE', async () => {
    const { app } = await setup();
    expect(
      (await app.inject({ method: 'GET', url: `/sessions?access_token=${TOKEN}` })).statusCode,
    ).toBe(401);
    expect((await app.inject({ method: 'GET', url: `/me?access_token=${TOKEN}` })).statusCode).toBe(
      401,
    );
  });

  it('app.close() no queda colgado con streams SSE abiertos', async () => {
    const { app } = await setup();
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const res = await fetch(`${address}/events?access_token=${TOKEN}`);
    expect(res.status).toBe(200);
    const t0 = Date.now();
    await app.close();
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
