import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  HistoryFetchStatus,
  PersonalChatList,
  PersonalChatMessages,
  ProjectInfo,
  ProjectMessages,
  SessionSummary,
} from '@wa-bridge/shared';
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

async function setup(
  ownerPhone: string | null,
  opts: { allowSend?: boolean; exportDir?: string; openFolder?: (dir: string) => void } = {},
) {
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
    allowSend: opts.allowSend ?? false,
    exportDir: opts.exportDir ?? null,
  });
  await manager.init();
  const app = await buildServer({
    config,
    manager,
    auth: createAuthenticator(config),
    logger: silentLogger,
    storageKind: 'file',
    simulator: sim,
    openFolder: opts.openFolder ?? (() => {}),
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
      expect(c.stored).toBeLessThanOrEqual(300);
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
    expect(body.messages.length).toBe(Math.min(group.stored, 10));
    expect(body.hasMore).toBe(group.stored > 10);
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

  it('lee más mensajes con limit y busca texto en todos los chats', async () => {
    const { app, id } = await setup('56912345678');
    const list = (
      await app.inject({ url: `/sessions/${id}/personal/chats?days=90`, headers: auth })
    ).json() as PersonalChatList;
    const big = [...list.items].sort((a, b) => b.stored - a.stored)[0]!;
    const r = await app.inject({
      url: `/sessions/${id}/personal/chats/${encodeURIComponent(big.jid)}/messages?limit=300`,
      headers: auth,
    });
    expect((r.json() as PersonalChatMessages).messages.length).toBe(big.stored);

    const s = await app.inject({
      url: `/sessions/${id}/personal/search?q=${encodeURIComponent('cuanto sale')}`,
      headers: auth,
    });
    expect(s.statusCode).toBe(200);
    const res = s.json() as { total: number; hits: { message: { text: string } }[] };
    expect(res.total).toBeGreaterThan(0);
    expect(res.hits.every((h) => /cuánto sale/i.test(h.message.text))).toBe(true);
  });

  it('sin ALLOW_SEND no envía', async () => {
    const { app, id } = await setup('56912345678');
    const c = (
      (
        await app.inject({ url: `/sessions/${id}/personal/chats`, headers: auth })
      ).json() as PersonalChatList
    ).items[0]!;
    const r = await app.inject({
      method: 'POST',
      url: `/sessions/${id}/personal/chats/${encodeURIComponent(c.jid)}/send`,
      headers: auth,
      payload: { text: 'hola' },
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe('send_disabled');
  });

  it('con ALLOW_SEND envía a un chat existente, lo guarda y aplica el freno', async () => {
    const { app, id } = await setup('56912345678', { allowSend: true });
    const c = (
      (
        await app.inject({ url: `/sessions/${id}/personal/chats`, headers: auth })
      ).json() as PersonalChatList
    ).items[0]!;
    const send = (text: string) =>
      app.inject({
        method: 'POST',
        url: `/sessions/${id}/personal/chats/${encodeURIComponent(c.jid)}/send`,
        headers: auth,
        payload: { text },
      });
    const r = await send('Hola, te confirmo mañana');
    expect(r.statusCode).toBe(200);
    expect(r.json().message).toMatchObject({ fromMe: true, text: 'Hola, te confirmo mañana' });
    const last = (
      (
        await app.inject({
          url: `/sessions/${id}/personal/chats/${encodeURIComponent(c.jid)}/messages`,
          headers: auth,
        })
      ).json() as PersonalChatMessages
    ).messages.at(-1);
    expect(last?.text).toBe('Hola, te confirmo mañana');
    // mismo chat al tiro: freno
    expect((await send('otro')).statusCode).toBe(429);

    // a un chat que no existe: no
    const nope = await app.inject({
      method: 'POST',
      url: `/sessions/${id}/personal/chats/56900000001@s.whatsapp.net/send`,
      headers: auth,
      payload: { text: 'hola' },
    });
    expect(nope.statusCode).toBe(404);
  });

  it('envía fotos y documentos, los guarda y se pueden ver de vuelta', async () => {
    const { app, id } = await setup('56912345678', { allowSend: true });
    const items = (
      (
        await app.inject({ url: `/sessions/${id}/personal/chats`, headers: auth })
      ).json() as PersonalChatList
    ).items;
    const [a, b] = items;
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    const url = (jid: string) =>
      `/sessions/${id}/personal/chats/${encodeURIComponent(jid)}/send-media`;

    const r = await app.inject({
      method: 'POST',
      url: url(a!.jid),
      headers: auth,
      payload: {
        data: png.toString('base64'),
        mimetype: 'image/png',
        fileName: 'foto.png',
        caption: 'Mira esto',
      },
    });
    expect(r.statusCode).toBe(200);
    const msg = r.json().message as { id: string; kind: string; text: string };
    expect(msg).toMatchObject({ kind: 'image', text: 'Mira esto' });
    const media = await app.inject({
      url: `/sessions/${id}/personal/chats/${encodeURIComponent(a!.jid)}/media/${msg.id}`,
      headers: auth,
    });
    expect(media.statusCode).toBe(200);
    expect(media.rawPayload.equals(png)).toBe(true);

    // un PDF va como documento con su nombre (sin rutas)
    const d = await app.inject({
      method: 'POST',
      url: url(b!.jid),
      headers: auth,
      payload: {
        data: Buffer.from('%PDF-1.4 hola').toString('base64'),
        mimetype: 'application/pdf',
        fileName: '../../secreto/propuesta.pdf',
      },
    });
    expect(d.statusCode).toBe(200);
    expect(d.json().message).toMatchObject({
      kind: 'document',
      media: { fileName: 'propuesta.pdf', mimetype: 'application/pdf' },
    });

    // misma foto como documento y freno al mismo chat
    const again = await app.inject({
      method: 'POST',
      url: url(a!.jid),
      headers: auth,
      payload: { data: png.toString('base64'), mimetype: 'image/png', fileName: 'x.png' },
    });
    expect(again.statusCode).toBe(429);
  });

  it('no envía archivos vacíos ni sin ALLOW_SEND', async () => {
    const { app, id } = await setup('56912345678');
    const c = (
      (
        await app.inject({ url: `/sessions/${id}/personal/chats`, headers: auth })
      ).json() as PersonalChatList
    ).items[0]!;
    const r = await app.inject({
      method: 'POST',
      url: `/sessions/${id}/personal/chats/${encodeURIComponent(c.jid)}/send-media`,
      headers: auth,
      payload: { data: Buffer.from('hola').toString('base64'), mimetype: 'text/plain' },
    });
    expect(r.statusCode).toBe(403);
  });

  it('aísla un grupo: guarda todo, baja la media y exporta la carpeta', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wa-proy-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const opened: string[] = [];
    const { app, id } = await setup('56912345678', {
      allowSend: true,
      exportDir: dir,
      openFolder: (d) => opened.push(d),
    });
    const group = (
      (
        await app.inject({ url: `/sessions/${id}/personal/chats`, headers: auth })
      ).json() as PersonalChatList
    ).items.find((c) => c.isGroup)!;

    const r = await app.inject({
      method: 'POST',
      url: `/sessions/${id}/projects`,
      headers: auth,
      payload: { jid: group.jid },
    });
    expect(r.statusCode).toBe(200);
    const project = r.json().project as ProjectInfo;
    expect(project).toMatchObject({ jid: group.jid, name: group.name, isGroup: true });
    expect(project.messages).toBeGreaterThan(0);

    // lo que se envía después también queda
    const sent = await app.inject({
      method: 'POST',
      url: `/sessions/${id}/personal/chats/${encodeURIComponent(group.jid)}/send-media`,
      headers: auth,
      payload: {
        data: Buffer.from('%PDF-1.4 factura').toString('base64'),
        mimetype: 'application/pdf',
        fileName: 'factura-77.pdf',
        caption: 'Factura 77',
      },
    });
    expect(sent.statusCode).toBe(200);

    const url = `/sessions/${id}/projects/${encodeURIComponent(group.jid)}`;
    for (let t = 0; ; t++) {
      const p = (
        (await app.inject({ url: `/sessions/${id}/projects`, headers: auth })).json() as {
          projects: ProjectInfo[];
        }
      ).projects[0]!;
      if (p.media.total > 0 && p.media.downloaded === p.media.total) break;
      if (t > 100) throw new Error(`media sin bajar: ${JSON.stringify(p.media)}`);
      await new Promise((r) => setTimeout(r, 50));
    }

    const list = (
      await app.inject({ url: `${url}/messages?raw=1`, headers: auth })
    ).json() as ProjectMessages;
    const doc = list.messages.find((m) => m.media?.fileName === 'factura-77.pdf')!;
    expect(doc).toMatchObject({ source: 'sent', fromMe: true, text: 'Factura 77' });
    expect(doc.raw).toBeTruthy();
    const file = await app.inject({ url: `${url}/media/${doc.id}`, headers: auth });
    expect(file.body).toContain('factura');

    const ex = await app.inject({ method: 'POST', url: `${url}/export`, headers: auth });
    expect(ex.statusCode).toBe(200);
    const out = (ex.json().project as ProjectInfo).exportDir!;
    const files = await readdir(out);
    expect(files).toEqual(
      expect.arrayContaining(['mensajes.jsonl', 'mensajes.xlsx', 'proyecto.json', 'media']),
    );
    const lines = (await readFile(join(out, 'mensajes.jsonl'), 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(list.messages.length);
    expect((await readdir(join(out, 'media'))).some((f) => f.endsWith('factura-77.pdf'))).toBe(
      true,
    );

    // abrir la carpeta en Finder / Explorador
    const open = await app.inject({ method: 'POST', url: `${url}/open`, headers: auth });
    expect(open.statusCode).toBe(200);
    expect(open.json().dir).toBe(out);
    expect(opened).toEqual([out]);

    // otro número no ve proyectos
    const del = await app.inject({ method: 'DELETE', url, headers: auth });
    expect(del.statusCode).toBe(204);
    expect(
      (await app.inject({ url: `/sessions/${id}/projects`, headers: auth })).json().projects,
    ).toEqual([]);
  });

  it('foto vieja vencida en el CDN: se la pide al teléfono y después baja directo', async () => {
    const { app, id } = await setup('56912345678');
    const list = (
      await app.inject({ url: `/sessions/${id}/personal/chats?days=90`, headers: auth })
    ).json() as PersonalChatList;
    const month = 30 * 24 * 3600 * 1000;
    for (const c of list.items) {
      const { messages } = (
        await app.inject({
          url: `/sessions/${id}/personal/chats/${encodeURIComponent(c.jid)}/messages?limit=300`,
          headers: auth,
        })
      ).json() as PersonalChatMessages;
      const old = messages.find((x) => x.kind === 'image' && x.timestamp < Date.now() - month);
      if (!old) continue;
      const url = `/sessions/${id}/personal/chats/${encodeURIComponent(c.jid)}/media/${old.id}`;
      const r = await app.inject({ url, headers: auth });
      expect(r.statusCode).toBe(200);
      expect(r.headers['x-media-thumbnail']).toBe('0');
      expect(r.headers['content-type']).toMatch(/svg/);
      return;
    }
    throw new Error('el simulador no dejó fotos viejas guardadas');
  });
});

describe('Traer toda la conversación', () => {
  it('pide el historial antiguo por tramos hasta que el teléfono no tiene más y lo guarda completo', async () => {
    const { app, id } = await setup('56912345678');
    const group = (
      (
        await app.inject({ url: `/sessions/${id}/personal/chats`, headers: auth })
      ).json() as PersonalChatList
    ).items.find((c) => c.isGroup)!;
    const url = `/sessions/${id}/personal/chats/${encodeURIComponent(group.jid)}/history`;

    const idle = (await app.inject({ url, headers: auth })).json().history as HistoryFetchStatus;
    expect(idle.state).toBe('idle');

    const r = await app.inject({ method: 'POST', url, headers: auth });
    expect(r.statusCode).toBe(200);
    const started = r.json().history as HistoryFetchStatus;
    expect(started.state).toBe('running');
    const before = started.total;
    const oldestBefore = started.oldest!;

    let st = started;
    for (let t = 0; st.state === 'running'; t++) {
      if (t > 200) throw new Error(`no terminó: ${JSON.stringify(st)}`);
      await new Promise((res) => setTimeout(res, 20));
      st = (await app.inject({ url, headers: auth })).json().history as HistoryFetchStatus;
    }
    // el simulador entrega 3 tramos de 20 y luego uno vacío
    expect(st).toMatchObject({ state: 'done', reason: 'complete', pages: 4, added: 60 });
    expect(st.total).toBe(before + 60);
    expect(st.oldest!).toBeLessThan(oldestBefore);

    // el chat quedó aislado con todo, incluido lo más antiguo
    const p = (
      await app.inject({
        url: `/sessions/${id}/projects/${encodeURIComponent(group.jid)}/messages?limit=5000`,
        headers: auth,
      })
    ).json() as ProjectMessages;
    expect(p.messages.length).toBe(st.total);
    expect(p.messages[0]!.text).toMatch(/^Mensaje antiguo 3\./);
  });

  it('solo para el número dueño', async () => {
    const { app, id } = await setup('56999999999');
    const r = await app.inject({
      method: 'POST',
      url: `/sessions/${id}/personal/chats/${encodeURIComponent('123@g.us')}/history`,
      headers: auth,
    });
    expect(r.statusCode).toBe(403);
  });
});
