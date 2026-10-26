import { Writable } from 'node:stream';
import ExcelJS from 'exceljs';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionSummary, VentaPlayState } from '@wa-bridge/shared';
import { loadConfig } from '../src/config.js';
import { createAuthenticator } from '../src/http/auth.js';
import { buildServer } from '../src/http/server.js';
import { SessionManager } from '../src/session/manager.js';
import { MIGRATION_KEY_PREFIX, MigrationVault } from '../src/session/migration-vault.js';
import { buildItems, messageText } from '../src/ventaplay/plan.js';
import { VentaPlayService } from '../src/ventaplay/service.js';
import { createSimulator } from '../src/wa/simulator.js';
import { tempStore, waitFor } from './helpers.js';

const TOKEN = 'token-de-prueba-ventaplay-123';
const auth = { authorization: `Bearer ${TOKEN}` };
const ORG_KEY = 'vp-api-key-super-secreta-0123456789';

let cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

interface Call {
  endpoint: string;
  auth: string | null;
  body: { dry_run?: boolean; items?: Record<string, unknown>[]; on_conflict?: string };
}

/** VentaPlay simulado: guarda las llamadas y responde como las APIs import-* */
function fakeVentaPlay(
  opts: {
    rateLimitMessagesOnce?: boolean;
    badKey?: boolean;
    failRealClients?: boolean;
    failRealMessages?: boolean;
  } = {},
) {
  const calls: Call[] = [];
  let limited = Boolean(opts.rateLimitMessagesOnce);
  const reply = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    const endpoint = String(url).split('/').pop()!;
    const body = JSON.parse(String(init?.body ?? '{}')) as Call['body'];
    const headers = new Headers(init?.headers);
    calls.push({ endpoint, auth: headers.get('authorization'), body });
    if (opts.badKey)
      return reply(401, { success: false, code: 'UNAUTHORIZED', error: 'API key inválida' });
    if (endpoint === 'get-organizations')
      return reply(200, {
        success: true,
        organizacion: { id: 'org-1', nombre: 'Javier Sotomayor SPA', subdominio: 'talleralcien' },
      });
    if (endpoint === 'import-messages' && limited && !body.dry_run) {
      limited = false;
      return reply(429, { success: false, code: 'IMPORT_RATE_LIMITED', error: 'cupo' });
    }
    const items = body.items ?? [];
    if (
      (opts.failRealClients && endpoint === 'import-clients' && !body.dry_run) ||
      (opts.failRealMessages && endpoint === 'import-messages' && !body.dry_run)
    )
      return reply(200, {
        success: true,
        resultados: items.map((it) => ({
          external_id: it.external_id,
          status: 'error',
          code: 'INTERNAL',
          detalle: 'falla de prueba',
        })),
      });
    return reply(200, {
      success: true,
      resultados: items.map((it, i) => ({
        external_id: it.external_id,
        // en clientes, el primero de cada lote "ya existía"
        status: endpoint === 'import-clients' && i === 0 ? 'updated' : 'created',
        detalle: body.dry_run ? 'dry-run' : '',
      })),
    });
  }) as typeof fetch;
  return { calls, fetchFn };
}

async function setup(vp = fakeVentaPlay()) {
  const config = loadConfig({ NODE_ENV: 'test', API_TOKEN: TOKEN, WA_DRIVER: 'simulator' });
  const t = await tempStore();
  const sim = createSimulator({
    firstQrMs: 10,
    qrRotateMs: 5000,
    maxQrs: 3,
    openMs: 20,
    batchEveryMs: 15,
  });
  const logs: string[] = [];
  const logger = pino(
    { level: 'info' },
    new Writable({
      write(chunk, _enc, cb) {
        logs.push(String(chunk));
        cb();
      },
    }),
  );
  const manager = new SessionManager({
    store: t.store,
    socketFactory: sim.factory,
    logger,
    maxSessions: 5,
    wipeOnLogout: true,
    ownerPhone: null,
  });
  await manager.init();
  const ventaplay = new VentaPlayService({
    getSession: (id) => manager.get(id),
    logger,
    fetch: vp.fetchFn,
    retryDelayMs: 0,
  });
  const app = await buildServer({
    config,
    manager,
    auth: createAuthenticator(config),
    logger,
    storageKind: 'file',
    simulator: sim,
    ventaplay,
  });
  cleanups.push(
    t.cleanup,
    () => manager.shutdown(),
    () => app.close(),
  );
  const created = await app.inject({
    method: 'POST',
    url: '/sessions',
    headers: auth,
    payload: {},
  });
  const id = (created.json() as { session: SessionSummary }).session.id;
  await waitFor(() => manager.get(id).status === 'qr', 3000, 'QR');
  return { app, manager, store: t.store, id, sim, vp, logs };
}

async function linkWithMigration(s: Awaited<ReturnType<typeof setup>>) {
  const r = await s.app.inject({
    method: 'POST',
    url: `/sessions/${s.id}/migration`,
    headers: auth,
    payload: { enabled: true, consentBy: 'Javier Sotomayor' },
  });
  expect(r.statusCode).toBe(200);
  const m = (r.json() as { session: SessionSummary }).session.migration;
  expect(m).toMatchObject({ enabled: true, consentBy: 'Javier Sotomayor', awaitingLink: true });
  await waitFor(() => s.manager.get(s.id).status === 'qr', 3000, 'QR');
  s.sim.scan(s.id);
  await waitFor(() => s.manager.get(s.id).summary().stats.state === 'complete', 5000, 'historial');
  await waitFor(
    () => (s.manager.get(s.id).summary().migration?.messages ?? 0) > 0,
    3000,
    'migración',
  );
}

async function waitKeys(s: Awaited<ReturnType<typeof setup>>) {
  for (let i = 0; i < 200; i++) {
    if ((await s.store.listAuthKeys(s.id, MIGRATION_KEY_PREFIX)).length) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('no se guardaron las conversaciones');
}

async function readXlsx(buf: Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  return wb;
}

const colOf = (ws: ExcelJS.Worksheet, name: string) => {
  const values = ws.getRow(1).values as unknown[];
  const i = values.indexOf(name);
  if (i < 1) throw new Error(`no está la columna ${name}`);
  return i;
};

describe('modo migración', () => {
  it('sin el modo, un número que no es el dueño no guarda conversaciones', async () => {
    const s = await setup();
    s.sim.scan(s.id);
    await waitFor(
      () => s.manager.get(s.id).summary().stats.state === 'complete',
      5000,
      'historial',
    );
    expect(s.manager.get(s.id).summary().migration).toBeNull();
    expect(await s.store.listAuthKeys(s.id, MIGRATION_KEY_PREFIX)).toEqual([]);
    const r = await s.app.inject({
      url: `/sessions/${s.id}/export/conversations.xlsx`,
      headers: auth,
    });
    expect(r.statusCode).toBe(409);
  });

  it('con el modo: guarda todo cifrado y exporta Chats y Mensajes unidos al Excel de contactos', async () => {
    const s = await setup();
    await linkWithMigration(s);
    const info = s.manager.get(s.id).summary().migration!;
    expect(info.awaitingLink).toBe(false);
    expect(info.chats).toBeGreaterThan(0);
    await waitKeys(s);

    const conv = await s.app.inject({
      url: `/sessions/${s.id}/export/conversations.xlsx`,
      headers: auth,
    });
    expect(conv.statusCode).toBe(200);
    expect(conv.headers['content-disposition']).toMatch(/conversaciones-.*\.xlsx/);
    const wb = await readXlsx(conv.rawPayload);
    const chats = wb.getWorksheet('Chats')!;
    const msgs = wb.getWorksheet('Mensajes')!;
    expect(msgs.rowCount - 1).toBe(info.messages);

    // cada mensaje apunta a un chat que existe
    const chatIds = new Set<string>();
    chats.eachRow((r, n) => n > 1 && chatIds.add(String(r.getCell(colOf(chats, 'ID chat')).value)));
    msgs.eachRow((r, n) => {
      if (n > 1) expect(chatIds.has(String(r.getCell(colOf(msgs, 'ID chat')).value))).toBe(true);
    });

    // los chats de personas se unen con el Excel de contactos por "ID contacto"
    const cont = await s.app.inject({
      url: `/sessions/${s.id}/export/contacts.xlsx?modo=completo`,
      headers: auth,
    });
    const cw = (await readXlsx(cont.rawPayload)).getWorksheet('Contactos')!;
    const contactIds = new Set<string>();
    cw.eachRow(
      (r, n) => n > 1 && contactIds.add(String(r.getCell(colOf(cw, 'ID contacto')).value)),
    );
    let linked = 0;
    chats.eachRow((r, n) => {
      if (n === 1 || r.getCell(colOf(chats, 'Tipo')).value !== 'persona') return;
      expect(contactIds.has(String(r.getCell(colOf(chats, 'ID contacto')).value))).toBe(true);
      linked += 1;
    });
    expect(linked).toBeGreaterThan(0);
  });

  it('al apagar el modo se borran las conversaciones guardadas', async () => {
    const s = await setup();
    await linkWithMigration(s);
    await waitKeys(s);
    const r = await s.app.inject({
      method: 'POST',
      url: `/sessions/${s.id}/migration`,
      headers: auth,
      payload: { enabled: false },
    });
    expect((r.json() as { session: SessionSummary }).session.migration).toBeNull();
    expect(await s.store.listAuthKeys(s.id, MIGRATION_KEY_PREFIX)).toEqual([]);
  });
});

describe('Directo a VentaPlay', () => {
  const poll = async (s: Awaited<ReturnType<typeof setup>>, phases: VentaPlayState['phase'][]) => {
    for (let i = 0; i < 500; i++) {
      const r = await s.app.inject({ url: `/sessions/${s.id}/ventaplay`, headers: auth });
      const st = (r.json() as { state: VentaPlayState }).state;
      if (phases.includes(st.phase)) return st;
      await new Promise((res) => setTimeout(res, 20));
    }
    throw new Error(
      'timeout esperando la importación: ' +
        JSON.stringify(
          (await s.app.inject({ url: `/sessions/${s.id}/ventaplay`, headers: auth })).json(),
        ).slice(0, 600),
    );
  };

  it('valida, prueba en seco e importa clientes y mensajes; el token no queda en el log', async () => {
    const s = await setup();
    await linkWithMigration(s);
    const v = await s.app.inject({
      method: 'POST',
      url: `/sessions/${s.id}/ventaplay/validate`,
      headers: auth,
      payload: { token: ORG_KEY, phoneNumberId: '1361032140419366' },
    });
    expect(v.statusCode).toBe(200);
    const st = (v.json() as { state: VentaPlayState }).state;
    expect(st.phase).toBe('validated');
    expect(st.org?.subdominio).toBe('talleralcien');
    expect(st.plan!.clientes).toBeGreaterThan(0);
    expect(st.plan!.mensajes).toBeGreaterThan(0);
    expect(st.plan!.soloContactos).toBe(false);
    // la validación no escribe nada
    expect(
      s.vp.calls.every((c) => c.endpoint === 'get-organizations' || c.body.dry_run === true),
    ).toBe(true);
    expect(s.vp.calls.every((c) => c.auth === `Bearer ${ORG_KEY}`)).toBe(true);

    const r = await s.app.inject({
      method: 'POST',
      url: `/sessions/${s.id}/ventaplay/import`,
      headers: auth,
    });
    expect(r.statusCode).toBe(200);
    const end = await poll(s, ['done', 'error', 'paused']);
    expect(end.phase).toBe('done');
    expect(end.result.clientes.errors).toBe(0);
    expect(end.result.clientes.created + end.result.clientes.updated).toBe(st.plan!.clientes);
    expect(end.result.mensajes.created).toBe(st.plan!.mensajes);

    const real = s.vp.calls.filter((c) => c.body.dry_run === false);
    // canario: el primer lote real de clientes son 5
    expect(real[0]!.endpoint).toBe('import-clients');
    expect(real[0]!.body.items!.length).toBe(Math.min(5, st.plan!.clientes));
    // valores_especiales solo en los que la prueba en seco anticipó como nuevos
    const dry = s.vp.calls.filter((c) => c.endpoint === 'import-clients' && c.body.dry_run);
    const existing = new Set(dry.map((c) => c.body.items![0]!.external_id));
    for (const c of real.filter((x) => x.endpoint === 'import-clients'))
      for (const it of c.body.items!)
        expect('valores_especiales' in it).toBe(!existing.has(it.external_id));
    for (const c of real) expect(c.body.items!.length).toBeLessThanOrEqual(500);
    // mensajes: entrantes en contacto_mensaje, salientes en organizacion_mensaje, nunca ambos
    for (const c of real.filter((x) => x.endpoint === 'import-messages'))
      for (const it of c.body.items!)
        expect(Boolean(it.contacto_mensaje) !== Boolean(it.organizacion_mensaje)).toBe(true);

    expect(s.logs.join('')).not.toContain(ORG_KEY);
  });

  it('si se agota el cupo queda en pausa y al retomar no repite lo ya cargado', async () => {
    const s = await setup(fakeVentaPlay({ rateLimitMessagesOnce: true }));
    await linkWithMigration(s);
    await s.app.inject({
      method: 'POST',
      url: `/sessions/${s.id}/ventaplay/validate`,
      headers: auth,
      payload: { token: ORG_KEY },
    });
    await s.app.inject({
      method: 'POST',
      url: `/sessions/${s.id}/ventaplay/import`,
      headers: auth,
    });
    const paused = await poll(s, ['paused', 'done', 'error']);
    expect(paused.phase).toBe('paused');
    expect(paused.pausedReason).toMatch(/cupo/);
    const clientCalls = s.vp.calls.filter(
      (c) => c.endpoint === 'import-clients' && !c.body.dry_run,
    ).length;

    await s.app.inject({
      method: 'POST',
      url: `/sessions/${s.id}/ventaplay/import`,
      headers: auth,
    });
    const end = await poll(s, ['done', 'error']);
    expect(end.phase).toBe('done');
    // ningún mensaje se pierde por la pausa
    expect(end.result.mensajes.created).toBe(end.plan!.mensajes);
    expect(
      s.vp.calls.filter((c) => c.endpoint === 'import-clients' && !c.body.dry_run).length,
    ).toBe(clientCalls);
  });

  it('una API key mala no avanza', async () => {
    const s = await setup(fakeVentaPlay({ badKey: true }));
    s.sim.scan(s.id);
    await waitFor(
      () => s.manager.get(s.id).summary().stats.state === 'complete',
      5000,
      'historial',
    );
    const v = await s.app.inject({
      method: 'POST',
      url: `/sessions/${s.id}/ventaplay/validate`,
      headers: auth,
      payload: { token: ORG_KEY },
    });
    const st = (v.json() as { state: VentaPlayState }).state;
    expect(st.phase).toBe('error');
    expect(st.error).toMatch(/API key/);
    const r = await s.app.inject({
      method: 'POST',
      url: `/sessions/${s.id}/ventaplay/import`,
      headers: auth,
    });
    expect(r.statusCode).toBe(409);
  });
});

describe('plan de importación', () => {
  const person = (phone: string | null, name: string | null) => ({
    jid: phone ? `${phone}@s.whatsapp.net` : '999@lid',
    phone,
    lid: phone ? null : '999@lid',
    displayName: name,
    savedName: name,
    pushName: null,
    businessName: null,
    inAddressBook: true,
    messages: 2,
    firstMessageAt: 1_700_000_000_000,
    lastMessageAt: 1_700_000_100_000,
  });

  it('solo personas con número; grupos y LID fuera; notas para archivos', () => {
    const msg = (
      id: string,
      kind: 'text' | 'image' | 'deleted',
      fromMe: boolean,
      text: string | null,
    ) => ({
      id,
      fromMe,
      ts: 1_700_000_000_000,
      kind,
      text,
      sender: null,
      pushName: null,
      media: kind === 'image' ? { mimetype: 'image/jpeg' } : null,
    });
    const items = buildItems(
      {
        sessionPhone: '56940000000',
        sessionName: 'Taller',
        directory: {
          people: [person('56911111111', 'Ana'), person(null, null), person('56922222222', null)],
          groups: [
            {
              jid: '1203@g.us',
              name: 'Grupo',
              messages: 1,
              firstMessageAt: null,
              lastMessageAt: null,
            },
          ],
        },
        chats: [
          {
            jid: '56911111111@s.whatsapp.net',
            messages: [
              msg('a', 'text', false, 'hola'),
              msg('b', 'image', true, 'mira'),
              msg('c', 'deleted', false, null),
            ],
          },
          { jid: '1203@g.us', messages: [msg('d', 'text', false, 'en el grupo')] },
        ],
      },
      '123',
    );
    expect(items.clients.map((c) => c.nombre)).toEqual(['Ana', 'Contacto WhatsApp']);
    expect(items.clients[0]!.phone_number_id).toBe('123');
    expect(items.sinNumero).toBe(1);
    expect(items.messages).toHaveLength(2);
    expect(items.messages[0]).toMatchObject({ contacto_mensaje: 'hola', tipo_mensaje: 'texto' });
    expect(items.messages[1]).toMatchObject({
      organizacion_mensaje: '[Imagen no migrada] mira',
      enviado_por: 'Taller',
      tipo_mensaje: 'imagen',
    });
    expect(items.mensajesFuera).toBe(1);
    expect(messageText({ ...msg('e', 'text', false, '   '), kind: 'text' })).toBeNull();
  });

  it('la bóveda de migración aplica ediciones y borrados y se recarga igual', () => {
    const v = new MigrationVault();
    const jid = '56911111111@s.whatsapp.net';
    const base = { key: { remoteJid: jid, fromMe: false }, messageTimestamp: 1_700_000_000 };
    v.add([
      { ...base, key: { ...base.key, id: 'm1' }, message: { conversation: 'uno' } },
      { ...base, key: { ...base.key, id: 'm2' }, message: { conversation: 'dos' } },
    ]);
    v.add([
      {
        ...base,
        key: { ...base.key, id: 'p1' },
        message: { protocolMessage: { type: 0, key: { id: 'm2' } } },
      },
    ]);
    expect(v.counts()).toEqual({ chats: 1, messages: 2 });
    const dirty = v.takeDirty();
    const copy = new MigrationVault();
    copy.load(new Map(Object.entries(dirty).filter((e): e is [string, string] => e[1] !== null)));
    const list = copy.entries()[0]![1];
    expect(list.map((m) => m.kind)).toEqual(['text', 'deleted']);
  });
});

describe('vincular con código', () => {
  it('pide un código de 8 caracteres para el número y desaparece al vincular', async () => {
    const s = await setup();
    const r = await s.app.inject({
      method: 'POST',
      url: `/sessions/${s.id}/pairing-code`,
      headers: auth,
      payload: { phone: '+56 9 1234 5678' },
    });
    expect(r.statusCode).toBe(200);
    const pairing = (r.json() as { session: SessionSummary }).session.pairing;
    expect(pairing?.code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(pairing?.phone).toBe('56912345678');
    expect(s.logs.join('')).not.toContain('56912345678');

    const bad = await s.app.inject({
      method: 'POST',
      url: `/sessions/${s.id}/pairing-code`,
      headers: auth,
      payload: { phone: 'sin-numero' },
    });
    expect(bad.statusCode).toBe(400);

    await waitFor(() => s.manager.get(s.id).status === 'qr', 3000, 'QR');
    s.sim.scan(s.id);
    await waitFor(() => s.manager.get(s.id).status === 'connected', 5000, 'vinculado');
    expect(s.manager.get(s.id).summary().pairing).toBeNull();
  });
});

describe('Directo a VentaPlay: casos borde', () => {
  const poll = async (s: Awaited<ReturnType<typeof setup>>, phases: VentaPlayState['phase'][]) => {
    for (let i = 0; i < 500; i++) {
      const r = await s.app.inject({ url: `/sessions/${s.id}/ventaplay`, headers: auth });
      const st = (r.json() as { state: VentaPlayState }).state;
      if (phases.includes(st.phase)) return st;
      await new Promise((res) => setTimeout(res, 20));
    }
    throw new Error(
      'timeout esperando la importación: ' +
        JSON.stringify(
          (await s.app.inject({ url: `/sessions/${s.id}/ventaplay`, headers: auth })).json(),
        ).slice(0, 600),
    );
  };

  it('si fallan los 5 de prueba se detiene y no deja retomar sin validar de nuevo', async () => {
    const s = await setup(fakeVentaPlay({ failRealClients: true }));
    await linkWithMigration(s);
    const v = await s.app.inject({
      method: 'POST',
      url: `/sessions/${s.id}/ventaplay/validate`,
      headers: auth,
      payload: { token: ORG_KEY },
    });
    const st = (v.json() as { state: VentaPlayState }).state;
    expect(st.plan!.historialCompleto).toBe(true);
    expect(st.canResume).toBe(true);
    await s.app.inject({
      method: 'POST',
      url: `/sessions/${s.id}/ventaplay/import`,
      headers: auth,
    });
    const end = await poll(s, ['error', 'done']);
    expect(end.phase).toBe('error');
    expect(end.canResume).toBe(false);
    expect(end.progress.clientes.done).toBe(5);
    expect(
      s.vp.calls.filter((c) => c.endpoint === 'import-messages' && !c.body.dry_run),
    ).toHaveLength(0);
    const again = await s.app.inject({
      method: 'POST',
      url: `/sessions/${s.id}/ventaplay/import`,
      headers: auth,
    });
    expect(again.statusCode).toBe(409);
  });

  it('si fallan los mensajes de prueba se detiene sin gastar el cupo', async () => {
    const s = await setup(fakeVentaPlay({ failRealMessages: true }));
    await linkWithMigration(s);
    await s.app.inject({
      method: 'POST',
      url: `/sessions/${s.id}/ventaplay/validate`,
      headers: auth,
      payload: { token: ORG_KEY },
    });
    await s.app.inject({
      method: 'POST',
      url: `/sessions/${s.id}/ventaplay/import`,
      headers: auth,
    });
    const end = await poll(s, ['error', 'done']);
    expect(end.phase).toBe('error');
    expect(end.canResume).toBe(false);
    const msgCalls = s.vp.calls.filter((c) => c.endpoint === 'import-messages' && !c.body.dry_run);
    expect(msgCalls).toHaveLength(1);
    expect(msgCalls[0]!.body.items!.length).toBeLessThanOrEqual(5);
  });

  it('sin agente conectado, enviar el código responde claro y no rompe nada', async () => {
    const s = await setup();
    const p = await s.app.inject({
      method: 'POST',
      url: `/sessions/${s.id}/pairing-code`,
      headers: auth,
      payload: { phone: '+56 9 4047 8363' },
    });
    expect(p.statusCode).toBe(200);
    const r = await s.app.inject({
      method: 'POST',
      url: `/sessions/${s.id}/pairing-code/send`,
      headers: auth,
    });
    expect(r.statusCode).toBe(409);
    expect((r.json() as { error: string }).error).toBe('no_agent');
    // el código sigue ahí para copiarlo a mano
    expect(s.manager.get(s.id).summary().pairing?.code).toBeTruthy();
  });

  it('enviar el código sin haberlo pedido responde claro', async () => {
    const s = await setup();
    const r = await s.app.inject({
      method: 'POST',
      url: `/sessions/${s.id}/pairing-code/send`,
      headers: auth,
    });
    expect(r.statusCode).toBe(409);
    expect((r.json() as { error: string }).error).toBe('no_code');
  });
});

describe('Actualizar: token guardado y registro de lo enviado', () => {
  const poll = async (s: Awaited<ReturnType<typeof setup>>, phases: VentaPlayState['phase'][]) => {
    for (let i = 0; i < 500; i++) {
      const r = await s.app.inject({ url: `/sessions/${s.id}/ventaplay`, headers: auth });
      const st = (r.json() as { state: VentaPlayState }).state;
      if (phases.includes(st.phase)) return st;
      await new Promise((res) => setTimeout(res, 20));
    }
    throw new Error(
      'timeout esperando la importación: ' +
        JSON.stringify(
          (await s.app.inject({ url: `/sessions/${s.id}/ventaplay`, headers: auth })).json(),
        ).slice(0, 600),
    );
  };
  const validate = async (s: Awaited<ReturnType<typeof setup>>, payload: object) =>
    (
      (
        await s.app.inject({
          method: 'POST',
          url: `/sessions/${s.id}/ventaplay/validate`,
          headers: auth,
          payload,
        })
      ).json() as { state: VentaPlayState }
    ).state;

  it('después de importar, "Actualizar" sin pegar el token no manda nada si no hay nuevo', async () => {
    const s = await setup();
    await linkWithMigration(s);
    const first = await validate(s, { token: ORG_KEY, phoneNumberId: '123' });
    expect(first.plan!.modo).toBe('completo');
    await s.app.inject({
      method: 'POST',
      url: `/sessions/${s.id}/ventaplay/import`,
      headers: auth,
    });
    const end = await poll(s, ['done', 'error']);
    expect(end.phase).toBe('done');
    expect(end.saved?.enviados).toEqual({
      clientes: first.plan!.clientes,
      mensajes: first.plan!.mensajes,
    });
    // cerrar no borra el token
    await s.app.inject({
      method: 'POST',
      url: `/sessions/${s.id}/ventaplay/forget`,
      headers: auth,
      payload: {},
    });
    const calls = s.vp.calls.length;
    const upd = await validate(s, {});
    expect(upd.plan!.modo).toBe('actualizar');
    expect(upd.plan!.filas).toBe(0);
    expect(upd.phase).toBe('done');
    expect(upd.phoneNumberId).toBe('123');
    // solo se consultó la org: no hubo prueba en seco ni importación
    expect(s.vp.calls.slice(calls).map((c) => c.endpoint)).toEqual(['get-organizations']);
    expect(s.vp.calls.at(-1)!.auth).toBe(`Bearer ${ORG_KEY}`);
  });

  it('el token y el registro sobreviven a un reinicio; "Olvidar token" lo borra', async () => {
    const s = await setup();
    await linkWithMigration(s);
    await validate(s, { token: ORG_KEY });
    await s.app.inject({
      method: 'POST',
      url: `/sessions/${s.id}/ventaplay/import`,
      headers: auth,
    });
    await poll(s, ['done', 'error']);
    // un servicio nuevo (como tras reiniciar la API) lee lo guardado
    const again = new VentaPlayService({
      getSession: (id) => s.manager.get(id),
      logger: pino({ level: 'silent' }),
      fetch: s.vp.fetchFn,
      retryDelayMs: 0,
    });
    const st = await again.validate(s.id, {});
    expect(st.plan!.modo).toBe('actualizar');
    expect(st.plan!.filas).toBe(0);
    expect(st.saved!.enviados.mensajes).toBeGreaterThan(0);
    const off = await again.forget(s.id, { token: true });
    expect(off.saved).toBeNull();
    await expect(again.validate(s.id, {})).rejects.toThrow(/API key/);
  });

  it('el registro inicial marca lo importado antes y "Actualizar" no lo repite', async () => {
    const s = await setup();
    await linkWithMigration(s);
    const r = await s.app.inject({
      method: 'POST',
      url: `/sessions/${s.id}/ventaplay/registry/seed`,
      headers: auth,
      payload: { org: 'org-1', until: Date.now() + 365 * 864e5 },
    });
    expect(r.statusCode).toBe(200);
    const marked = (r.json() as { marcados: { clientes: number; mensajes: number } }).marcados;
    expect(marked.mensajes).toBeGreaterThan(0);
    // sin token guardado, la pantalla igual muestra lo ya enviado
    const before = (
      (await s.app.inject({ url: `/sessions/${s.id}/ventaplay`, headers: auth })).json() as {
        state: VentaPlayState;
      }
    ).state;
    expect(before.saved).toBeNull();
    expect(before.previous).toEqual([
      expect.objectContaining({ org: 'org-1', mensajes: marked.mensajes }),
    ]);
    const st = await validate(s, { token: ORG_KEY, phoneNumberId: '123' });
    expect(st.plan!.modo).toBe('actualizar');
    expect(st.plan!.filas).toBe(0);
    expect(st.plan!.yaEnviados.mensajes).toBe(marked.mensajes);
    expect(st.saved?.phoneNumberId).toBe('123');
  });
});

describe('Actualizar: registro guardado con otra llave de la org', () => {
  it('lo encuentra por subdominio y no empieza de cero', async () => {
    const s = await setup();
    await linkWithMigration(s);
    await s.app.inject({
      method: 'POST',
      url: `/sessions/${s.id}/ventaplay/registry/seed`,
      headers: auth,
      payload: { org: 'talleralcien', until: Date.now() + 864e5, orgName: 'Javier Sotomayor SPA' },
    });
    const r = await s.app.inject({
      method: 'POST',
      url: `/sessions/${s.id}/ventaplay/validate`,
      headers: auth,
      payload: { token: ORG_KEY },
    });
    const st = (r.json() as { state: VentaPlayState }).state;
    expect(st.plan!.modo).toBe('actualizar');
    expect(st.plan!.filas).toBe(0);
  });
});
