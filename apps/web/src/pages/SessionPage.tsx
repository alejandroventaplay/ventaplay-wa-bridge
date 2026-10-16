import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import {
  ArrowLeft,
  LayoutDashboard,
  MessagesSquare,
  RefreshCw,
  Trash2,
  TriangleAlert,
  Unplug,
  WifiOff,
} from 'lucide-react';
import type { SessionSummary } from '@wa-bridge/shared';
import { useAuth } from '../hooks/auth';
import { useSessionStream } from '../hooks/streams';
import { api } from '../lib/api';
import { AppShell, Dialog, Spinner, StatusBadge } from '../components/ui';
import { Dashboard } from '../components/Dashboard';
import { LinkView } from '../components/LinkView';
import { MyView } from '../components/MyView';

type Confirm = 'logout' | 'delete' | null;

export function SessionPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { state } = useAuth();
  const simulator = state.phase === 'signed-in' && state.health.driver === 'simulator';
  const { session, setSession, gone } = useSessionStream(id);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [error, setError] = useState<string | null>(null);
  const [params, setParams] = useSearchParams();

  async function run(fn: () => Promise<SessionSummary | void>) {
    setBusy(true);
    setError(null);
    try {
      const s = await fn();
      if (s) setSession(s);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (gone) {
    return (
      <AppShell>
        <div className="card p-10 text-center">
          <p className="text-lg font-black">Esta conexión ya no existe</p>
          <Link to="/" className="btn-primary mt-6">
            Volver al inicio
          </Link>
        </div>
      </AppShell>
    );
  }

  if (!session || !id) {
    return (
      <AppShell>
        <div className="grid place-items-center py-32 text-violeta">
          <Spinner className="size-8" />
        </div>
      </AppShell>
    );
  }

  // "Mi vista" solo existe para el WhatsApp del dueño; por defecto se abre ahí
  const tab: 'general' | 'mia' =
    session.personal && params.get('vista') !== 'general' ? 'mia' : 'general';
  const setTab = (t: 'general' | 'mia') =>
    setParams(
      (p) => {
        p.set('vista', t);
        return p;
      },
      { replace: true },
    );

  const linkedView =
    ['connected', 'reconnecting'].includes(session.status) ||
    (session.profile !== null && ['connecting', 'error', 'logged_out'].includes(session.status));

  return (
    <AppShell>
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <Link to="/" className="btn-secondary px-3 py-2" aria-label="Volver">
          <ArrowLeft className="size-4" />
        </Link>
        <h1 className="mr-1 truncate text-2xl font-black tracking-tight">
          {session.label ?? 'WhatsApp sin nombre'}
        </h1>
        <StatusBadge status={session.status} />
        <div className="ml-auto flex gap-2">
          {['logged_out', 'qr_expired', 'error'].includes(session.status) && (
            <button className="btn-secondary" onClick={() => setConfirm('delete')} disabled={busy}>
              <Trash2 className="size-4" /> Eliminar
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="mb-6 flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <TriangleAlert className="size-4" /> {error}
        </div>
      )}

      {linkedView ? (
        <>
          <StatusNotice
            session={session}
            busy={busy}
            onReconnect={() => void run(() => api.connect(id))}
          />
          {session.personal && <Tabs tab={tab} onChange={setTab} />}
          {tab === 'mia' ? (
            <MyView session={session} />
          ) : (
            <Dashboard session={session} onDisconnect={() => setConfirm('logout')} />
          )}
        </>
      ) : (
        <LinkView
          session={session}
          busy={busy}
          onNewQr={() => void run(() => api.connect(id))}
          onSimulateScan={
            simulator ? () => void run(async () => void (await api.simulateScan(id))) : undefined
          }
        />
      )}

      <Dialog
        open={confirm === 'logout'}
        onClose={() => setConfirm(null)}
        title="¿Desconectar este WhatsApp?"
        footer={
          <>
            <button className="btn-secondary" onClick={() => setConfirm(null)} data-autofocus>
              Cancelar
            </button>
            <button
              className="btn-danger-solid"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const s = await api.logout(id);
                  setConfirm(null);
                  return s;
                })
              }
            >
              {busy ? <Spinner className="size-4" /> : <Unplug className="size-4" />} Desconectar
            </button>
          </>
        }
      >
        Se cerrará la sesión de VentaPlay en <b>Dispositivos vinculados</b> del teléfono y
        borraremos las credenciales de este servidor. Las estadísticas quedan guardadas.
      </Dialog>

      <Dialog
        open={confirm === 'delete'}
        onClose={() => setConfirm(null)}
        title="¿Eliminar esta conexión?"
        footer={
          <>
            <button className="btn-secondary" onClick={() => setConfirm(null)} data-autofocus>
              Cancelar
            </button>
            <button
              className="btn-danger-solid"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await api.remove(id);
                  navigate('/');
                })
              }
            >
              <Trash2 className="size-4" /> Eliminar
            </button>
          </>
        }
      >
        Se borra el registro y sus estadísticas. Esta acción no se puede deshacer.
      </Dialog>
    </AppShell>
  );
}

function StatusNotice({
  session,
  busy,
  onReconnect,
}: {
  session: SessionSummary;
  busy: boolean;
  onReconnect: () => void;
}) {
  if (session.status === 'reconnecting' || session.status === 'connecting') {
    return (
      <div className="mb-6 flex items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        <WifiOff className="size-4 shrink-0" />
        <span className="flex-1">
          <b>Reconectando con WhatsApp…</b>{' '}
          {session.lastError && <span className="opacity-80">({session.lastError})</span>}
        </span>
        <Spinner className="size-4" />
      </div>
    );
  }
  if (session.status === 'logged_out' || session.status === 'error') {
    return (
      <div
        className={`mb-6 flex flex-wrap items-center gap-3 rounded-xl border px-4 py-3 text-sm ${
          session.status === 'error'
            ? 'border-red-200 bg-red-50 text-red-900'
            : 'border-line bg-white text-ink'
        }`}
      >
        <Unplug className="size-4 shrink-0" />
        <span className="min-w-0 flex-1">
          <b>
            {session.status === 'error'
              ? 'La conexión se detuvo.'
              : 'Este WhatsApp está desconectado.'}
          </b>{' '}
          {session.lastError ?? 'Mostramos lo último que se copió.'}
        </span>
        <button className="btn-primary py-2" onClick={onReconnect} disabled={busy}>
          {busy ? <Spinner className="size-4" /> : <RefreshCw className="size-4" />}
          {session.status === 'error' ? 'Reintentar' : 'Volver a vincular'}
        </button>
      </div>
    );
  }
  return null;
}

function Tabs({
  tab,
  onChange,
}: {
  tab: 'general' | 'mia';
  onChange: (t: 'general' | 'mia') => void;
}) {
  const item = (key: 'general' | 'mia', label: string, icon: ReactNode) => (
    <button
      role="tab"
      aria-selected={tab === key}
      onClick={() => onChange(key)}
      className={`-mb-px inline-flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-bold transition ${
        tab === key
          ? 'border-violeta text-violeta'
          : 'border-transparent text-ink-soft hover:text-ink'
      }`}
    >
      {icon}
      {label}
    </button>
  );
  return (
    <div role="tablist" className="mb-5 flex gap-1 border-b border-line">
      {item('mia', 'Mi vista', <MessagesSquare className="size-4" />)}
      {item('general', 'General', <LayoutDashboard className="size-4" />)}
    </div>
  );
}
