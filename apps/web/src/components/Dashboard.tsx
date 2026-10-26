import { useEffect, useState } from 'react';
import {
  BadgeCheck,
  CalendarRange,
  CircleCheck,
  Contact,
  Download,
  FileSpreadsheet,
  MessagesSquare,
  MessageCircle,
  PauseCircle,
  Users,
  Unplug,
} from 'lucide-react';
import type { SessionSummary, SyncStats, TopChat } from '@wa-bridge/shared';
import { useNow } from '../hooks/streams';
import { api, type ExportPreview } from '../lib/api';
import { fmtAgo, fmtDate, fmtNumber, fmtPhone, fmtSpan } from '../lib/format';
import { Avatar, Spinner } from './ui';
import { ConversationsExporter, VentaPlayExporter } from './MigrationPanel';

interface Props {
  session: SessionSummary;
  onDisconnect: () => void;
}

/** Info general del WhatsApp conectado. */
export function Dashboard({ session, onDisconnect }: Props) {
  const { profile, stats } = session;
  const now = useNow(30_000);
  const connected = session.status === 'connected' || session.status === 'reconnecting';

  return (
    <div className="space-y-6">
      {/* perfil */}
      <section className="card flex flex-col gap-5 p-6 sm:flex-row sm:items-center">
        <Avatar name={profile?.name ?? session.label} src={profile?.pictureUrl} size={72} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-2xl font-black">
              {profile?.name ?? session.label ?? 'WhatsApp'}
            </h2>
            {profile?.isBusiness && (
              <span className="inline-flex items-center gap-1 rounded-full bg-green-50 px-2 py-0.5 text-xs font-bold text-green-700">
                <BadgeCheck className="size-3.5" /> Business
              </span>
            )}
          </div>
          <p className="mt-0.5 text-lg font-bold tabular-nums text-ink-soft">
            {fmtPhone(profile?.phone)}
          </p>
          <p className="mt-1 text-sm text-ink-soft">
            {[profile?.business?.category, profile?.business?.address]
              .filter(Boolean)
              .join(' · ') || ' '}
          </p>
        </div>
        <div className="flex flex-col items-start gap-3 sm:items-end">
          <p className="text-xs text-ink-soft">
            {connected ? 'Conectado' : 'Última conexión'} {fmtAgo(session.connectedAt, now)}
          </p>
          {connected && (
            <button className="btn-danger" onClick={onDisconnect}>
              <Unplug className="size-4" /> Desconectar WhatsApp
            </button>
          )}
        </div>
      </section>

      <SyncBanner stats={stats} />

      {/* totales */}
      <section className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Tile icon={<Contact className="size-5" />} label="Contactos" value={stats.contacts} />
        <Tile
          icon={<MessageCircle className="size-5" />}
          label="Chats individuales"
          value={stats.individualChats}
        />
        <Tile icon={<Users className="size-5" />} label="Grupos" value={stats.groups} />
        <Tile
          icon={<MessagesSquare className="size-5" />}
          label="Mensajes"
          value={stats.messages}
          accent
        />
      </section>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <TopChats chats={stats.topChats} />
        <HistoryRange stats={stats} />
      </div>

      <Exporters session={session} />
    </div>
  );
}

/** Formas de sacar lo que llegó del teléfono. Cada exportador es una fila. */
function Exporters({ session }: { session: SessionSummary }) {
  const { stats } = session;
  const hasData = stats.contacts + stats.chats > 0;
  return (
    <section className="card p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="flex items-center gap-2 text-lg font-black">
          <Download className="size-5 text-violeta" /> Exportar
        </h3>
        <span className="text-xs font-bold text-ink-soft">
          {session.migration
            ? 'Modo migración: incluye las conversaciones'
            : 'Nombres, números y fechas · nunca el contenido de los mensajes'}
        </span>
      </div>
      <ul className="mt-5 divide-y divide-line">
        <ExcelContactsExporter session={session} disabled={!hasData} />
        {session.migration && <ConversationsExporter session={session} />}
        <VentaPlayExporter session={session} />
      </ul>
    </section>
  );
}

function ExcelContactsExporter({
  session,
  disabled,
}: {
  session: SessionSummary;
  disabled: boolean;
}) {
  const [busy, setBusy] = useState<'util' | 'completo' | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ExportPreview | null>(null);
  const { stats } = session;

  // se recalcula cuando llegan contactos o números nuevos (con calma: el sync manda muchos lotes)
  useEffect(() => {
    if (disabled) return;
    let alive = true;
    const t = setTimeout(() => {
      api
        .exportPreview(session.id)
        .then((p) => alive && setPreview(p))
        .catch(() => {});
    }, 800);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [session.id, disabled, stats.contacts, stats.chats, stats.lidMappings]);

  async function run(modo: 'util' | 'completo') {
    setBusy(modo);
    setError(null);
    setDone(null);
    try {
      setDone(await api.downloadContactsXlsx(session.id, modo));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <li className="flex flex-col gap-4 py-4 first:pt-0 sm:flex-row sm:items-start">
      <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-green-50 text-green-700">
        <FileSpreadsheet className="size-5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-black">Excel de contactos</p>
        <p className="text-sm text-ink-soft">
          <b className="text-ink">Útil:</b> solo contactos con nombre y celular, listos para el CRM.{' '}
          <b className="text-ink">Completa:</b> todo lo que llegó, con grupos e IDs de WhatsApp.
        </p>
        {preview ? (
          <p className="mt-2 text-xs leading-relaxed text-ink-soft">
            <b className="text-green-700">{fmtNumber(preview.useful)} útiles</b> de{' '}
            {fmtNumber(preview.total)} contactos. Quedan fuera{' '}
            <b>{fmtNumber(preview.noPhone)} sin número</b> (WhatsApp solo nos dio su ID interno) y{' '}
            <b>{fmtNumber(preview.noName)} sin nombre</b>.
          </p>
        ) : (
          <p className="mt-2 text-xs font-bold text-ink-soft">
            {fmtNumber(stats.contacts)} contactos · {fmtNumber(stats.groups)} grupos
          </p>
        )}
        {done && <p className="mt-1 text-xs font-bold text-green-700">Descargado: {done}</p>}
        {error && <p className="mt-1 text-xs font-bold text-danger">{error}</p>}
      </div>
      <div className="flex shrink-0 flex-wrap gap-2 sm:flex-col sm:items-stretch">
        <button
          className="btn-primary"
          onClick={() => void run('util')}
          disabled={disabled || busy !== null}
        >
          {busy === 'util' ? <Spinner className="size-4" /> : <Download className="size-4" />}{' '}
          Descargar útil{preview ? ` (${fmtNumber(preview.useful)})` : ''}
        </button>
        <button
          className="btn-secondary"
          onClick={() => void run('completo')}
          disabled={disabled || busy !== null}
        >
          {busy === 'completo' ? <Spinner className="size-4" /> : <Download className="size-4" />}{' '}
          Completa{preview ? ` (${fmtNumber(preview.total)})` : ''}
        </button>
      </div>
    </li>
  );
}

function SyncBanner({ stats }: { stats: SyncStats }) {
  const now = useNow(15_000);
  const phases = <SyncPhases stats={stats} />;

  if (stats.state === 'complete') {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
        <CircleCheck className="size-5 shrink-0" />
        <span>
          <b>Historial completo.</b> {fmtNumber(stats.batches)} lotes recibidos desde el teléfono
          {stats.completionInferred &&
            ' (el teléfono no envió el historial antiguo; puede llegar más si lo abres)'}
          .
        </span>
      </div>
    );
  }

  const pct = stats.progress ?? null;
  const paused = stats.state === 'paused';
  return (
    <div className={`card p-5 ${paused ? 'border-amber-200 bg-amber-50/60' : ''}`}>
      <div className="flex items-center gap-3">
        {paused ? (
          <PauseCircle className="size-5 shrink-0 text-amber-600" />
        ) : (
          <Spinner className="size-5 text-violeta" />
        )}
        <div className="flex-1">
          <p className="font-black">
            {stats.state === 'waiting'
              ? 'Esperando el historial del teléfono…'
              : paused
                ? 'Historial en pausa'
                : 'Copiando historial…'}
          </p>
          <p className="text-sm text-ink-soft">
            {stats.state === 'waiting'
              ? 'WhatsApp suele empezar a enviarlo en unos segundos. Deja el teléfono encendido y con internet.'
              : paused
                ? `El teléfono dejó de enviar ${fmtAgo(stats.lastBatchAt, now)}. Abre WhatsApp en el teléfono y déjalo en pantalla, con Wi-Fi y cargando: así sigue. Termina recién al llegar al 100%.`
                : `Lote ${fmtNumber(stats.batches)} · los números de abajo se actualizan en vivo. El teléfono manda por partes y puede pausar.`}
          </p>
          {phases}
        </div>
        {pct !== null && (
          <span
            className={`text-2xl font-black tabular-nums ${paused ? 'text-amber-700' : 'text-violeta'}`}
          >
            {pct}%
          </span>
        )}
      </div>
      <div
        className={`mt-4 h-2 overflow-hidden rounded-full ${paused ? 'bg-amber-100' : 'bg-violeta-5'}`}
      >
        <div
          className={`h-full rounded-full transition-[width] duration-500 ${
            paused ? 'bg-amber-400' : 'bg-gradient-to-r from-turquesa to-violeta-60'
          } ${pct === null ? 'w-1/3 animate-pulse' : ''}`}
          style={pct === null ? undefined : { width: `${Math.max(4, pct)}%` }}
        />
      </div>
    </div>
  );
}

/** "Recientes 100% · Historial completo 79%" */
function SyncPhases({ stats }: { stats: SyncStats }) {
  const items = [
    { label: 'Recientes', value: stats.recentProgress },
    { label: 'Historial completo', value: stats.fullProgress },
  ].filter((i) => i.value !== null && i.value !== undefined);
  if (items.length === 0) return null;
  return (
    <p className="mt-1 flex flex-wrap gap-x-3 text-xs font-bold text-ink-soft">
      {items.map((i) => (
        <span key={i.label}>
          {i.label} {i.value === 100 ? '✓' : `${i.value}%`}
        </span>
      ))}
    </p>
  );
}

function Tile({
  icon,
  label,
  value,
  accent = false,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  accent?: boolean;
}) {
  return (
    <div
      className={`card p-5 ${accent ? 'bg-gradient-to-br from-violeta to-violeta-80 text-white' : ''}`}
    >
      <span
        className={`grid size-9 place-items-center rounded-xl ${accent ? 'bg-white/15 text-white' : 'bg-violeta-5 text-violeta'}`}
      >
        {icon}
      </span>
      <p className={`mt-4 text-3xl font-black tabular-nums ${accent ? '' : 'text-ink'}`}>
        {fmtNumber(value)}
      </p>
      <p className={`text-sm font-bold ${accent ? 'text-white/80' : 'text-ink-soft'}`}>{label}</p>
    </div>
  );
}

function TopChats({ chats }: { chats: TopChat[] }) {
  const max = Math.max(1, ...chats.map((c) => c.messages));
  return (
    <section className="card p-6">
      <div className="flex items-baseline justify-between">
        <h3 className="text-lg font-black">Chats con más mensajes</h3>
        <span className="text-xs font-bold text-ink-soft">Top {chats.length || 10}</span>
      </div>
      {chats.length === 0 ? (
        <p className="mt-6 text-sm text-ink-soft">
          Aparecerán apenas lleguen los primeros mensajes del historial.
        </p>
      ) : (
        <ol className="mt-5 space-y-3.5">
          {chats.map((c, i) => (
            <li
              key={c.jid}
              className="grid grid-cols-[1.5rem_minmax(0,1fr)_auto] items-center gap-3"
            >
              <span className="text-right text-xs font-bold tabular-nums text-ink-soft">
                {i + 1}
              </span>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  {c.isGroup && (
                    <Users className="size-3.5 shrink-0 text-ink-soft" aria-label="Grupo" />
                  )}
                  <span className="truncate text-sm font-bold">
                    {c.name || fmtPhone(c.phone) || 'Sin nombre'}
                  </span>
                  {c.name && c.phone && (
                    <span className="hidden truncate text-xs text-ink-soft sm:inline">
                      {fmtPhone(c.phone)}
                    </span>
                  )}
                </div>
                <div className="mt-1.5 h-1.5 rounded-full bg-violeta-5">
                  <div
                    className={`h-full rounded-full ${i === 0 ? 'bg-violeta' : 'bg-violeta-60/60'}`}
                    style={{ width: `${(c.messages / max) * 100}%` }}
                  />
                </div>
              </div>
              <span className="text-sm font-black tabular-nums">{fmtNumber(c.messages)}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function HistoryRange({ stats }: { stats: SyncStats }) {
  return (
    <section className="card p-6">
      <h3 className="flex items-center gap-2 text-lg font-black">
        <CalendarRange className="size-5 text-violeta" /> Historial recibido
      </h3>
      <dl className="mt-5 space-y-4 text-sm">
        <Row label="Mensaje más antiguo" value={fmtDate(stats.oldestMessageAt)} />
        <Row label="Mensaje más reciente" value={fmtDate(stats.newestMessageAt)} />
        <Row
          label="Cobertura"
          value={fmtSpan(stats.oldestMessageAt, stats.newestMessageAt)}
          strong
        />
        <Row label="Chats totales" value={fmtNumber(stats.chats)} />
        <Row label="LID resueltos a número" value={fmtNumber(stats.lidMappings)} />
      </dl>
      <p className="mt-5 text-xs leading-relaxed text-ink-soft">
        WhatsApp decide cuánto historial entrega. Si falta, en el próximo sprint pediremos más con
        “cargar historial anterior”.
      </p>
    </section>
  );
}

function Row({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-dashed border-line pb-3 last:border-0 last:pb-0">
      <dt className="text-ink-soft">{label}</dt>
      <dd className={`text-right tabular-nums ${strong ? 'font-black text-violeta' : 'font-bold'}`}>
        {value}
      </dd>
    </div>
  );
}
