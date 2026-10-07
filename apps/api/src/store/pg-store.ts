import pg from 'pg';
import type { Cipher } from '../crypto.js';
import type { SessionRecord, SessionStore } from './types.js';

export const PG_SCHEMA_SQL = `
create table if not exists wa_bridge_sessions (
  id          text primary key,
  data        bytea not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists wa_bridge_auth (
  session_id  text not null references wa_bridge_sessions(id) on delete cascade,
  key         text not null,
  value       bytea not null,
  updated_at  timestamptz not null default now(),
  primary key (session_id, key)
);

-- nadie fuera del backend debe leer estas tablas (Supabase expone public vía PostgREST)
alter table wa_bridge_sessions enable row level security;
alter table wa_bridge_auth enable row level security;
`;

/**
 * Guarda sesiones y credenciales en Postgres (Supabase), cifradas con AES-256-GCM.
 * RLS activado sin políticas: solo el rol del backend (dueño de la tabla) puede leer.
 */
export class PgSessionStore implements SessionStore {
  readonly kind = 'postgres' as const;
  private readonly pool: pg.Pool;

  constructor(
    connectionString: string,
    private readonly cipher: Cipher,
  ) {
    this.pool = new pg.Pool({ connectionString, max: 5 });
  }

  async init(): Promise<void> {
    await this.pool.query(PG_SCHEMA_SQL);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async listSessions(): Promise<SessionRecord[]> {
    const { rows } = await this.pool.query<{ data: Buffer }>(
      'select data from wa_bridge_sessions order by created_at desc',
    );
    return rows.map((r) => JSON.parse(this.cipher.decryptString(r.data)) as SessionRecord);
  }

  async getSession(id: string): Promise<SessionRecord | null> {
    const { rows } = await this.pool.query<{ data: Buffer }>(
      'select data from wa_bridge_sessions where id = $1',
      [id],
    );
    const row = rows[0];
    return row ? (JSON.parse(this.cipher.decryptString(row.data)) as SessionRecord) : null;
  }

  async saveSession(record: SessionRecord): Promise<void> {
    await this.pool.query(
      `insert into wa_bridge_sessions (id, data, created_at, updated_at)
       values ($1, $2, to_timestamp($3 / 1000.0), now())
       on conflict (id) do update set data = excluded.data, updated_at = now()`,
      [record.id, this.cipher.encryptString(JSON.stringify(record)), record.createdAt],
    );
  }

  async deleteSession(id: string): Promise<void> {
    await this.pool.query('delete from wa_bridge_sessions where id = $1', [id]);
  }

  async readAuth(sessionId: string, keys: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (keys.length === 0) return out;
    const { rows } = await this.pool.query<{ key: string; value: Buffer }>(
      'select key, value from wa_bridge_auth where session_id = $1 and key = any($2::text[])',
      [sessionId, keys],
    );
    for (const r of rows) out.set(r.key, this.cipher.decryptString(r.value));
    return out;
  }

  async writeAuth(sessionId: string, entries: Record<string, string | null>): Promise<void> {
    const upserts = Object.entries(entries).filter((e): e is [string, string] => e[1] !== null);
    const deletes = Object.entries(entries)
      .filter(([, v]) => v === null)
      .map(([k]) => k);
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      for (const [key, value] of upserts) {
        await client.query(
          `insert into wa_bridge_auth (session_id, key, value) values ($1, $2, $3)
           on conflict (session_id, key) do update set value = excluded.value, updated_at = now()`,
          [sessionId, key, this.cipher.encryptString(value)],
        );
      }
      if (deletes.length) {
        await client.query(
          'delete from wa_bridge_auth where session_id = $1 and key = any($2::text[])',
          [sessionId, deletes],
        );
      }
      await client.query('commit');
    } catch (err) {
      await client.query('rollback').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async clearAuth(sessionId: string): Promise<void> {
    await this.pool.query('delete from wa_bridge_auth where session_id = $1', [sessionId]);
  }
}
