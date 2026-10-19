import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  PersonalChat,
  PersonalChatList,
  PersonalChatMessages,
  SearchResult,
  SendResult,
  SessionSummary,
  VoiceTranscript,
} from '@wa-bridge/shared';

/** Cómo llegar al WA Bridge que corre en el Mac. */
export interface BridgeConfig {
  url: string;
  token: string | null;
}

/** lee API_TOKEN y PORT del .env del Bridge (así no hay que pegar el token en ningún lado) */
export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<BridgeConfig> {
  const dir = (env.WA_BRIDGE_DIR || join(homedir(), 'ventaplay-wa-bridge')).replace(
    /^~(?=$|\/)/,
    homedir(),
  );
  let fileEnv: Record<string, string> = {};
  try {
    fileEnv = parseEnv(await readFile(join(dir, 'apps/api/.env'), 'utf8'));
  } catch {
    /* sin .env: usamos lo que venga en el entorno */
  }
  const port = fileEnv.PORT || '4010';
  return {
    url: (env.WA_BRIDGE_URL || `http://127.0.0.1:${port}`).replace(/\/$/, ''),
    token: env.WA_BRIDGE_TOKEN || fileEnv.API_TOKEN || null,
  };
}

export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2] ?? '';
    if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    out[m[1]!] = v;
  }
  return out;
}

export class BridgeError extends Error {
  constructor(
    message: string,
    readonly status = 0,
  ) {
    super(message);
  }
}

const OFFLINE =
  'El WA Bridge no responde en tu Mac. Ábrelo con doble clic en "Iniciar-WA-Bridge.command" (Escritorio) y vuelve a intentar.';

export class BridgeClient {
  private sessionId: string | null = null;

  constructor(private readonly cfg: BridgeConfig) {}

  private async req<T>(path: string, init: RequestInit = {}, timeoutMs = 30_000): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.cfg.url}${path}`, {
        ...init,
        headers: {
          ...(init.body ? { 'content-type': 'application/json' } : {}),
          ...(this.cfg.token ? { authorization: `Bearer ${this.cfg.token}` } : {}),
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new BridgeError(OFFLINE);
    }
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    if (!res.ok) {
      if (res.status === 401)
        throw new BridgeError(
          'El Bridge rechazó el token (revisa API_TOKEN en apps/api/.env).',
          401,
        );
      throw new BridgeError(body.message ?? `Error ${res.status} del Bridge`, res.status);
    }
    return body as T;
  }

  /** la sesión en modo asistente (la única con "Mi vista") */
  async session(): Promise<SessionSummary> {
    const { sessions } = await this.req<{ sessions: SessionSummary[] }>('/sessions');
    const mine = sessions.filter((s) => s.personal);
    const pick = mine.find((s) => s.status === 'connected') ?? mine[0];
    if (!pick)
      throw new BridgeError(
        'No hay un WhatsApp en modo asistente en el Bridge. Abre http://localhost:5190, vincula tu WhatsApp y toca "Activar asistente".',
      );
    this.sessionId = pick.id;
    return pick;
  }

  private async sid(): Promise<string> {
    return this.sessionId ?? (await this.session()).id;
  }

  async chats(days: number): Promise<PersonalChatList> {
    return this.req(`/sessions/${await this.sid()}/personal/chats?days=${days}`);
  }

  async messages(jid: string, limit: number, before?: number): Promise<PersonalChatMessages> {
    const q = new URLSearchParams({ limit: String(limit) });
    if (before) q.set('before', String(before));
    return this.req(
      `/sessions/${await this.sid()}/personal/chats/${encodeURIComponent(jid)}/messages?${q}`,
    );
  }

  /** pasa a texto una nota de voz (la primera vez baja el modelo: puede tardar) */
  async transcribe(jid: string, messageId: string, force = false): Promise<VoiceTranscript> {
    const r = await this.req<{ transcript: VoiceTranscript }>(
      `/sessions/${await this.sid()}/personal/chats/${encodeURIComponent(jid)}/messages/${encodeURIComponent(messageId)}/transcript`,
      { method: 'POST', body: JSON.stringify({ force }) },
      300_000,
    );
    return r.transcript;
  }

  async search(
    query: string,
    opts: { days: number; jid?: string | null; limit: number },
  ): Promise<SearchResult> {
    const q = new URLSearchParams({ q: query, days: String(opts.days), limit: String(opts.limit) });
    if (opts.jid) q.set('jid', opts.jid);
    return this.req(`/sessions/${await this.sid()}/personal/search?${q}`);
  }

  async sendFile(
    jid: string,
    file: { data: Buffer; mimetype: string; fileName: string },
    opts: { caption?: string | null; asDocument?: boolean } = {},
  ): Promise<SendResult> {
    return this.req(
      `/sessions/${await this.sid()}/personal/chats/${encodeURIComponent(jid)}/send-media`,
      {
        method: 'POST',
        body: JSON.stringify({
          data: file.data.toString('base64'),
          mimetype: file.mimetype,
          fileName: file.fileName,
          caption: opts.caption ?? null,
          asDocument: Boolean(opts.asDocument),
        }),
      },
      120_000,
    );
  }

  async send(jid: string, text: string): Promise<SendResult> {
    return this.req(
      `/sessions/${await this.sid()}/personal/chats/${encodeURIComponent(jid)}/send`,
      { method: 'POST', body: JSON.stringify({ text }) },
    );
  }
}

/** tipo MIME por extensión (lo que se manda seguido por WhatsApp) */
const MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  '3gp': 'video/3gpp',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  aac: 'audio/aac',
  wav: 'audio/wav',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  csv: 'text/csv',
  txt: 'text/plain',
  zip: 'application/zip',
  json: 'application/json',
  html: 'text/html',
};

export function mimeFor(path: string): string {
  const ext = /\.([a-z0-9]{1,5})$/i.exec(path)?.[1]?.toLowerCase() ?? '';
  return MIME[ext] ?? 'application/octet-stream';
}

/** expande ~ y exige ruta absoluta (el conector corre en el equipo del usuario) */
export function resolveLocalPath(path: string, home = process.env.HOME ?? ''): string {
  const p = path.trim().replace(/^~(?=\/|$)/, home);
  if (!p.startsWith('/'))
    throw new BridgeError('La ruta del archivo debe ser absoluta (o empezar con ~)');
  return p;
}

export const JID_RE = /^[\w.-]{3,64}@(s\.whatsapp\.net|lid|g\.us)$/;

export const fold = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim();

/** "+56 9 8951 8540", "989518540", "56989518540" → 56989518540 */
export function normalizePhone(input: string): string | null {
  const d = input.replace(/\D/g, '');
  if (d.length < 8) return null;
  if (d.length === 9 && d.startsWith('9')) return `56${d}`;
  if (d.length === 8) return `569${d}`;
  return d;
}

export type Resolved =
  | { ok: true; chat: PersonalChat }
  | { ok: false; reason: 'none' | 'many'; candidates: PersonalChat[] };

/** encuentra un chat por jid, número o nombre (sin tildes ni mayúsculas) */
export function resolveChat(items: PersonalChat[], query: string): Resolved {
  const q = query.trim();
  if (JID_RE.test(q)) {
    const c = items.find((x) => x.jid === q);
    return c ? { ok: true, chat: c } : { ok: false, reason: 'none', candidates: [] };
  }
  const phone = /^[+\d\s().-]+$/.test(q) ? normalizePhone(q) : null;
  if (phone) {
    const c = items.filter((x) => x.phone === phone || x.phone?.endsWith(phone));
    if (c.length === 1) return { ok: true, chat: c[0]! };
    if (c.length > 1) return { ok: false, reason: 'many', candidates: c };
  }
  const f = fold(q);
  const exact = items.filter((x) => fold(x.name) === f);
  if (exact.length === 1) return { ok: true, chat: exact[0]! };
  const words = f.split(/\s+/).filter(Boolean);
  const partial = items.filter((x) => {
    const n = fold(x.name);
    return words.every((w) => n.includes(w));
  });
  if (partial.length === 1) return { ok: true, chat: partial[0]! };
  if (partial.length > 1) return { ok: false, reason: 'many', candidates: partial.slice(0, 10) };
  return { ok: false, reason: 'none', candidates: [] };
}
