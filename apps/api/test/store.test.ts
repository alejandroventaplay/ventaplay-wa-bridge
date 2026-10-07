import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { emptyStats } from '@wa-bridge/shared';
import { loadAuthState } from '../src/wa/auth-state.js';
import type { SessionRecord } from '../src/store/types.js';
import { tempStore } from './helpers.js';

const rec = (id: string): SessionRecord => ({
  id,
  label: 'Cliente Demo',
  createdAt: 1,
  updatedAt: 1,
  connectedAt: null,
  status: 'starting',
  linked: false,
  profile: null,
  stats: emptyStats(),
  statsState: null,
  lastError: null,
});

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

describe('FileSessionStore', () => {
  it('guarda, lista y borra sesiones, cifradas en disco', async () => {
    const t = await tempStore();
    cleanup = t.cleanup;
    await t.store.saveSession(rec('11111111-1111-4111-8111-111111111111'));
    const list = await t.store.listSessions();
    expect(list.map((r) => r.label)).toEqual(['Cliente Demo']);

    const raw = await readFile(
      join(t.dir, 'sessions', '11111111-1111-4111-8111-111111111111', 'session.enc'),
    );
    expect(raw.toString('utf8')).not.toContain('Cliente Demo');

    await t.store.deleteSession('11111111-1111-4111-8111-111111111111');
    expect(await t.store.listSessions()).toEqual([]);
  });

  it('rechaza ids con path traversal', async () => {
    const t = await tempStore();
    cleanup = t.cleanup;
    await expect(t.store.getSession('../../etc')).rejects.toThrow();
  });
});

describe('auth state cifrado', () => {
  it('persiste creds y llaves Signal (con Buffers) y las limpia', async () => {
    const t = await tempStore();
    cleanup = t.cleanup;
    const id = '22222222-2222-4222-8222-222222222222';
    const a = await loadAuthState(t.store, id);
    expect(a.isLinked()).toBe(false);
    a.state.creds.me = { id: '56911112222:3@s.whatsapp.net', name: 'X' };
    await a.saveCreds();
    await a.state.keys.set({
      'pre-key': { '7': { public: Buffer.from([1, 2, 3]), private: Buffer.from([4, 5]) } },
    });

    const b = await loadAuthState(t.store, id);
    expect(b.isLinked()).toBe(true);
    expect(Buffer.isBuffer(b.state.creds.noiseKey.public)).toBe(true);
    expect(Buffer.from(b.state.creds.noiseKey.public)).toEqual(
      Buffer.from(a.state.creds.noiseKey.public),
    );
    const keys = await b.state.keys.get('pre-key', ['7', '8']);
    expect(Buffer.from(keys['7']!.public)).toEqual(Buffer.from([1, 2, 3]));
    expect(keys['8']).toBeUndefined();

    await b.state.keys.set({ 'pre-key': { '7': null } });
    expect((await b.state.keys.get('pre-key', ['7']))['7']).toBeUndefined();

    const files = await readdir(join(t.dir, 'sessions', id, 'auth'));
    expect(files.length).toBeGreaterThan(0);
    await t.store.clearAuth(id);
    expect((await loadAuthState(t.store, id)).isLinked()).toBe(false);
  });
});
