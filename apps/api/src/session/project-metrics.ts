import type { ArchivedMessage, PersonMetrics, ProjectMetrics } from '@wa-bridge/shared';

const TZ = 'America/Santiago';
/** una respuesta cuenta si llega dentro de 12 h del mensaje anterior de otra persona */
const REPLY_WINDOW_MS = 12 * 3_600_000;

const dayFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const hourFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ,
  hour: '2-digit',
  hourCycle: 'h23',
});

function personKey(m: ArchivedMessage): string {
  if (m.fromMe) return 'yo';
  return m.sender.jid ?? m.sender.lid ?? m.sender.phone ?? '?';
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

const COUNTED = new Set(['deleted', 'other']);

/** quién habla, cuánto, cuándo y qué tan rápido responde (solo con lo guardado en el equipo) */
export function computeProjectMetrics(
  jid: string,
  messages: ArchivedMessage[],
  opts: { days?: number | null; now?: number } = {},
): ProjectMetrics {
  const now = opts.now ?? Date.now();
  const days = opts.days ?? null;
  const cutoff = days ? now - days * 86_400_000 : -Infinity;
  const list = messages
    .filter((m) => m.timestamp >= cutoff && !COUNTED.has(m.kind))
    .sort((a, b) => a.timestamp - b.timestamp);

  const people = new Map<string, PersonMetrics & { gaps: number[] }>();
  const byDay = new Map<string, number>();
  const byHour = Array.from({ length: 24 }, () => 0);
  let prev: ArchivedMessage | null = null;

  for (const m of list) {
    const key = personKey(m);
    let p = people.get(key);
    if (!p) {
      p = {
        key,
        name: m.fromMe
          ? 'Tú'
          : (m.sender.name ?? m.sender.pushName ?? m.sender.phone ?? 'Sin nombre'),
        phone: m.fromMe ? null : m.sender.phone,
        fromMe: m.fromMe,
        messages: 0,
        share: 0,
        words: 0,
        media: 0,
        voiceNotes: 0,
        voiceSeconds: 0,
        first: null,
        last: null,
        replies: 0,
        medianReplyMinutes: null,
        gaps: [],
      };
      people.set(key, p);
    }
    p.messages += 1;
    if (m.text) p.words += m.text.split(/\s+/).filter(Boolean).length;
    if (m.media) p.media += 1;
    if (m.kind === 'voice') {
      p.voiceNotes += 1;
      p.voiceSeconds += m.media?.seconds ?? 0;
    }
    p.first ??= m.timestamp;
    p.last = m.timestamp;
    if (prev && personKey(prev) !== key) {
      const gap = m.timestamp - prev.timestamp;
      if (gap >= 0 && gap <= REPLY_WINDOW_MS) p.gaps.push(gap / 60_000);
    }
    const d = new Date(m.timestamp);
    const day = dayFmt.format(d);
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
    const h = Number(hourFmt.format(d)) % 24;
    byHour[h] = (byHour[h] ?? 0) + 1;
    prev = m;
  }

  const total = list.length;
  const out: PersonMetrics[] = [...people.values()]
    .map(({ gaps, ...p }) => ({
      ...p,
      share: total ? p.messages / total : 0,
      replies: gaps.length,
      medianReplyMinutes: median(gaps) === null ? null : Math.round(median(gaps)! * 10) / 10,
    }))
    .sort((a, b) => b.messages - a.messages);

  return {
    jid,
    days,
    from: list[0]?.timestamp ?? null,
    to: list.at(-1)?.timestamp ?? null,
    total,
    people: out,
    byDay: [...byDay.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, n]) => ({ day, messages: n })),
    byHour,
  };
}
