import type { SyncState, SyncStats, TopChat } from '@wa-bridge/shared';

/* Formas mínimas de lo que entrega Baileys (estructurales, para poder testear sin protobuf). */
type Timestamp = number | { toNumber(): number } | string | null | undefined;

export interface ChatLike {
  id?: string | null;
  name?: string | null;
  displayName?: string | null;
  pnJid?: string | null;
  lidJid?: string | null;
  conversationTimestamp?: Timestamp;
  lastMsgTimestamp?: Timestamp;
}

export interface ContactLike {
  id?: string | null;
  lid?: string | null;
  phoneNumber?: string | null;
  name?: string | null;
  notify?: string | null;
  verifiedName?: string | null;
}

export interface MessageLike {
  key?: {
    id?: string | null;
    remoteJid?: string | null;
    remoteJidAlt?: string | null;
    participant?: string | null;
    participantAlt?: string | null;
  } | null;
  message?: object | null;
  messageTimestamp?: Timestamp;
  pushName?: string | null;
}

export interface LidMappingLike {
  lid: string;
  pn: string;
}

export interface HistoryBatch {
  chats: ChatLike[];
  contacts: ContactLike[];
  messages: MessageLike[];
  lidPnMappings?: LidMappingLike[] | null;
  progress?: number | null;
  syncType?: number | null;
  isLatest?: boolean | null;
}

interface ChatAgg {
  /** nombre del chat según WhatsApp (grupos y, a veces, contactos) */
  name: string | null;
  /** nombre que el otro se puso (pushName); último recurso */
  pushName?: string | null;
  isGroup: boolean;
  messages: number;
  lastMessageAt: number | null;
  /** mensaje más antiguo visto en el chat (no existe en snapshots viejos) */
  firstMessageAt?: number | null;
}

/** Lo que sabemos de un contacto, campo por campo (para exportar). */
export interface ContactInfo {
  /** nombre con que lo guardaste en la agenda del teléfono */
  name?: string | null;
  /** nombre que la persona se puso en WhatsApp */
  notify?: string | null;
  /** nombre verificado de WhatsApp Business */
  verifiedName?: string | null;
}

/** Una persona para exportar: contacto de la agenda y/o alguien con quien hay chat. */
export interface DirectoryPerson {
  /** JID canónico: el número si lo conocemos, si no el LID */
  jid: string;
  /** número sin '+', p.ej. 56912345678; null si solo conocemos su LID */
  phone: string | null;
  lid: string | null;
  /** el mejor nombre disponible */
  displayName: string | null;
  savedName: string | null;
  pushName: string | null;
  businessName: string | null;
  /** true/false si lo sabemos; null en datos sincronizados antes de guardar este detalle */
  inAddressBook: boolean | null;
  messages: number;
  firstMessageAt: number | null;
  lastMessageAt: number | null;
}

export interface DirectoryGroup {
  jid: string;
  name: string | null;
  messages: number;
  firstMessageAt: number | null;
  lastMessageAt: number | null;
}

export interface Directory {
  people: DirectoryPerson[];
  groups: DirectoryGroup[];
}

/** Estado serializable del agregador, para continuar tras un reinicio. */
export interface StatsSnapshot {
  v: 1;
  chats: Record<string, ChatAgg>;
  contacts: Record<string, string | null>;
  lidToPn: Record<string, string>;
  messages: number;
  oldest: number | null;
  newest: number | null;
  batches: number;
  lastBatchAt: number | null;
  progress: number | null;
  state: SyncState;
  completionInferred: boolean;
  /** syncType → completo */
  syncTypes: Record<string, boolean>;
  /** detalle por contacto (no existe en snapshots viejos) */
  contactInfo?: Record<string, ContactInfo>;
  /** true si contactInfo se guardó desde el primer lote (sabemos quién está en la agenda) */
  contactInfoComplete?: boolean;
}

const TOP_N = 10;
/** ids recientes que recordamos para deduplicar (acota la memoria en cuentas enormes) */
const DEDUPE_LIMIT = 200_000;

export const isGroupJid = (jid: string) => jid.endsWith('@g.us');
export const isUserJid = (jid: string) =>
  jid.endsWith('@s.whatsapp.net') || jid.endsWith('@c.us') || jid.endsWith('@lid');
export const isLidJid = (jid: string) => jid.endsWith('@lid');

/** quita el sufijo de dispositivo: 5691234:12@s.whatsapp.net → 5691234@s.whatsapp.net */
export function normalizeJid(jid: string): string {
  const [user = '', server = ''] = jid.split('@');
  const bare = user.split(':')[0] ?? user;
  return `${bare}@${server === 'c.us' ? 's.whatsapp.net' : server}`;
}

export function phoneOf(jid: string | null | undefined): string | null {
  if (!jid || !jid.endsWith('@s.whatsapp.net')) return null;
  return jid.split('@')[0] ?? null;
}

export function toMs(ts: Timestamp): number | null {
  if (ts === null || ts === undefined) return null;
  let n: number;
  if (typeof ts === 'number') n = ts;
  else if (typeof ts === 'string') n = Number(ts);
  else n = ts.toNumber();
  if (!Number.isFinite(n) || n <= 0) return null;
  // WhatsApp usa segundos; si ya viene en ms lo dejamos
  return n < 1e12 ? n * 1000 : n;
}

/** mensajes de sistema que no cuentan como conversación */
const IGNORED_MESSAGE_TYPES = new Set(['protocolMessage', 'senderKeyDistributionMessage']);

/**
 * Cuenta contactos, chats y mensajes a medida que llegan los lotes de History Sync
 * y los eventos en vivo. Solo guarda conteos y nombres, nunca el contenido de mensajes.
 */
export class StatsAggregator {
  private chats = new Map<string, ChatAgg>();
  private contacts = new Map<string, string | null>();
  private contactInfo = new Map<string, ContactInfo>();
  /** false si el snapshot restaurado no traía detalle por contacto */
  private hasContactInfo = true;
  private lidToPn = new Map<string, string>();
  private seenMessages = new Set<string>();
  private messages = 0;
  private oldest: number | null = null;
  private newest: number | null = null;
  private batches = 0;
  private lastBatchAt: number | null = null;
  private progress: number | null = null;
  private state: SyncState = 'waiting';
  private completionInferred = false;
  private syncTypes = new Map<string, boolean>();

  constructor(snapshot?: StatsSnapshot | null) {
    if (snapshot?.v === 1) this.restore(snapshot);
  }

  // ---------------------------------------------------------------- entradas

  addHistoryBatch(batch: HistoryBatch, now = Date.now()): void {
    for (const m of batch.lidPnMappings ?? []) this.addLidMapping(m);
    this.addContacts(batch.contacts);
    this.addChats(batch.chats);
    this.addMessages(batch.messages);
    this.batches += 1;
    this.lastBatchAt = now;
    if (typeof batch.progress === 'number')
      this.progress = Math.max(0, Math.min(100, batch.progress));
    let reopen = this.state !== 'complete';
    if (batch.syncType !== null && batch.syncType !== undefined) {
      const k = String(batch.syncType);
      if (!this.syncTypes.has(k)) this.syncTypes.set(k, false);
      // llegó un lote de un tipo que WhatsApp aún no dio por terminado: seguimos sincronizando
      if (this.syncTypes.get(k) !== true) reopen = true;
    } else if (this.completionInferred) {
      reopen = true;
    }
    if (reopen) {
      this.state = 'running';
      this.completionInferred = false;
    }
  }

  /** WhatsApp avisa que terminó (o pausó) un tipo de sincronización */
  markSyncStatus(syncType: number, status: 'complete' | 'paused'): void {
    if (status !== 'complete') return;
    this.syncTypes.set(String(syncType), true);
    if (this.batches > 0 && [...this.syncTypes.values()].every(Boolean)) {
      this.state = 'complete';
      this.completionInferred = false;
      this.progress = 100;
    }
  }

  /** si no llegan lotes por un rato damos el sync por terminado (inferido) */
  inferCompletionIfIdle(idleMs: number, now = Date.now()): boolean {
    if (this.state !== 'running' || this.lastBatchAt === null) return false;
    if (now - this.lastBatchAt < idleMs) return false;
    this.state = 'complete';
    this.completionInferred = true;
    return true;
  }

  /** sesión re-conectada sin historial nuevo (ya se había sincronizado antes) */
  markNoHistoryExpected(): void {
    if (this.state === 'waiting' && this.batches > 0) this.state = 'complete';
  }

  addLidMapping(m: LidMappingLike): void {
    if (!m?.lid || !m?.pn) return;
    this.lidToPn.set(normalizeJid(m.lid), normalizeJid(m.pn));
  }

  addContacts(contacts: ContactLike[]): void {
    for (const c of contacts) {
      if (!c?.id) continue;
      const id = normalizeJid(c.id);
      if (!isUserJid(id)) continue;
      const lid = c.lid ? normalizeJid(c.lid) : isLidJid(id) ? id : null;
      const pn = c.phoneNumber
        ? normalizeJid(
            c.phoneNumber.includes('@') ? c.phoneNumber : `${c.phoneNumber}@s.whatsapp.net`,
          )
        : !isLidJid(id)
          ? id
          : null;
      if (lid && pn) this.lidToPn.set(lid, pn);
      const key = pn ?? id;
      const name = c.name || c.notify || c.verifiedName || this.contacts.get(key) || null;
      this.contacts.set(key, name);
      this.mergeInfo(key, { name: c.name, notify: c.notify, verifiedName: c.verifiedName });
      // si antes lo teníamos por LID y ahora sabemos el número, unificamos
      if (lid && pn && this.contacts.has(lid)) {
        const prev = this.contacts.get(lid);
        this.contacts.delete(lid);
        if (!name && prev) this.contacts.set(key, prev);
      }
      if (lid && pn && lid !== key && this.contactInfo.has(lid)) {
        this.mergeInfo(key, this.contactInfo.get(lid)!);
        this.contactInfo.delete(lid);
      }
    }
  }

  addChats(chats: ChatLike[]): void {
    for (const c of chats) {
      if (!c?.id) continue;
      const id = normalizeJid(c.id);
      if (!isUserJid(id) && !isGroupJid(id)) continue;
      if (c.lidJid && c.pnJid) this.lidToPn.set(normalizeJid(c.lidJid), normalizeJid(c.pnJid));
      const agg = this.ensureChat(id);
      agg.name = c.name || c.displayName || agg.name;
      const ts = toMs(c.conversationTimestamp) ?? toMs(c.lastMsgTimestamp);
      if (ts && (!agg.lastMessageAt || ts > agg.lastMessageAt)) agg.lastMessageAt = ts;
    }
  }

  addMessages(messages: MessageLike[]): void {
    for (const m of messages) {
      const jidRaw = m?.key?.remoteJid;
      const msgId = m?.key?.id;
      if (!jidRaw || !msgId || !m.message) continue;
      const types = Object.keys(m.message);
      if (types.length > 0 && types.every((t) => IGNORED_MESSAGE_TYPES.has(t))) continue;
      const jid = normalizeJid(jidRaw);
      if (!isUserJid(jid) && !isGroupJid(jid)) continue;
      const alt = m.key?.remoteJidAlt ? normalizeJid(m.key.remoteJidAlt) : null;
      if (alt && isLidJid(jid) && !isLidJid(alt)) this.lidToPn.set(jid, alt);
      if (alt && !isLidJid(jid) && isLidJid(alt)) this.lidToPn.set(alt, jid);

      const dedupeKey = `${jid}|${msgId}`;
      if (this.seenMessages.has(dedupeKey)) continue;
      this.seenMessages.add(dedupeKey);
      if (this.seenMessages.size > DEDUPE_LIMIT) {
        // Set conserva el orden de inserción: soltamos el más viejo
        const oldest = this.seenMessages.values().next().value;
        if (oldest !== undefined) this.seenMessages.delete(oldest);
      }

      const ts = toMs(m.messageTimestamp);
      const agg = this.ensureChat(jid);
      agg.messages += 1;
      this.messages += 1;
      if (ts) {
        if (!agg.lastMessageAt || ts > agg.lastMessageAt) agg.lastMessageAt = ts;
        if (!agg.firstMessageAt || ts < agg.firstMessageAt) agg.firstMessageAt = ts;
        if (this.oldest === null || ts < this.oldest) this.oldest = ts;
        if (this.newest === null || ts > this.newest) this.newest = ts;
      }
      // en chats individuales el pushName del otro sirve de nombre si no hay nada mejor
      if (!isGroupJid(jid) && !agg.pushName && m.pushName && !m.key?.participant) {
        const fromMe = (m.key as { fromMe?: boolean } | null)?.fromMe;
        if (!fromMe) agg.pushName = m.pushName;
      }
    }
  }

  // ---------------------------------------------------------------- salidas

  summary(): SyncStats {
    const merged = this.mergedChats();

    let groups = 0;
    let individual = 0;
    for (const a of merged.values()) {
      if (a.isGroup) groups += 1;
      else individual += 1;
    }

    const topChats: TopChat[] = [...merged.entries()]
      .filter(([, a]) => a.messages > 0)
      .sort(
        (x, y) =>
          y[1].messages - x[1].messages || (y[1].lastMessageAt ?? 0) - (x[1].lastMessageAt ?? 0),
      )
      .slice(0, TOP_N)
      .map(([jid, a]) => ({
        jid,
        // prioridad: nombre del chat > nombre guardado en la agenda > pushName
        name: a.name ?? this.contactName(jid) ?? a.pushName ?? null,
        phone: phoneOf(jid),
        isGroup: a.isGroup,
        messages: a.messages,
        lastMessageAt: a.lastMessageAt,
      }));

    const contactKeys = new Set([...this.contacts.keys()].map((k) => this.canonical(k)));

    return {
      state: this.state,
      progress: this.progress,
      batches: this.batches,
      lastBatchAt: this.lastBatchAt,
      completionInferred: this.completionInferred,
      contacts: contactKeys.size,
      chats: merged.size,
      individualChats: individual,
      groups,
      messages: this.messages,
      oldestMessageAt: this.oldest,
      newestMessageAt: this.newest,
      lidMappings: this.lidToPn.size,
      topChats,
    };
  }

  /**
   * Personas y grupos para exportar. Solo nombres, números, conteos y fechas:
   * nunca el contenido de los mensajes.
   */
  directory(): Directory {
    const merged = this.mergedChats();
    const people = new Map<string, DirectoryPerson>();
    const person = (jid: string): DirectoryPerson => {
      let p = people.get(jid);
      if (!p) {
        p = {
          jid,
          phone: phoneOf(jid),
          lid: isLidJid(jid) ? jid : null,
          displayName: null,
          savedName: null,
          pushName: null,
          businessName: null,
          inAddressBook: this.hasContactInfo ? false : null,
          messages: 0,
          firstMessageAt: null,
          lastMessageAt: null,
        };
        people.set(jid, p);
      }
      return p;
    };

    for (const [key, legacyName] of this.contacts) {
      const p = person(this.canonical(key));
      if (!p.displayName && legacyName) p.displayName = legacyName;
    }
    for (const [key, info] of this.contactInfo) {
      const p = person(this.canonical(key));
      p.savedName ||= info.name ?? null;
      p.pushName ||= info.notify ?? null;
      p.businessName ||= info.verifiedName ?? null;
      if (info.name) p.inAddressBook = true;
    }
    const chatName = new Map<string, string | null>();
    for (const [jid, agg] of merged) {
      if (agg.isGroup) continue;
      const p = person(jid);
      p.messages = agg.messages;
      p.firstMessageAt = agg.firstMessageAt ?? null;
      p.lastMessageAt = agg.lastMessageAt;
      p.pushName ||= agg.pushName ?? null;
      chatName.set(jid, agg.name);
    }
    const pnToLid = new Map<string, string>();
    for (const [lid, pn] of this.lidToPn) pnToLid.set(pn, lid);
    for (const p of people.values()) {
      p.lid ??= pnToLid.get(p.jid) ?? null;
      p.displayName =
        p.savedName || chatName.get(p.jid) || p.displayName || p.pushName || p.businessName || null;
    }

    const groups: DirectoryGroup[] = [...merged.entries()]
      .filter(([, a]) => a.isGroup)
      .map(([jid, a]) => ({
        jid,
        name: a.name,
        messages: a.messages,
        firstMessageAt: a.firstMessageAt ?? null,
        lastMessageAt: a.lastMessageAt,
      }))
      .sort((x, y) => y.messages - x.messages || (x.name ?? '').localeCompare(y.name ?? ''));

    const byActivity = (x: DirectoryPerson, y: DirectoryPerson) =>
      y.messages - x.messages ||
      (y.lastMessageAt ?? 0) - (x.lastMessageAt ?? 0) ||
      (x.displayName ?? '\uffff').localeCompare(y.displayName ?? '\uffff', 'es');
    return { people: [...people.values()].sort(byActivity), groups };
  }

  snapshot(): StatsSnapshot {
    return {
      v: 1,
      chats: Object.fromEntries(this.chats),
      contacts: Object.fromEntries(this.contacts),
      lidToPn: Object.fromEntries(this.lidToPn),
      messages: this.messages,
      oldest: this.oldest,
      newest: this.newest,
      batches: this.batches,
      lastBatchAt: this.lastBatchAt,
      progress: this.progress,
      state: this.state,
      completionInferred: this.completionInferred,
      syncTypes: Object.fromEntries(this.syncTypes),
      contactInfo: Object.fromEntries(this.contactInfo),
      contactInfoComplete: this.hasContactInfo,
    };
  }

  // ---------------------------------------------------------------- internos

  private restore(s: StatsSnapshot): void {
    this.chats = new Map(Object.entries(s.chats));
    this.contacts = new Map(Object.entries(s.contacts));
    this.lidToPn = new Map(Object.entries(s.lidToPn));
    this.messages = s.messages;
    this.oldest = s.oldest;
    this.newest = s.newest;
    this.batches = s.batches;
    this.lastBatchAt = s.lastBatchAt;
    this.progress = s.progress;
    this.state = s.state;
    this.completionInferred = s.completionInferred;
    this.syncTypes = new Map(Object.entries(s.syncTypes));
    this.contactInfo = new Map(Object.entries(s.contactInfo ?? {}));
    this.hasContactInfo = s.contactInfoComplete === true;
  }

  private mergeInfo(key: string, info: ContactInfo): void {
    const prev = this.contactInfo.get(key) ?? {};
    const next: ContactInfo = {
      name: info.name || prev.name || null,
      notify: info.notify || prev.notify || null,
      verifiedName: info.verifiedName || prev.verifiedName || null,
    };
    if (next.name || next.notify || next.verifiedName || this.contactInfo.has(key))
      this.contactInfo.set(key, next);
  }

  /** chats unificados: el mismo contacto por LID y por número cuenta como uno */
  private mergedChats(): Map<string, ChatAgg> {
    const merged = new Map<string, ChatAgg>();
    for (const [jid, agg] of this.chats) {
      const key = this.canonical(jid);
      const prev = merged.get(key);
      if (!prev) {
        merged.set(key, { ...agg });
      } else {
        prev.messages += agg.messages;
        prev.name = prev.name || agg.name;
        prev.pushName = prev.pushName || agg.pushName || null;
        prev.lastMessageAt = Math.max(prev.lastMessageAt ?? 0, agg.lastMessageAt ?? 0) || null;
        const firsts = [prev.firstMessageAt, agg.firstMessageAt].filter(
          (t): t is number => typeof t === 'number',
        );
        prev.firstMessageAt = firsts.length ? Math.min(...firsts) : null;
      }
    }
    return merged;
  }

  private ensureChat(jid: string): ChatAgg {
    let agg = this.chats.get(jid);
    if (!agg) {
      agg = { name: null, isGroup: isGroupJid(jid), messages: 0, lastMessageAt: null };
      this.chats.set(jid, agg);
    }
    return agg;
  }

  private canonical(jid: string): string {
    return isLidJid(jid) ? (this.lidToPn.get(jid) ?? jid) : jid;
  }

  private contactName(jid: string): string | null {
    return this.contacts.get(jid) ?? this.contacts.get(this.canonical(jid)) ?? null;
  }
}
