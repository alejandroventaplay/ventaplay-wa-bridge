import { Mutex } from 'async-mutex';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Cipher } from '../crypto.js';
import type { SessionRecord, SessionStore } from './types.js';

const SESSION_FILE = 'session.enc';

/**
 * Guarda cada sesión en DATA_DIR/sessions/<id>/ con todos los archivos cifrados.
 * Pensado para desarrollo y para correr en un solo servidor con disco persistente.
 */
export class FileSessionStore implements SessionStore {
  readonly kind = 'file' as const;
  private readonly root: string;
  private readonly locks = new Map<string, Mutex>();

  constructor(
    dataDir: string,
    private readonly cipher: Cipher,
  ) {
    this.root = join(dataDir, 'sessions');
  }

  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
  }

  async close(): Promise<void> {}

  async listSessions(): Promise<SessionRecord[]> {
    const dirs = await readdir(this.root, { withFileTypes: true }).catch(() => []);
    const out: SessionRecord[] = [];
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const rec = await this.getSession(d.name);
      if (rec) out.push(rec);
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  async getSession(id: string): Promise<SessionRecord | null> {
    const raw = await this.readEncrypted(join(this.sessionDir(id), SESSION_FILE));
    return raw ? (JSON.parse(raw) as SessionRecord) : null;
  }

  async saveSession(record: SessionRecord): Promise<void> {
    await this.writeEncrypted(
      join(this.sessionDir(record.id), SESSION_FILE),
      JSON.stringify(record),
    );
  }

  async deleteSession(id: string): Promise<void> {
    const dir = this.sessionDir(id);
    await rm(dir, { recursive: true, force: true });
    for (const path of this.locks.keys()) if (path.startsWith(dir)) this.locks.delete(path);
  }

  async readAuth(sessionId: string, keys: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    await Promise.all(
      keys.map(async (k) => {
        const v = await this.readEncrypted(this.authPath(sessionId, k));
        if (v !== null) out.set(k, v);
      }),
    );
    return out;
  }

  async writeAuth(sessionId: string, entries: Record<string, string | null>): Promise<void> {
    await mkdir(join(this.sessionDir(sessionId), 'auth'), { recursive: true, mode: 0o700 });
    await Promise.all(
      Object.entries(entries).map(([k, v]) =>
        v === null
          ? this.remove(this.authPath(sessionId, k))
          : this.writeEncrypted(this.authPath(sessionId, k), v),
      ),
    );
  }

  async listAuthKeys(sessionId: string, prefix: string): Promise<string[]> {
    const names = await readdir(join(this.sessionDir(sessionId), 'auth')).catch(() => []);
    return names
      .filter((n) => n.endsWith('.enc'))
      .map((n) => Buffer.from(n.slice(0, -4), 'base64url').toString())
      .filter((k) => k.startsWith(prefix));
  }

  async clearAuth(sessionId: string): Promise<void> {
    await rm(join(this.sessionDir(sessionId), 'auth'), { recursive: true, force: true });
  }

  // ---------------------------------------------------------------------------

  private sessionDir(id: string): string {
    if (!/^[a-zA-Z0-9-]{1,64}$/.test(id)) throw new Error(`id de sesión inválido: ${id}`);
    return join(this.root, id);
  }

  private authPath(sessionId: string, key: string): string {
    // base64url: nombre de archivo seguro para claves como "session-123@lid.0"
    return join(
      this.sessionDir(sessionId),
      'auth',
      Buffer.from(key).toString('base64url') + '.enc',
    );
  }

  private lock(path: string): Mutex {
    let m = this.locks.get(path);
    if (!m) {
      m = new Mutex();
      this.locks.set(path, m);
    }
    return m;
  }

  private async readEncrypted(path: string): Promise<string | null> {
    return this.lock(path).runExclusive(async () => {
      try {
        return this.cipher.decryptString(await readFile(path));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
      }
    });
  }

  private async writeEncrypted(path: string, plain: string): Promise<void> {
    await this.lock(path).runExclusive(async () => {
      await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
      // escritura atómica: archivo temporal + rename
      const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, this.cipher.encryptString(plain), { mode: 0o600 });
      await rename(tmp, path);
    });
  }

  private async remove(path: string): Promise<void> {
    await this.lock(path).runExclusive(() => rm(path, { force: true }));
  }
}
