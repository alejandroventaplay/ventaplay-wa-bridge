import type { ArchivedMessage, MessageKind, ProjectPerson } from '@wa-bridge/shared';
import {
  extractContent,
  protocolAction,
  type StoredMessage,
  unwrapMessage,
} from './message-vault.js';
import { isGroupJid, isLidJid, type MessageLike, normalizeJid, phoneOf } from './stats.js';

/**
 * Archivo de "proyectos": chats del dueño que se aíslan para analizarlos.
 *
 * A diferencia de la bóveda (300 mensajes / 90 días), aquí se guarda TODO lo que llega
 * de esos chats, sin tope ni ventana: cada mensaje con sus metadatos, el mensaje
 * original de WhatsApp, ediciones, borrados, reacciones y recibos. La media se baja
 * aparte y se guarda cifrada. Todo vive en el SessionStore (cifrado, junto a las
 * credenciales), así que se borra al desvincular; la exportación a carpeta queda.
 */
export const ARCHIVE_PREFIX = 'archive:';
export const PROJECT_KEY = (jid: string) => `archive:project:${jid}`;
export const MSG_KEY = (jid: string, id: string) => `archive:msg:${jid}|${id}`;
export const MEDIA_KEY = (jid: string, id: string) => `archive:media:${jid}|${id}`;
/** reintentos de descarga de media antes de darla por perdida */
export const MEDIA_MAX_ATTEMPTS = 3;

export interface ProjectMeta {
  jid: string;
  since: number;
  exportedAt: number | null;
}

/** lo que se guarda: el mensaje + el original serializado + estado interno */
export type ArchiveRecord = Omit<ArchivedMessage, 'raw' | 'sender'> & {
  sender: Omit<ProjectPerson, 'name'>;
  rawJson: string | null;
  mediaAttempts: number;
};

export type Source = ArchivedMessage['source'];
type AnyMsg = Record<string, unknown>;
type WaLike = MessageLike & { status?: unknown; messageStubType?: unknown };

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const num = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v && Number.isFinite(Number(v))) return Number(v);
  if (v && typeof (v as { toNumber?: unknown }).toNumber === 'function')
    return (v as { toNumber(): number }).toNumber();
  return null;
};
/**
 * Timestamp de WhatsApp en ms: número, texto, Long de protobuf, o el Long ya serializado
 * a JSON ({low, high}) como queda en la bóveda.
 */
export function tsOf(v: unknown): number | null {
  let n: number | null = null;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string' && v) n = Number(v);
  else if (v && typeof (v as { toNumber?: unknown }).toNumber === 'function')
    n = (v as { toNumber(): number }).toNumber();
  else if (v && typeof (v as { low?: unknown }).low === 'number') {
    const { low, high } = v as { low: number; high?: number };
    n = (high ?? 0) * 2 ** 32 + (low >>> 0);
  }
  if (n === null || !Number.isFinite(n) || n <= 0) return null;
  return n < 1e12 ? n * 1000 : n;
}

/** bytes (Buffer, Uint8Array o base64 ya serializado) → base64 */
const b64 = (v: unknown): string | null => {
  if (!v) return null;
  if (typeof v === 'string') return v;
  if (v instanceof Uint8Array) return Buffer.from(v).toString('base64');
  const data = (v as { data?: unknown }).data;
  if (typeof data === 'string') return data;
  return null;
};

/** clave del contenido real del mensaje (imageMessage, conversation, …) */
function contentType(m: AnyMsg | null): string | null {
  if (!m) return null;
  const skip = new Set(['messageContextInfo', 'senderKeyDistributionMessage']);
  return Object.keys(m).find((k) => !skip.has(k) && m[k] !== null && m[k] !== undefined) ?? null;
}

export interface ArchiveIdentity {
  /** mi jid (número) y mi LID, para los mensajes que mandé yo */
  meJid: string | null;
  meLid: string | null;
}

export class ChatArchive {
  private projects = new Map<string, ProjectMeta>();
  private chats = new Map<string, Map<string, ArchiveRecord>>();
  private dirty = new Set<string>();

  constructor(private readonly serialize: (v: unknown) => string = (v) => JSON.stringify(v)) {}

  // ------------------------------------------------------------ proyectos

  tracked(jid: string): boolean {
    return this.projects.has(jid);
  }

  list(): ProjectMeta[] {
    return [...this.projects.values()].sort((a, b) => a.since - b.since);
  }

  meta(jid: string): ProjectMeta | null {
    return this.projects.get(jid) ?? null;
  }

  track(jid: string, now = Date.now()): ProjectMeta {
    const cur = this.projects.get(jid);
    if (cur) return cur;
    const meta: ProjectMeta = { jid, since: now, exportedAt: null };
    this.projects.set(jid, meta);
    if (!this.chats.has(jid)) this.chats.set(jid, new Map());
    this.dirty.add(PROJECT_KEY(jid));
    return meta;
  }

  /** deja de aislar el chat y borra lo guardado (claves a eliminar del store) */
  untrack(jid: string): string[] {
    const keys = [PROJECT_KEY(jid)];
    for (const r of this.chats.get(jid)?.values() ?? []) {
      keys.push(MSG_KEY(jid, r.id));
      if (r.media?.downloaded) keys.push(MEDIA_KEY(jid, r.id));
    }
    this.projects.delete(jid);
    this.chats.delete(jid);
    for (const k of keys) this.dirty.delete(k);
    return keys;
  }

  markExported(jid: string, at: number): void {
    const meta = this.projects.get(jid);
    if (!meta) return;
    meta.exportedAt = at;
    this.dirty.add(PROJECT_KEY(jid));
  }

  messages(jid: string): ArchiveRecord[] {
    return [...(this.chats.get(jid)?.values() ?? [])].sort(
      (a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id),
    );
  }

  get(jid: string, id: string): ArchiveRecord | null {
    return this.chats.get(jid)?.get(id) ?? null;
  }

  // ------------------------------------------------------------ captura

  /**
   * Agrega mensajes de WhatsApp (History Sync, en vivo o enviados por nosotros).
   * `canonical` lleva un jid a la forma con la que se aisló el chat. Devuelve cuántos
   * cambios hubo.
   */
  ingest(
    messages: WaLike[],
    source: Source,
    who: ArchiveIdentity,
    canonical: (jid: string) => string = (j) => j,
    now = Date.now(),
  ): number {
    if (!this.projects.size) return 0;
    let changed = 0;
    for (const m of messages) {
      const remote = m?.key?.remoteJid;
      const id = m?.key?.id;
      if (!remote || !id || !m.message) continue;
      const jid = canonical(normalizeJid(remote));
      if (!this.projects.has(jid)) continue;
      const ts = tsOf(m.messageTimestamp) ?? now;
      const inner = unwrapMessage(m.message);

      // borrado / edición de un mensaje anterior
      const action = protocolAction(m.message);
      if (action) {
        if (this.applyAction(jid, action.id, action.type, action.edited?.text ?? null, ts, now))
          changed += 1;
        continue;
      }
      // reacción
      const reaction = inner?.reactionMessage as AnyMsg | undefined;
      if (reaction) {
        const target = str((reaction.key as AnyMsg | undefined)?.id);
        const sender = this.author(jid, m, who).jid ?? this.author(jid, m, who).lid ?? '?';
        const at = num(reaction.senderTimestampMs) ?? ts;
        if (target && this.applyReaction(jid, target, sender, str(reaction.text) ?? '', at, now))
          changed += 1;
        continue;
      }

      const content = extractContent(m.message);
      if (!content) continue;
      const type = contentType(inner);
      const body = (type ? inner?.[type] : null) as AnyMsg | null;
      const ctx = (body?.contextInfo ?? null) as AnyMsg | null;
      const quotedId = str(ctx?.stanzaId);
      const media = content.media
        ? {
            ...content.media,
            sha256: b64(body?.fileSha256),
            pageCount: num(body?.pageCount),
            downloaded: false,
            verified: null,
            downloadedAt: null,
            error: null,
          }
        : null;
      const rec: ArchiveRecord = {
        id,
        chatJid: jid,
        timestamp: ts,
        fromMe: Boolean((m.key as { fromMe?: boolean | null }).fromMe),
        sender: this.author(jid, m, who),
        type,
        kind: content.kind,
        text: content.text,
        quoted: quotedId
          ? {
              id: quotedId,
              participant: str(ctx?.participant) ? normalizeJid(str(ctx?.participant)!) : null,
              text: quotedText(ctx?.quotedMessage),
            }
          : null,
        mentions: Array.isArray(ctx?.mentionedJid)
          ? (ctx.mentionedJid as unknown[]).filter((x): x is string => typeof x === 'string')
          : [],
        forwarded: Boolean(ctx?.isForwarded),
        forwardingScore: num(ctx?.forwardingScore),
        ephemeralSeconds: num(ctx?.expiration),
        media,
        location: content.location ?? null,
        edits: [],
        deleted: null,
        reactions: [],
        receipts: [],
        source,
        capturedAt: now,
        updatedAt: now,
        rawJson: this.serialize(m),
        mediaAttempts: 0,
      };
      if (this.upsert(jid, rec)) changed += 1;
    }
    return changed;
  }

  /** copia lo que ya había en la bóveda (antes de aislar el chat) */
  backfill(jid: string, stored: StoredMessage[], who: ArchiveIdentity, now = Date.now()): number {
    if (!this.projects.has(jid)) return 0;
    let changed = 0;
    for (const s of stored) {
      if (this.chats.get(jid)?.has(s.id)) continue;
      const raw = s.raw ? safeParse(s.raw) : null;
      if (raw) {
        // con el original a mano sacamos todos los metadatos
        const before = this.chats.get(jid)?.size ?? 0;
        this.ingest([raw as WaLike], 'vault', who, () => jid, now);
        const r = this.chats.get(jid)?.get(s.id);
        if (r && (this.chats.get(jid)?.size ?? 0) > before) {
          r.timestamp = s.ts;
          r.edits = s.edited ? [{ timestamp: s.ts, previousText: null }] : [];
          changed += 1;
          continue;
        }
      }
      const sender: ArchiveRecord['sender'] = s.fromMe
        ? me(who)
        : person(s.sender ?? (isGroupJid(jid) ? null : jid), s.senderAlt ?? null, s.pushName);
      this.upsert(jid, {
        id: s.id,
        chatJid: jid,
        timestamp: s.ts,
        fromMe: s.fromMe,
        sender,
        type: null,
        kind: s.kind,
        text: s.text,
        quoted: null,
        mentions: [],
        forwarded: false,
        forwardingScore: null,
        ephemeralSeconds: null,
        media: s.media
          ? {
              ...s.media,
              sha256: null,
              pageCount: null,
              downloaded: false,
              verified: null,
              downloadedAt: null,
              error: null,
            }
          : null,
        location: s.location ?? null,
        edits: s.edited ? [{ timestamp: s.ts, previousText: null }] : [],
        deleted: s.kind === 'deleted' ? { timestamp: s.ts } : null,
        reactions: [],
        receipts: [],
        source: 'vault',
        capturedAt: now,
        updatedAt: now,
        rawJson: s.raw ?? null,
        mediaAttempts: 0,
      });
      changed += 1;
    }
    return changed;
  }

  /** evento messages.reaction de Baileys */
  reactions(
    items: { key?: AnyMsg | null; reaction?: AnyMsg | null }[],
    who: ArchiveIdentity,
    canonical: (jid: string) => string = (j) => j,
    now = Date.now(),
  ): number {
    let changed = 0;
    for (const it of items) {
      const remote = str(it.key?.remoteJid);
      const target = str(it.key?.id);
      if (!remote || !target) continue;
      const jid = canonical(normalizeJid(remote));
      if (!this.projects.has(jid)) continue;
      const rk = (it.reaction?.key ?? {}) as AnyMsg;
      const sender = rk.fromMe
        ? (who.meJid ?? who.meLid ?? 'yo')
        : normalizeJid(str(rk.participant) ?? str(rk.remoteJid) ?? '?@?');
      const at = num(it.reaction?.senderTimestampMs) ?? now;
      if (this.applyReaction(jid, target, sender, str(it.reaction?.text) ?? '', at, now))
        changed += 1;
    }
    return changed;
  }

  /** evento message-receipt.update de Baileys (entregado / leído / escuchado) */
  receipts(
    items: { key?: AnyMsg | null; receipt?: AnyMsg | null }[],
    canonical: (jid: string) => string = (j) => j,
    now = Date.now(),
  ): number {
    let changed = 0;
    for (const it of items) {
      const remote = str(it.key?.remoteJid);
      const id = str(it.key?.id);
      const user = str(it.receipt?.userJid);
      if (!remote || !id || !user) continue;
      const jid = canonical(normalizeJid(remote));
      const rec = this.chats.get(jid)?.get(id);
      if (!rec) continue;
      const who = normalizeJid(user);
      const cur = rec.receipts.find((r) => r.jid === who) ?? {
        jid: who,
        delivered: null,
        read: null,
        played: null,
      };
      const sec = (v: unknown) => {
        const n = num(v);
        return n ? (n < 1e12 ? n * 1000 : n) : null;
      };
      const next = {
        jid: who,
        delivered: sec(it.receipt?.receiptTimestamp) ?? cur.delivered,
        read: sec(it.receipt?.readTimestamp) ?? cur.read,
        played: sec(it.receipt?.playedTimestamp) ?? cur.played,
      };
      if (JSON.stringify(next) === JSON.stringify(cur) && rec.receipts.includes(cur)) continue;
      rec.receipts = [...rec.receipts.filter((r) => r.jid !== who), next];
      rec.updatedAt = now;
      this.dirty.add(MSG_KEY(jid, id));
      changed += 1;
    }
    return changed;
  }

  /** evento messages.update de Baileys: ediciones y borrados que llegan como actualización */
  updates(
    items: { key?: AnyMsg | null; update?: AnyMsg | null }[],
    canonical: (jid: string) => string = (j) => j,
    now = Date.now(),
  ): number {
    let changed = 0;
    for (const it of items) {
      const remote = str(it.key?.remoteJid);
      const id = str(it.key?.id);
      if (!remote || !id) continue;
      const jid = canonical(normalizeJid(remote));
      if (!this.projects.has(jid)) continue;
      const u = it.update ?? {};
      // REVOKE (stub 1) o mensaje vaciado
      if (num(u.messageStubType) === 1) {
        if (this.applyAction(jid, id, 'revoke', null, now, now)) changed += 1;
        continue;
      }
      if (u.message) {
        const action = protocolAction(u.message as object);
        if (action) {
          if (
            this.applyAction(
              jid,
              action.id,
              action.type,
              action.edited?.text ?? null,
              tsOf(u.messageTimestamp) ?? now,
              now,
            )
          )
            changed += 1;
          continue;
        }
        const edited = extractContent(u.message as object);
        if (edited?.text && this.applyAction(jid, id, 'edit', edited.text, now, now)) changed += 1;
      }
    }
    return changed;
  }

  // ------------------------------------------------------------ media

  /** mensajes con media por bajar */
  pendingMedia(jid?: string): ArchiveRecord[] {
    const out: ArchiveRecord[] = [];
    for (const [j, map] of this.chats) {
      if (jid && j !== jid) continue;
      for (const r of map.values())
        if (
          r.media &&
          !r.media.downloaded &&
          !r.deleted &&
          r.rawJson &&
          r.mediaAttempts < MEDIA_MAX_ATTEMPTS
        )
          out.push(r);
    }
    return out.sort((a, b) => a.timestamp - b.timestamp);
  }

  mediaDone(
    jid: string,
    id: string,
    result: { ok: true; size: number; verified: boolean | null } | { ok: false; error: string },
    now = Date.now(),
  ): void {
    const rec = this.chats.get(jid)?.get(id);
    if (!rec?.media) return;
    rec.mediaAttempts += 1;
    if (result.ok) {
      rec.media.downloaded = true;
      rec.media.verified = result.verified;
      rec.media.downloadedAt = now;
      rec.media.error = null;
      rec.media.size = rec.media.size ?? result.size;
    } else {
      rec.media.error = result.error;
    }
    rec.updatedAt = now;
    this.dirty.add(MSG_KEY(jid, id));
  }

  // ------------------------------------------------------------ persistencia

  takeDirty(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const key of this.dirty) {
      if (key.startsWith('archive:project:')) {
        const meta = this.projects.get(key.slice('archive:project:'.length));
        if (meta) out[key] = JSON.stringify(meta);
        continue;
      }
      const [jid, id] = key.slice('archive:msg:'.length).split('|') as [string, string];
      const rec = this.chats.get(jid)?.get(id);
      if (rec) out[key] = JSON.stringify(rec);
    }
    this.dirty.clear();
    return out;
  }

  markDirty(keys: string[]): void {
    for (const k of keys) this.dirty.add(k);
  }

  load(entries: Map<string, string>): void {
    for (const [key, value] of entries) {
      try {
        if (key.startsWith('archive:project:')) {
          const meta = JSON.parse(value) as ProjectMeta;
          this.projects.set(meta.jid, meta);
          if (!this.chats.has(meta.jid)) this.chats.set(meta.jid, new Map());
        } else if (key.startsWith('archive:msg:')) {
          const rec = JSON.parse(value) as ArchiveRecord;
          const map = this.chats.get(rec.chatJid) ?? new Map<string, ArchiveRecord>();
          map.set(rec.id, rec);
          this.chats.set(rec.chatJid, map);
        }
      } catch {
        /* entrada dañada: se ignora */
      }
    }
    // mensajes de chats que ya no se aíslan
    for (const jid of this.chats.keys()) if (!this.projects.has(jid)) this.chats.delete(jid);
  }

  clear(): void {
    this.projects.clear();
    this.chats.clear();
    this.dirty.clear();
  }

  // ------------------------------------------------------------ internos

  private author(jid: string, m: WaLike, who: ArchiveIdentity): ArchiveRecord['sender'] {
    const key = m.key as { fromMe?: boolean | null; participant?: string | null } & NonNullable<
      MessageLike['key']
    >;
    if (key.fromMe) return me(who);
    if (!isGroupJid(jid)) {
      const alt = key.remoteJidAlt ? normalizeJid(key.remoteJidAlt) : null;
      return person(normalizeJid(key.remoteJid!), alt, m.pushName ?? null);
    }
    const part = key.participant ? normalizeJid(key.participant) : null;
    const alt = key.participantAlt ? normalizeJid(key.participantAlt) : null;
    return person(part, alt, m.pushName ?? null);
  }

  private upsert(jid: string, rec: ArchiveRecord): boolean {
    const map = this.chats.get(jid) ?? new Map<string, ArchiveRecord>();
    this.chats.set(jid, map);
    const old = map.get(rec.id);
    if (old) {
      // llega dos veces (historial + en vivo, o enviado + eco): conservamos lo acumulado
      const merged: ArchiveRecord = {
        ...rec,
        sender: {
          ...rec.sender,
          pushName: rec.sender.pushName ?? old.sender.pushName,
          jid: rec.sender.jid ?? old.sender.jid,
          lid: rec.sender.lid ?? old.sender.lid,
          phone: rec.sender.phone ?? old.sender.phone,
        },
        type: rec.type ?? old.type,
        quoted: rec.quoted ?? old.quoted,
        mentions: rec.mentions.length ? rec.mentions : old.mentions,
        text: old.edits.length || old.deleted ? old.text : rec.text,
        kind: old.deleted ? old.kind : rec.kind,
        media: old.media ? { ...rec.media, ...old.media } : rec.media,
        edits: old.edits,
        deleted: old.deleted,
        reactions: old.reactions,
        receipts: old.receipts,
        source: old.source === 'vault' ? rec.source : old.source,
        capturedAt: old.capturedAt,
        rawJson: rec.rawJson ?? old.rawJson,
        mediaAttempts: old.mediaAttempts,
      };
      if (JSON.stringify({ ...merged, updatedAt: 0 }) === JSON.stringify({ ...old, updatedAt: 0 }))
        return false;
      map.set(rec.id, merged);
    } else {
      map.set(rec.id, rec);
    }
    this.dirty.add(MSG_KEY(jid, rec.id));
    return true;
  }

  private applyAction(
    jid: string,
    id: string,
    type: 'revoke' | 'edit',
    text: string | null,
    ts: number,
    now: number,
  ): boolean {
    const rec = this.chats.get(jid)?.get(id);
    if (!rec) return false;
    if (type === 'revoke') {
      if (rec.deleted) return false;
      // guardamos lo que decía: el archivo es para analizar, no para mostrar
      rec.edits = [...rec.edits, { timestamp: ts, previousText: rec.text }];
      rec.deleted = { timestamp: ts };
      rec.kind = 'deleted';
    } else {
      if (text === null || text === rec.text) return false;
      rec.edits = [...rec.edits, { timestamp: ts, previousText: rec.text }];
      rec.text = text;
    }
    rec.updatedAt = now;
    this.dirty.add(MSG_KEY(jid, id));
    return true;
  }

  private applyReaction(
    jid: string,
    target: string,
    sender: string,
    emoji: string,
    ts: number,
    now: number,
  ): boolean {
    const rec = this.chats.get(jid)?.get(target);
    if (!rec) return false;
    const cur = rec.reactions.find((r) => r.sender === sender);
    if (cur && (cur.timestamp > ts || (cur.timestamp === ts && cur.emoji === emoji))) return false;
    // emoji vacío = quitó la reacción
    rec.reactions = [
      ...rec.reactions.filter((r) => r.sender !== sender),
      ...(emoji ? [{ sender, emoji, timestamp: ts }] : []),
    ];
    rec.updatedAt = now;
    this.dirty.add(MSG_KEY(jid, target));
    return true;
  }
}

function person(
  a: string | null,
  b: string | null,
  pushName: string | null,
): ArchiveRecord['sender'] {
  const lid = [a, b].find((x) => x && isLidJid(x)) ?? null;
  const jid = [a, b].find((x) => x && !isLidJid(x)) ?? null;
  return { jid, lid, phone: phoneOf(jid), pushName };
}

function me(who: ArchiveIdentity): ArchiveRecord['sender'] {
  return { jid: who.meJid, lid: who.meLid, phone: phoneOf(who.meJid), pushName: null };
}

const KIND_TEXT: Partial<Record<MessageKind, string>> = {
  image: '[foto]',
  video: '[video]',
  gif: '[gif]',
  audio: '[audio]',
  voice: '[mensaje de voz]',
  sticker: '[sticker]',
  document: '[documento]',
  location: '[ubicación]',
  contact: '[contacto]',
  poll: '[encuesta]',
};

function quotedText(q: unknown): string | null {
  if (!q) return null;
  const c = extractContent(q as object);
  if (!c) return null;
  return c.text ?? KIND_TEXT[c.kind] ?? null;
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw, (_k, v: unknown) => {
      // mismo formato que BufferJSON.replacer de Baileys
      if (v && typeof v === 'object' && (v as { type?: unknown }).type === 'Buffer') {
        const data = (v as { data?: unknown }).data;
        if (typeof data === 'string') return Buffer.from(data, 'base64');
        if (Array.isArray(data)) return Buffer.from(data as number[]);
      }
      return v;
    });
  } catch {
    return null;
  }
}

/** el original serializado, de vuelta como objeto (Buffers incluidos) */
export function parseRaw(raw: string | null): unknown {
  return raw ? safeParse(raw) : null;
}
