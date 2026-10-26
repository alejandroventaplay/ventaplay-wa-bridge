import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import {
  ArrowLeft,
  BriefcaseBusiness,
  CircleCheck,
  CircleHelp,
  Search,
  ShieldCheck,
  TriangleAlert,
  Undo2,
  UserRound,
} from 'lucide-react';
import type {
  PrivacyCategory,
  PrivacyDecision,
  PrivacyRow,
  PrivacyState,
  SessionSummary,
} from '@wa-bridge/shared';
import { api } from '../lib/api';
import { fmtDateTime, fmtNumber, fmtPhone } from '../lib/format';
import { AppShell, Spinner } from '../components/ui';

type Tab = 'revisar' | 'entran' | 'fuera' | 'todos';

const TABS: { key: Tab; label: string }[] = [
  { key: 'revisar', label: 'Por revisar' },
  { key: 'entran', label: 'Entran (laboral)' },
  { key: 'fuera', label: 'Quedan fuera' },
  { key: 'todos', label: 'Todos' },
];

const LABEL: Record<PrivacyCategory, string> = {
  comercial: 'Interés laboral',
  privado: 'Personal',
  revisar: 'Por revisar',
};

const BADGE: Record<PrivacyCategory, string> = {
  comercial: 'bg-turquesa-10 text-turquesa-140',
  privado: 'bg-red-50 text-red-700',
  revisar: 'bg-amber-50 text-amber-800',
};

const PAGE = 150;

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * Filtro personal / interés laboral antes de cargar a VentaPlay: lista por contacto con la
 * sugerencia y su motivo, casilla para decidir a mano y la aprobación final.
 */
export function PrivacyPage() {
  const { id = '' } = useParams();
  const [session, setSession] = useState<SessionSummary | null>(null);
  const [state, setState] = useState<PrivacyState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(0);
  const [tab, setTab] = useState<Tab>('revisar');
  const [q, setQ] = useState('');
  const [onlyChats, setOnlyChats] = useState(true);
  const [more, setMore] = useState({ key: '', n: PAGE });

  useEffect(() => {
    let alive = true;
    Promise.all([api.get(id), api.privacy(id)])
      .then(([s, p]) => {
        if (!alive) return;
        setSession(s);
        setState(p);
      })
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [id]);

  /** guarda decisiones (optimista: la casilla cambia al tiro) */
  const decide = useCallback(
    async (changes: Record<string, PrivacyDecision | null>) => {
      setError(null);
      setState((s) => (s ? applyLocal(s, changes) : s));
      setSaving((n) => n + 1);
      try {
        setState(await api.setPrivacy(id, { decisions: changes }));
      } catch (e) {
        setError(e instanceof Error ? e.message : 'No se pudo guardar');
        api.privacy(id).then(setState, () => {});
      } finally {
        setSaving((n) => n - 1);
      }
    },
    [id],
  );

  const rows = useMemo(() => {
    if (!state) return [];
    const needle = norm(q.trim());
    return state.rows.filter((r) => {
      if (onlyChats && !r.messages) return false;
      if (tab === 'entran' && !r.include) return false;
      if (tab === 'fuera' && r.include) return false;
      if (tab === 'revisar' && (r.suggestion !== 'revisar' || r.decision)) return false;
      if (!needle) return true;
      return norm(`${r.name} ${r.savedName ?? ''} ${r.phone} ${r.lastText ?? ''}`).includes(needle);
    });
  }, [state, tab, q, onlyChats]);

  const pendientes = useMemo(
    () => state?.rows.filter((r) => r.suggestion === 'revisar' && !r.decision && r.messages > 0),
    [state],
  );

  if (!state || !session) {
    return (
      <AppShell>
        <div className="grid place-items-center py-24">
          {error ? (
            <p className="font-bold text-danger">{error}</p>
          ) : (
            <Spinner className="size-6 text-violeta" />
          )}
        </div>
      </AppShell>
    );
  }

  const c = state.counts;
  // al cambiar de pestaña o búsqueda la lista vuelve a mostrar la primera página
  const listKey = `${tab}|${q}|${onlyChats}`;
  const limit = more.key === listKey ? more.n : PAGE;
  const visible = rows.slice(0, limit);

  return (
    <AppShell session={session}>
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <Link to={`/s/${id}`} className="btn-secondary px-3 py-2" aria-label="Volver">
          <ArrowLeft className="size-4" />
        </Link>
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-black tracking-tight">
            Filtro personal / interés laboral
          </h1>
          <p className="text-sm text-ink-soft">
            {session.label ?? session.profile?.name} · antes de cargar a VentaPlay. Nada sale del
            Bridge hasta que se apruebe.
          </p>
        </div>
        {saving > 0 && (
          <span className="ml-auto flex items-center gap-2 text-xs font-bold text-ink-soft">
            <Spinner className="size-3.5" /> Guardando…
          </span>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat
          icon={<BriefcaseBusiness className="size-5" />}
          tone="bg-turquesa-10 text-turquesa-140"
          label="Entran a VentaPlay"
          value={`${fmtNumber(c.incluidos)} contactos`}
          sub={`${fmtNumber(c.conversacionesIncluidas)} con conversación · ${fmtNumber(c.mensajesIncluidos)} mensajes`}
        />
        <Stat
          icon={<UserRound className="size-5" />}
          tone="bg-red-50 text-red-700"
          label="Quedan fuera"
          value={`${fmtNumber(c.excluidos)} contactos`}
          sub={`${fmtNumber(c.privado)} personales sugeridos · ${fmtNumber(c.manuales)} decididos a mano`}
        />
        <Stat
          icon={<CircleHelp className="size-5" />}
          tone="bg-amber-50 text-amber-800"
          label="Por revisar con conversación"
          value={`${fmtNumber(pendientes?.length ?? 0)} contactos`}
          sub={state.reviewIncluded ? 'Si nadie decide, entran' : 'Si nadie decide, quedan fuera'}
        />
      </div>

      <section className="card mt-6 p-4 sm:p-6">
        <div className="flex flex-wrap items-center gap-2">
          {TABS.map((t) => (
            <button
              key={t.key}
              className={`rounded-full px-3 py-1.5 text-sm font-bold ${
                tab === t.key ? 'bg-violeta text-white' : 'bg-violeta-5 text-violeta'
              }`}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          ))}
          <label className="ml-auto flex items-center gap-2 text-sm font-bold text-ink-soft">
            <input
              type="checkbox"
              checked={onlyChats}
              onChange={(e) => setOnlyChats(e.target.checked)}
            />
            Solo con conversación
          </label>
        </div>

        <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-soft" />
            <input
              className="input w-full pl-9"
              placeholder="Buscar por nombre, número o mensaje"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <span className="text-xs font-bold text-ink-soft">
            {fmtNumber(rows.length)} en la lista
          </span>
          {rows.length > 0 && (
            <div className="flex gap-2">
              <button
                className="btn-secondary px-3 py-2 text-xs"
                disabled={saving > 0}
                onClick={() =>
                  void decide(Object.fromEntries(rows.map((r) => [r.phone, 'incluir' as const])))
                }
              >
                Todos entran
              </button>
              <button
                className="btn-secondary px-3 py-2 text-xs"
                disabled={saving > 0}
                onClick={() =>
                  void decide(Object.fromEntries(rows.map((r) => [r.phone, 'excluir' as const])))
                }
              >
                Todos fuera
              </button>
            </div>
          )}
        </div>

        <ul className="mt-4 divide-y divide-line">
          {visible.map((r) => (
            <RowItem key={r.phone} row={r} onDecide={decide} />
          ))}
        </ul>
        {!rows.length && (
          <p className="py-10 text-center text-sm font-bold text-ink-soft">
            {tab === 'revisar'
              ? 'Nada pendiente por revisar aquí.'
              : 'No hay contactos en esta lista.'}
          </p>
        )}
        {rows.length > limit && (
          <button
            className="btn-secondary mx-auto mt-4 flex"
            onClick={() => setMore({ key: listKey, n: limit + PAGE })}
          >
            Ver {fmtNumber(Math.min(PAGE, rows.length - limit))} más
          </button>
        )}
      </section>

      <Approval
        id={id}
        state={state}
        pendientes={pendientes?.length ?? 0}
        defaultBy={session.migration?.consentBy ?? ''}
        onState={setState}
        busy={saving > 0}
      />
    </AppShell>
  );
}

/** aplica decisiones en la vista mientras el servidor confirma */
function applyLocal(
  s: PrivacyState,
  changes: Record<string, PrivacyDecision | null>,
): PrivacyState {
  const rows = s.rows.map((r) => {
    if (!(r.phone in changes)) return r;
    const decision = changes[r.phone] ?? null;
    const include = decision
      ? decision === 'incluir'
      : r.suggestion === 'comercial' || (r.suggestion === 'revisar' && s.reviewIncluded);
    return { ...r, decision, include };
  });
  return { ...s, rows, approval: null };
}

function Stat({
  icon,
  tone,
  label,
  value,
  sub,
}: {
  icon: ReactNode;
  tone: string;
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <div className="card flex gap-3 p-4">
      <span className={`grid size-10 shrink-0 place-items-center rounded-xl ${tone}`}>{icon}</span>
      <div className="min-w-0">
        <p className="text-xs font-bold text-ink-soft">{label}</p>
        <p className="text-lg font-black">{value}</p>
        <p className="text-xs text-ink-soft">{sub}</p>
      </div>
    </div>
  );
}

function RowItem({
  row: r,
  onDecide,
}: {
  row: PrivacyRow;
  onDecide: (c: Record<string, PrivacyDecision | null>) => Promise<void>;
}) {
  const saved = r.savedName && r.savedName !== r.name ? r.savedName : null;
  return (
    <li className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 py-3 lg:grid-cols-[auto_minmax(0,1.1fr)_minmax(0,1.6fr)_minmax(0,1fr)]">
      <label className="flex cursor-pointer flex-col items-center gap-1 pt-1">
        <input
          type="checkbox"
          className="size-5 accent-violeta"
          checked={r.include}
          aria-label={`${r.include ? 'Sacar' : 'Incluir'} a ${r.name}`}
          onChange={() => void onDecide({ [r.phone]: r.include ? 'excluir' : 'incluir' })}
        />
        <span
          className={`text-[10px] font-black ${r.include ? 'text-turquesa-140' : 'text-ink-soft'}`}
        >
          {r.include ? 'ENTRA' : 'FUERA'}
        </span>
      </label>
      <div className="min-w-0">
        <p className="truncate font-black">{r.name}</p>
        {saved && <p className="truncate text-xs text-ink-soft">Agenda: {saved}</p>}
        <p className="text-xs text-ink-soft">
          {fmtPhone(r.phone)} · {fmtNumber(r.messages)} mensajes
        </p>
      </div>
      <div className="col-start-2 min-w-0 lg:col-start-auto">
        <p className="text-xs font-bold text-ink-soft">
          Último mensaje · {r.lastAt ? fmtDateTime(r.lastAt) : 'sin fecha'}
        </p>
        <p className="line-clamp-2 text-sm">
          {r.lastText ? (
            <>
              <span className="font-bold text-ink-soft">
                {r.lastFromMe ? 'Yo: ' : 'Contacto: '}
              </span>
              {r.lastText}
            </>
          ) : (
            <span className="text-ink-soft">Sin conversación guardada</span>
          )}
        </p>
      </div>
      <div className="col-start-2 min-w-0 lg:col-start-auto">
        <span
          className={`inline-block rounded-md px-2 py-0.5 text-xs font-black ${BADGE[r.suggestion]}`}
        >
          {LABEL[r.suggestion]}
        </span>
        {r.reasons[0] && <p className="mt-1 line-clamp-2 text-xs text-ink-soft">{r.reasons[0]}</p>}
        {r.decision && (
          <button
            className="mt-1 flex items-center gap-1 text-xs font-bold text-violeta"
            onClick={() => void onDecide({ [r.phone]: null })}
          >
            <Undo2 className="size-3" /> Decidido a mano · volver a la sugerencia
          </button>
        )}
      </div>
    </li>
  );
}

/** checklist de aprobación final: sin esto el filtro activo no deja cargar a VentaPlay */
function Approval({
  id,
  state,
  pendientes,
  defaultBy,
  onState,
  busy,
}: {
  id: string;
  state: PrivacyState;
  pendientes: number;
  defaultBy: string;
  onState: (s: PrivacyState) => void;
  busy: boolean;
}) {
  const [checks, setChecks] = useState([false, false, false]);
  const [by, setBy] = useState(defaultBy);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const c = state.counts;
  const a = state.approval;
  const items = [
    `Revisé "Por revisar" (quedan ${fmtNumber(pendientes)} sin decidir con conversación; ${
      state.reviewIncluded ? 'entran' : 'quedan fuera'
    }).`,
    `Revisé "Entran (laboral)": no hay conversaciones personales.`,
    `Autorizo cargar a VentaPlay ${fmtNumber(c.incluidos)} contactos y ${fmtNumber(
      c.mensajesIncluidos,
    )} mensajes. Lo demás no sale del Bridge.`,
  ];
  const ready = checks.every(Boolean) && by.trim().length >= 2 && !busy;

  async function approve() {
    setSending(true);
    setError(null);
    try {
      onState(await api.setPrivacy(id, { approve: { by: by.trim() } }));
      setChecks([false, false, false]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo aprobar');
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="card mt-6 p-4 sm:p-6">
      <h2 className="flex items-center gap-2 text-lg font-black">
        <ShieldCheck className="size-5 text-violeta" /> Aprobación final
      </h2>
      {a ? (
        <div className="mt-3 space-y-3 rounded-xl bg-turquesa-10 p-4 text-sm">
          <p className="flex items-start gap-2 font-bold text-turquesa-140">
            <CircleCheck className="mt-0.5 size-4 shrink-0" />
            Aprobado por {a.by} el {fmtDateTime(a.at)}: {fmtNumber(a.contactos)} contactos y{' '}
            {fmtNumber(a.mensajes)} mensajes.
          </p>
          <p className="text-ink-soft">
            Siguiente paso: vuelve al WhatsApp y en <b className="text-ink">Directo a VentaPlay</b>{' '}
            valida e importa. Si cambias algo aquí, hay que aprobar de nuevo.
          </p>
          <Link to={`/s/${id}`} className="btn-primary inline-flex">
            Ir a cargar a VentaPlay
          </Link>
        </div>
      ) : (
        <div className="mt-3 space-y-3">
          {state.updatedAt && state.active && (
            <p className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" /> Falta aprobar: sin esto no se
              carga nada a VentaPlay.
            </p>
          )}
          <label className="flex items-center gap-2 text-sm">
            <span className="font-bold">Por revisar sin decidir:</span>
            <select
              className="input py-1"
              value={state.reviewIncluded ? 'si' : 'no'}
              disabled={busy || sending}
              onChange={(e) =>
                void api
                  .setPrivacy(id, { reviewIncluded: e.target.value === 'si' })
                  .then(onState, (err: Error) => setError(err.message))
              }
            >
              <option value="no">quedan fuera</option>
              <option value="si">entran</option>
            </select>
          </label>
          {items.map((text, i) => (
            <label key={i} className="flex items-start gap-3 text-sm">
              <input
                type="checkbox"
                className="mt-0.5 size-4 accent-violeta"
                checked={checks[i]}
                onChange={(e) =>
                  setChecks((cs) => cs.map((v, j) => (j === i ? e.target.checked : v)))
                }
              />
              <span>{text}</span>
            </label>
          ))}
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              className="input flex-1"
              placeholder="Quién aprueba (nombre)"
              value={by}
              onChange={(e) => setBy(e.target.value)}
            />
            <button
              className="btn-primary"
              disabled={!ready || sending}
              onClick={() => void approve()}
            >
              {sending ? <Spinner className="size-4" /> : <ShieldCheck className="size-4" />}{' '}
              Aprobar y dejar listo para cargar
            </button>
          </div>
        </div>
      )}
      {error && <p className="mt-2 text-xs font-bold text-danger">{error}</p>}
    </section>
  );
}
