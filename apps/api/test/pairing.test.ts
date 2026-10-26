import { afterEach, describe, expect, it } from 'vitest';
import type { SessionSummary } from '@wa-bridge/shared';
import { loadConfig } from '../src/config.js';
import { createAuthenticator } from '../src/http/auth.js';
import { buildServer } from '../src/http/server.js';
import { pairingMessage, SessionManager } from '../src/session/manager.js';
import { createSimulator } from '../src/wa/simulator.js';
import { silentLogger, tempStore, waitFor } from './helpers.js';

const TOKEN = 'token-de-prueba-ventaplay-123';
const auth = { authorization: `Bearer ${TOKEN}` };

let cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

async function setup(allowSend: boolean) {
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
    ownerPhone: '+56 9 1234 5678',
    allowSend,
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
  const create = async () => {
    const r = await app.inject({ method: 'POST', url: '/sessions', headers: auth, payload: {} });
    const id = (r.json() as { session: SessionSummary }).session.id;
    await waitFor(() => manager.get(id).status === 'qr', 3000, 'QR');
    return id;
  };
  // el agente: el WhatsApp del dueño, vinculado
  const agent = await create();
  sim.scan(agent);
  await waitFor(() => manager.get(agent).status === 'connected', 5000, 'agente');
  // la sesión que se está vinculando, con su código pedido
  const target = await create();
  const r = await app.inject({
    method: 'POST',
    url: `/sessions/${target}/pairing-code`,
    headers: auth,
    payload: { phone: '+56 9 4047 8363' },
  });
  expect(r.statusCode).toBe(200);
  return { app, manager, agent, target };
}

describe('enviar el código de vinculación desde el agente', () => {
  it('lo manda al número que se vincula, aunque no haya chat previo', async () => {
    const { app, manager, agent, target } = await setup(true);
    const r = await app.inject({
      method: 'POST',
      url: `/sessions/${target}/pairing-code/send`,
      headers: auth,
    });
    expect(r.statusCode).toBe(200);
    const pairing = (r.json() as { session: SessionSummary }).session.pairing!;
    expect(pairing.sentAt).toBeTruthy();
    expect(pairing.sentVia).toBeTruthy();
    // quedó en el chat del agente con ese número
    const chat = await app.inject({
      url: `/sessions/${agent}/personal/chats/${encodeURIComponent('56940478363@s.whatsapp.net')}/messages`,
      headers: auth,
    });
    expect(chat.statusCode).toBe(200);
    const msgs = (chat.json() as { messages: { text: string | null; fromMe: boolean }[] }).messages;
    expect(msgs.at(-1)).toMatchObject({ fromMe: true, text: pairingMessage(pairing.code) });
    expect(manager.get(target).summary().pairing?.code).toBe(pairing.code);
  });

  it('sin envío habilitado en el agente, no manda nada', async () => {
    const { app, target } = await setup(false);
    const r = await app.inject({
      method: 'POST',
      url: `/sessions/${target}/pairing-code/send`,
      headers: auth,
    });
    expect(r.statusCode).toBe(403);
  });
});
