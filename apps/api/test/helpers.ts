import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { Cipher } from '../src/crypto.js';
import { FileSessionStore } from '../src/store/file-store.js';

export const TEST_KEY = 'a'.repeat(64);
export const silentLogger = pino({ level: 'silent' });

export async function tempStore() {
  const dir = await mkdtemp(join(tmpdir(), 'wa-bridge-test-'));
  const store = new FileSessionStore(dir, new Cipher(TEST_KEY));
  await store.init();
  return { dir, store, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export async function waitFor<T>(
  fn: () => T | undefined | null | false,
  timeoutMs = 5000,
  label = 'condición',
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout esperando ${label}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}
