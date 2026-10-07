const nf = new Intl.NumberFormat('es-CL');
const df = new Intl.DateTimeFormat('es-CL', { day: 'numeric', month: 'short', year: 'numeric' });
const dtf = new Intl.DateTimeFormat('es-CL', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

export const fmtNumber = (n: number) => nf.format(n);
export const fmtDate = (ms: number | null | undefined) => (ms ? df.format(new Date(ms)) : '—');
export const fmtDateTime = (ms: number | null | undefined) => (ms ? dtf.format(new Date(ms)) : '—');

/** 56912345678 → +56 9 1234 5678 · otros países: +<dígitos> */
export function fmtPhone(phone: string | null | undefined): string {
  if (!phone) return '';
  const d = phone.replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('569')) return `+56 9 ${d.slice(3, 7)} ${d.slice(7)}`;
  if (d.length === 11 && d.startsWith('56'))
    return `+56 ${d.slice(2, 3)} ${d.slice(3, 7)} ${d.slice(7)}`;
  return `+${d}`;
}

/** "hace 3 min", "hace 2 días" */
export function fmtAgo(ms: number | null | undefined, now = Date.now()): string {
  if (!ms) return '—';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return 'recién';
  const m = Math.round(s / 60);
  if (m < 60) return `hace ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `hace ${h} h`;
  const days = Math.round(h / 24);
  if (days < 30) return `hace ${days} ${days === 1 ? 'día' : 'días'}`;
  const months = Math.round(days / 30);
  if (months < 12) return `hace ${months} ${months === 1 ? 'mes' : 'meses'}`;
  const years = Math.round(months / 12);
  return `hace ${years} ${years === 1 ? 'año' : 'años'}`;
}

/** duración entre dos fechas en palabras: "1 año y 8 meses" */
export function fmtSpan(from: number | null, to: number | null): string {
  if (!from || !to || to <= from) return '—';
  const months = Math.floor((to - from) / (30.44 * 24 * 3600 * 1000));
  if (months < 1) {
    const days = Math.max(1, Math.round((to - from) / (24 * 3600 * 1000)));
    return `${days} ${days === 1 ? 'día' : 'días'}`;
  }
  const y = Math.floor(months / 12);
  const m = months % 12;
  const ys = y ? `${y} ${y === 1 ? 'año' : 'años'}` : '';
  const ms = m ? `${m} ${m === 1 ? 'mes' : 'meses'}` : '';
  return [ys, ms].filter(Boolean).join(' y ');
}

export const initials = (name: string | null | undefined) =>
  (name ?? '')
    .split(/\s+/)
    .filter((w) => /\p{L}/u.test(w))
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('') || '?';
