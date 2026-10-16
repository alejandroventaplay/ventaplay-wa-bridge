import { afterEach, describe, expect, it } from 'vitest';
import type { PersonalChatList, PersonalChatMessages, SessionSummary } from '@wa-bridge/shared';
import { loadConfig } from '../src/config.js';
import { createAuthenticator } from '../src/http/auth.js';
import { buildServer } from '../src/http/server.js';
import { SessionManager } from '../src/session/manager.js';
import { VAULT_KEY_PREFIX } from '../src/session/message-vault.js';
import { createSimulator } from '../src/wa/simulator.js';
import { silentLogger, tempStore, waitFor } from './helpers.js';

const TOKEN = 'token-de-prueba-ventaplay-123';
const auth = { authorization: `Bearer ${TOKEN}` };
/** número del teléfono del simulador */
const SIM_PHONE = '+56 9 1234 5678';

let cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

async function setup(ownerPhone: string | null) {
  const config = loadConfig({ NODE_ENV: 'test', API_TOKEN: TOKEN, WA_DRIVER: 'simulator' });
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
    ownerPhone,
    downloadMedia: sim.downloadMedia,
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

  const created = await app.inject({
    method: 'POST',
    url: '/sessions',
    headers: auth,
    payload: {},
  });
  const id = (created.json() as { session: SessionSummary }).session.id;
  await waitFor(() => manager.get(id).status === 'qr', 3000, 'QR');
  sim.scan(id);
  await waitFor(
    () => manager.get(id).summary().stats.state === 'complete',
    5000,
    'historial completo',
  );
  return { app, manager, store: t.store, id };
}

describe('Mi vista', () => {
  it('con el número dueño: lista chats y grupos recientes y sus últimos mensajes', async () => {
    const { app, manager, id } = await setup(SIM_PHONE);
    expect(manager.get(id).summary().personal?.chats).toBeGreaterThan(0);

    const r = await app.inject({ url: `/sessions/${id}/personal/chats`, headers: auth });
    expect(r.statusCode).toBe(200);
    const list = r.json() as PersonalChatList;
    expect(list.groups).toBeGreaterThan(0);
    expect(list.individual).toBeGreaterThan(0);
    const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
    for (const c of list.items) {
      expect(c.lastMessageAt).toBeGreaterThanOrEqual(cutoff);
      expect(c.stored).toBeLessThanOrEqual(10);
    }
    // ordenados del más reciente al más antiguo
    const ts = list.items.map((c) => c.lastMessageAt);
    expect([...ts].sort((a, b) => b - a)).toEqual(ts);
    // con nombre de la agenda, no solo el número
    expect(list.items.some((c) => !c.isGroup && /\p{L}/u.test(c.name))).toBe(true);

    const group = list.items.find((c) => c.isGroup)!;
    const m = await app.inject({
      url: `/sessions/${id}/personal/chats/${encodeURIComponent(group.jid)}/messages`,
      headers: auth,
    });
    expect(m.statusCode).toBe(200);
    const body = m.json() as PersonalChatMessages;
    expect(body.messages.length).toBe(group.stored);
    expect(body.messages.some((x) => !x.fromMe && x.senderName)).toBe(true);
  });

  it('descarga la media de un mensaje', async () => {
    const { app, id } = await setup('56912345678');
    const list = (
      await app.inject({ url: `/sessions/${id}/personal/chats`, headers: auth })
    ).json() as PersonalChatList;
    for (const c of list.items) {
      const { messages } = (
        await app.inject({
          url: `/sessions/${id}/personal/chats/${encodeURIComponent(c.jid)}/messages`,
          headers: auth,
        })
      ).json() as PersonalChatMessages;
      const media = messages.find((x) => x.kind === 'image' || x.kind === 'voice');
      if (!media) continue;
      const r = await app.inject({
        url: `/sessions/${id}/personal/chats/${encodeURIComponent(c.jid)}/media/${media.id}`,
        headers: auth,
      });
      expect(r.statusCode).toBe(200);
      expect(r.headers['content-type']).toMatch(/svg|wav/);
      expect(r.rawPayload.length).toBeGreaterThan(40);
      return;
    }
    throw new Error('el simulador no generó media reciente');
  });

  it('con otro número no guarda nada y responde 403', async () => {
    const { app, manager, store, id } = await setup('56987654321');
    expect(manager.get(id).summary().personal).toBeNull();
    const r = await app.inject({ url: `/sessions/${id}/personal/chats`, headers: auth });
    expect(r.statusCode).toBe(403);
    await manager.get(id).flush();
    expect(await store.listAuthKeys(id, VAULT_KEY_PREFIX)).toHaveLength(0);
  });

  it('persiste cifrado, sobrevive al reinicio y se borra al desvincular', async () => {
    const { app, manager, store, id } = await setup('56912345678');
    await manager.shutdown();
    const keys = await store.listAuthKeys(id, VAULT_KEY_PREFIX);
    expect(keys.length).toBeGreaterThan(0);

    const m2 = new SessionManager({
      store,
      socketFactory: createSimulator({ openMs: 10 }).factory,
      logger: silentLogger,
      maxSessions: 5,
      wipeOnLogout: true,
      ownerPhone: '56912345678',
    });
    await m2.init();
    cleanups.push(() => m2.shutdown());
    await waitFor(() => m2.get(id).summary().personal?.chats, 3000, 'mensajes recargados');

    await m2.logout(id);
    expect(await store.listAuthKeys(id, VAULT_KEY_PREFIX)).toHaveLength(0);
    expect(m2.get(id).summary().personal).toBeNull();
    void app;
  });

  it('rechaza un chat inválido', async () => {
    const { app, id } = await setup('56912345678');
    const r = await app.inject({
      url: `/sessions/${id}/personal/chats/..%2F..%2Fetc/messages`,
      headers: auth,
    });
    expect(r.statusCode).toBe(400);
  });
});
