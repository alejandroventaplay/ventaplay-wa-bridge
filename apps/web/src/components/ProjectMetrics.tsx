import { useEffect, useState } from 'react';
import { BarChart3, Clock, Mic } from 'lucide-react';
import type { ProjectMetrics as Metrics } from '@wa-bridge/shared';
import { api } from '../lib/api';
import { fmtAgo, fmtNumber } from '../lib/format';
import { Spinner } from './ui';

const RANGES: { label: string; days: number | undefined }[] = [
  { label: '7 días', days: 7 },
  { label: '30 días', days: 30 },
  { label: '90 días', days: 90 },
  { label: 'Todo', days: undefined },
];

function fmtMinutes(m: number | null): string {
  if (m === null) return '—';
  if (m < 1) return '< 1 min';
  if (m < 60) return `${Math.round(m)} min`;
  const h = m / 60;
  return h < 24 ? `${h.toFixed(h < 10 ? 1 : 0)} h` : `${Math.round(h / 24)} d`;
}

function fmtVoice(seconds: number): string {
  if (!seconds) return '';
  const min = Math.round(seconds / 60);
  return min ? ` · ${min} min` : ` · ${seconds} s`;
}

/** Métricas por persona de un chat seguido de cerca */
export function ProjectMetrics({
  sessionId,
  jid,
  version,
}: {
  sessionId: string;
  jid: string;
  version: string;
}) {
  const [days, setDays] = useState<number | undefined>(30);
  const [data, setData] = useState<Metrics | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => {
      api
        .projectMetrics(sessionId, jid, days)
        .then((m) => alive && (setData(m), setError(null)))
        .catch((e: Error) => alive && setError(e.message));
    }, 0);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [sessionId, jid, days, version]);

  const maxDay = Math.max(1, ...(data?.byDay.map((d) => d.messages) ?? [1]));
  const maxHour = Math.max(1, ...(data?.byHour ?? [1]));
  const top = data?.people[0]?.messages ?? 1;

  return (
    <section className="card p-5">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <BarChart3 className="size-5 text-violeta" />
        <h3 className="flex-1 text-lg font-black">Métricas por persona</h3>
        <div className="flex gap-1 rounded-full bg-canvas p-1">
          {RANGES.map((r) => (
            <button
              key={r.label}
              onClick={() => setDays(r.days)}
              className={`rounded-full px-3 py-1 text-xs font-bold transition ${
                days === r.days ? 'bg-white text-violeta shadow-sm' : 'text-ink-soft hover:text-ink'
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {error && <p className="text-sm text-danger">{error}</p>}
      {!data && !error && (
        <div className="grid place-items-center py-10 text-violeta">
          <Spinner className="size-6" />
        </div>
      )}
      {data && data.total === 0 && (
        <p className="py-6 text-center text-sm text-ink-soft">No hay mensajes en este período.</p>
      )}
      {data && data.total > 0 && (
        <>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="text-left text-xs text-ink-soft">
                  <th className="pb-2 font-bold">Persona</th>
                  <th className="pb-2 font-bold">Mensajes</th>
                  <th className="pb-2 text-right font-bold">Palabras</th>
                  <th className="pb-2 text-right font-bold">Notas de voz</th>
                  <th className="pb-2 text-right font-bold">Archivos</th>
                  <th
                    className="pb-2 text-right font-bold"
                    title="Mediana de cuánto tarda en responder a otro (dentro de 12 h)"
                  >
                    <Clock className="mr-1 inline size-3.5" />
                    Responde en
                  </th>
                  <th className="pb-2 text-right font-bold">Último</th>
                </tr>
              </thead>
              <tbody>
                {data.people.map((p) => (
                  <tr key={p.key} className="border-t border-line/60">
                    <td className="py-2 pr-3">
                      <span className={`font-bold ${p.fromMe ? 'text-violeta' : 'text-ink'}`}>
                        {p.name}
                      </span>
                    </td>
                    <td className="py-2 pr-3">
                      <div className="flex items-center gap-2">
                        <div className="h-2 w-28 overflow-hidden rounded-full bg-canvas">
                          <div
                            className={`h-full rounded-full ${p.fromMe ? 'bg-violeta' : 'bg-turquesa'}`}
                            style={{ width: `${(p.messages / top) * 100}%` }}
                          />
                        </div>
                        <span className="tabular-nums">
                          {fmtNumber(p.messages)}{' '}
                          <span className="text-xs text-ink-soft">
                            ({Math.round(p.share * 100)}%)
                          </span>
                        </span>
                      </div>
                    </td>
                    <td className="py-2 text-right tabular-nums">{fmtNumber(p.words)}</td>
                    <td className="py-2 text-right tabular-nums">
                      {p.voiceNotes ? (
                        <span title="notas de voz · minutos">
                          <Mic className="mr-1 inline size-3.5 text-turquesa-140" />
                          {p.voiceNotes}
                          {fmtVoice(p.voiceSeconds)}
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="py-2 text-right tabular-nums">{p.media || '—'}</td>
                    <td className="py-2 text-right tabular-nums">
                      {fmtMinutes(p.medianReplyMinutes)}
                      {p.replies ? (
                        <span className="text-xs text-ink-soft"> · {p.replies}</span>
                      ) : null}
                    </td>
                    <td className="py-2 text-right text-xs text-ink-soft">
                      {p.last ? fmtAgo(p.last) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <div>
              <p className="mb-2 text-xs font-bold text-ink-soft">Mensajes por día</p>
              <div className="flex h-24 items-end gap-px">
                {data.byDay.slice(-60).map((d) => (
                  <div
                    key={d.day}
                    title={`${d.day}: ${d.messages} mensajes`}
                    className="min-w-[3px] flex-1 rounded-t bg-violeta/70 hover:bg-violeta"
                    style={{ height: `${Math.max(4, (d.messages / maxDay) * 100)}%` }}
                  />
                ))}
              </div>
            </div>
            <div>
              <p className="mb-2 text-xs font-bold text-ink-soft">Por hora del día</p>
              <div className="grid grid-cols-12 gap-1">
                {data.byHour.map((n, h) => (
                  <div
                    key={h}
                    title={`${String(h).padStart(2, '0')}:00 · ${n} mensajes`}
                    className="aspect-square rounded bg-turquesa"
                    style={{ opacity: n ? 0.15 + 0.85 * (n / maxHour) : 0.06 }}
                  />
                ))}
              </div>
              <div className="mt-1 flex justify-between text-[10px] text-ink-soft">
                <span>0 h</span>
                <span>12 h</span>
                <span>23 h</span>
              </div>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
