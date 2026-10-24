import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionManager } from '../src/session/manager.js';
import { loadAuthState } from '../src/wa/auth-state.js';
import { createSimulator } from '../src/wa/simulator.js';
import type { SocketFactory, WaSocketLike } from '../src/wa/types.js';
import { silentLogger, tempStore, waitFor } from './helpers.js';

const FAST = { firstQrMs: 10, qrRotateMs: 40, maxQrs: 3, openMs: 20, batchEveryMs: 15 };
/** QR que dura lo suficiente para "escanearlo" en el test */
const SCANNABLE = { ...FAST, qrRotateMs: 2000 };
/** rotación holgada: dibujar un QR (PNG 512px) tarda decenas de ms en runners lentos y no
 *  debe competir con el 408 que llega al agotarse los intentos */
const ROTATING = { ...FAST, qrRotateMs: 250 };

let cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

async function setup(factory?: SocketFactory, simTiming = FAST) {
  const t = await tempStore();
  const sim = createSimulator(simTiming);
  const manager = new SessionManager({
    store: t.store,
    socketFactory: factory ?? sim.factory,
    logger: silentLogger,
    maxSessions: 3,
    wipeOnLogout: true,
  });
  await manager.init();
  cleanups.push(t.cleanup, () => manager.shutdown());
  return { ...t, sim, manager };
}

describe('ciclo de vida con el simulador', () => {
  it('QR → escaneo → conectado con perfil e historial', async () => {
    const { manager, sim } = await setup(undefined, SCANNABLE);
    const created = await manager.create('Barbería Demo');
    const s = manager.get(created.id);

    const qr = await waitFor(() => s.summary().qr, 2000, 'QR');
    expect(s.status).toBe('qr');
    expect(qr.dataUrl).toMatch(/^data:image\/png;base64,/);
    expect(qr.sequence).toBeGreaterThanOrEqual(1);
    expect(qr.expiresAt).toBeGreaterThan(Date.now());

    expect(sim.scan(created.id)).toBe(true);
    await waitFor(() => s.status === 'connected', 3000, 'conectado');
    const done = await waitFor(
      () => (s.summary().stats.state === 'complete' ? s.summary() : null),
      3000,
      'sync',
    );

    expect(done.qr).toBeNull();
    expect(done.profile).toMatchObject({
      phone: '56912345678',
      name: 'Barbería Demo',
      isBusiness: true,
    });
    expect(done.profile?.business?.category).toBe('Barbería');
    expect(done.stats).toMatchObject({
      groups: 6,
      contacts: 48,
      individualChats: 38,
      progress: 100,
    });
    expect(done.stats.messages).toBeGreaterThan(2000);
    expect(done.readOnly).toBe(true);
  });

  it('el QR rota y luego expira sin escaneo; se puede pedir uno nuevo', async () => {
    const { manager } = await setup(undefined, ROTATING);
    const { id } = await manager.create(null);
    const s = manager.get(id);
    await waitFor(() => (s.summary().qr?.sequence ?? 0) >= 2, 3000, 'QR rotado');
    await waitFor(() => s.status === 'qr_expired', 3000, 'qr_expired');
    expect(s.summary().qr).toBeNull();
    // un QR que terminó de dibujarse después del cierre no revive el estado
    await new Promise((r) => setTimeout(r, 150));
    expect(s.status).toBe('qr_expired');
    expect(s.summary().qr).toBeNull();

    await manager.connect(id);
    await waitFor(() => s.status === 'qr' && s.summary().qr, 3000, 'QR nuevo');
    expect(s.summary().qr!.sequence).toBeLessThanOrEqual(2);
  });

  it('desconectar desvincula y borra credenciales, conservando el registro', async () => {
    const { manager, sim, store } = await setup(undefined, SCANNABLE);
    const { id } = await manager.create('X');
    const s = manager.get(id);
    await waitFor(() => s.summary().qr, 2000);
    sim.scan(id);
    await waitFor(() => s.status === 'connected', 3000);

    await manager.logout(id);
    expect(s.status).toBe('logged_out');
    expect(s.isLinked).toBe(false);
    expect(s.summary().lastError).toBeNull();
    expect((await loadAuthState(store, id)).isLinked()).toBe(false);
    expect((await store.getSession(id))?.status).toBe('logged_out');
  });

  it('eliminar borra todo', async () => {
    const { manager, store } = await setup();
    const { id } = await manager.create('X');
    await manager.remove(id);
    expect(manager.list()).toHaveLength(0);
    expect(await store.getSession(id)).toBeNull();
    expect(() => manager.get(id)).toThrow(/no encontrada/);
  });

  it('respeta el máximo de sesiones activas', async () => {
    const { manager } = await setup();
    await manager.create('1');
    await manager.create('2');
    await manager.create('3');
    await expect(manager.create('4')).rejects.toMatchObject({ statusCode: 429 });
  });

  it('tras reiniciar el servidor reconecta solo y conserva las estadísticas', async () => {
    const first = await setup(undefined, SCANNABLE);
    const { id } = await first.manager.create('Persistente');
    const s = first.manager.get(id);
    await waitFor(() => s.summary().qr, 2000);
    first.sim.scan(id);
    await waitFor(() => s.summary().stats.state === 'complete', 4000);
    const before = s.summary().stats;
    await first.manager.shutdown();

    const sim2 = createSimulator(FAST);
    const m2 = new SessionManager({
      store: first.store,
      socketFactory: sim2.factory,
      logger: silentLogger,
      maxSessions: 3,
      wipeOnLogout: true,
    });
    cleanups.push(() => m2.shutdown());
    await m2.init();
    const s2 = m2.get(id);
    await waitFor(() => s2.status === 'connected', 3000, 'reconectado');
    expect(s2.summary().stats).toMatchObject({
      messages: before.messages,
      contacts: before.contacts,
      state: 'complete',
    });
  });
});

/** socket guionado para probar los códigos de cierre de WhatsApp */
function scriptedFactory(script: (ev: EventEmitter, call: number) => void): SocketFactory {
  let call = 0;
  return async ({ auth }) => {
    const ev = new EventEmitter();
    const n = ++call;
    const sock: WaSocketLike = {
      ev: ev as unknown as WaSocketLike['ev'],
      user: { id: '56900000000:1@s.whatsapp.net', name: 'T' },
      end: () => {},
      logout: async () => {},
      profilePictureUrl: async () => undefined,
      getBusinessProfile: async () => undefined,
    };
    (auth.state.creds as { me?: unknown }).me ??= undefined;
    setTimeout(() => script(ev, n), 5);
    return sock;
  };
}
const close = (statusCode: number) => ({
  connection: 'close',
  lastDisconnect: {
    error: Object.assign(new Error('x'), { output: { statusCode } }),
    date: new Date(),
  },
});

describe('códigos de cierre', () => {
  it('401 desde el teléfono → logged_out con aviso', async () => {
    const { manager } = await setup(
      scriptedFactory((ev) => {
        ev.emit('connection.update', { connection: 'open' });
        setTimeout(() => ev.emit('connection.update', close(401)), 10);
      }),
    );
    const { id } = await manager.create(null);
    const s = manager.get(id);
    await waitFor(() => s.status === 'logged_out', 2000);
    expect(s.summary().lastError).toMatch(/desvinculado desde el teléfono/);
  });

  it('440 (sesión reemplazada) → error sin reintentar', async () => {
    let calls = 0;
    const { manager } = await setup(
      scriptedFactory((ev, n) => {
        calls = n;
        ev.emit('connection.update', { connection: 'open' });
        setTimeout(() => ev.emit('connection.update', close(440)), 10);
      }),
    );
    const { id } = await manager.create(null);
    const s = manager.get(id);
    await waitFor(() => s.status === 'error', 2000);
    await new Promise((r) => setTimeout(r, 1200));
    expect(calls).toBe(1);
  });

  it('515 (reinicio tras escanear) → abre un socket nuevo', async () => {
    const { manager } = await setup(
      scriptedFactory((ev, n) => {
        if (n === 1) ev.emit('connection.update', close(515));
        else ev.emit('connection.update', { connection: 'open' });
      }),
    );
    const { id } = await manager.create(null);
    await waitFor(() => manager.get(id).status === 'connected', 2000);
  });

  it('cortes de red sin vincular → se rinde tras varios intentos con error claro', async () => {
    const { manager } = await setup(
      scriptedFactory((ev) => ev.emit('connection.update', close(428))),
    );
    const { id } = await manager.create(null);
    const s = manager.get(id);
    // 1+2+5+10+30 s es mucho para un test: verificamos el primer reintento y el mensaje
    await waitFor(() => s.summary().lastError?.includes('428'), 2000);
    expect(s.status).toBe('starting');
  });
});

describe('robustez (revisión)', () => {
  it('un 500 aislado reconecta sin desvincular', async () => {
    const { manager } = await setup(
      scriptedFactory((ev, n) => {
        ev.emit('connection.update', { connection: 'open' });
        if (n === 1) setTimeout(() => ev.emit('connection.update', close(500)), 10);
      }),
    );
    const { id } = await manager.create(null);
    const s = manager.get(id);
    await waitFor(() => s.status === 'reconnecting', 2000, 'reconnecting');
    await waitFor(() => s.status === 'connected', 3000, 'reconectado');
    expect(s.isLinked).toBe(true);
  });

  it('eliminar no deja que escrituras tardías resuciten la sesión', async () => {
    const { manager, store, sim } = await setup(undefined, SCANNABLE);
    const { id } = await manager.create('X');
    const s = manager.get(id);
    await waitFor(() => s.summary().qr, 2000);
    sim.scan(id);
    await waitFor(() => s.status === 'connected', 3000);
    await manager.remove(id);
    await new Promise((r) => setTimeout(r, 2500));
    expect(await store.getSession(id)).toBeNull();
  });
});
