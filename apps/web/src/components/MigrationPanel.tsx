import { useEffect, useState } from 'react';
import {
  ArrowRightLeft,
  CircleCheck,
  Download,
  FileSpreadsheet,
  KeyRound,
  Lock,
  PauseCircle,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
  Workflow,
} from 'lucide-react';
import type { SessionSummary, VentaPlayState } from '@wa-bridge/shared';
import { api } from '../lib/api';
import { fmtDateTime, fmtNumber } from '../lib/format';
import { Dialog, Spinner } from './ui';

// ------------------------------------------------------------ activar el modo

/** Oferta de "Migrar a VentaPlay": guardar las conversaciones antes de escanear el QR. */
export function MigrationOffer({
  session,
  onEnable,
}: {
  session: SessionSummary;
  onEnable: (consentBy: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [who, setWho] = useState('');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const linked = session.profile !== null && session.status !== 'logged_out';

  async function enable() {
    setBusy(true);
    setError(null);
    try {
      await onEnable(who.trim());
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo activar');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="card mb-6 flex flex-wrap items-center gap-4 border-turquesa/30 bg-gradient-to-r from-turquesa/5 to-violeta/5 p-5">
        <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-turquesa text-white">
          <ArrowRightLeft className="size-6" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-black text-ink">Migrar este WhatsApp a VentaPlay</p>
          <p className="text-sm text-ink-soft">
            Guarda los contactos <b>y las conversaciones</b> para llevarlas al CRM de la
            organización. Hoy solo se guardan contactos y estadísticas.
          </p>
        </div>
        <button className="btn-primary" onClick={() => setOpen(true)}>
          <ArrowRightLeft className="size-4" /> Migrar a VentaPlay
        </button>
      </div>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Migrar a VentaPlay"
        footer={
          <>
            <button className="btn-secondary" onClick={() => setOpen(false)} data-autofocus>
              Cancelar
            </button>
            <button
              className="btn-primary"
              disabled={!consent || !who.trim() || busy}
              onClick={() => void enable()}
            >
              {busy ? <Spinner className="size-4" /> : <ShieldCheck className="size-4" />}
              Activar y pedir QR
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <p>
            Desde ahora se guardan <b>todas las conversaciones</b> de este número, cifradas en este
            equipo, para exportarlas o importarlas a VentaPlay. Se borran al desvincular o al apagar
            la migración.
          </p>
          <p className="rounded-xl bg-amber-50 px-3 py-2 text-amber-900">
            WhatsApp entrega el historial solo al vincular:{' '}
            {linked ? (
              <>
                vamos a <b>desvincular y pedir un QR nuevo</b>.
              </>
            ) : (
              <>escanea el QR después de activar.</>
            )}{' '}
            Si el teléfono no está contigo, mándale una captura del QR por WhatsApp a quien lo
            tiene: cada QR dura unos 20 segundos.
          </p>
          <div>
            <label className="label" htmlFor="mig-who">
              Quién autoriza (dueño de los datos)
            </label>
            <input
              id="mig-who"
              className="input"
              placeholder="Ej: Javier Sotomayor"
              value={who}
              onChange={(e) => setWho(e.target.value)}
              maxLength={120}
            />
          </div>
          <label className="flex cursor-pointer items-start gap-2 text-ink">
            <input
              type="checkbox"
              className="mt-1 size-4 accent-violeta"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
            />
            <span>
              El dueño de este WhatsApp <b>autorizó por escrito</b> copiar sus contactos y
              conversaciones a VentaPlay.
            </span>
          </label>
          {error && <p className="text-sm text-danger">{error}</p>}
        </div>
      </Dialog>
    </>
  );
}

/** Aviso del modo migración activo (antes y después de escanear) */
export function MigrationBanner({
  session,
  onDisable,
}: {
  session: SessionSummary;
  onDisable: () => Promise<void>;
}) {
  const m = session.migration;
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!m) return null;
  return (
    <>
      <div className="mb-6 flex flex-wrap items-center gap-3 rounded-xl border border-turquesa/30 bg-turquesa/5 px-4 py-3 text-sm text-ink">
        <ArrowRightLeft className="size-4 shrink-0 text-turquesa" />
        <span className="min-w-0 flex-1">
          {m.awaitingLink ? (
            <>
              <b>Migración activada.</b> Escanea el QR para traer todo el historial (o mándale una
              captura a quien tiene el teléfono: cada QR dura ~20 s).
            </>
          ) : (
            <>
              <b>Migración activa</b>
              {m.consentBy ? ` · autorizó ${m.consentBy}` : ''}: {fmtNumber(m.chats)} chats y{' '}
              {fmtNumber(m.messages)} mensajes guardados para llevar a VentaPlay.
            </>
          )}
        </span>
        <button
          className="text-xs font-bold text-ink-soft underline"
          onClick={() => setConfirm(true)}
        >
          Apagar y borrar
        </button>
      </div>
      <Dialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Apagar la migración"
        footer={
          <>
            <button className="btn-secondary" onClick={() => setConfirm(false)} data-autofocus>
              Cancelar
            </button>
            <button
              className="btn-danger-solid"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void onDisable().finally(() => {
                  setBusy(false);
                  setConfirm(false);
                });
              }}
            >
              {busy && <Spinner className="size-4" />} Apagar y borrar conversaciones
            </button>
          </>
        }
      >
        <p>
          Se borran las conversaciones guardadas en este equipo. Lo que ya se importó a VentaPlay
          queda allá.
        </p>
      </Dialog>
    </>
  );
}

// ------------------------------------------------------------ exportadores

/** Excel de conversaciones (Chats + Mensajes) unido al de contactos por ID */
export function ConversationsExporter({ session }: { session: SessionSummary }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const m = session.migration;
  const ready = Boolean(m && !m.awaitingLink && m.messages > 0);
  return (
    <li className="flex flex-col gap-4 py-4 sm:flex-row sm:items-start">
      <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-green-50 text-green-700">
        <FileSpreadsheet className="size-5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-black">Excel de conversaciones</p>
        <p className="text-sm text-ink-soft">
          Hojas <b className="text-ink">Chats</b> y <b className="text-ink">Mensajes</b>, unidas al
          Excel de contactos por el <b className="text-ink">ID contacto</b>. Sin archivos: solo su
          tipo y nombre.
        </p>
        {m && (
          <p className="mt-2 text-xs font-bold text-ink-soft">
            {fmtNumber(m.chats)} chats · {fmtNumber(m.messages)} mensajes
          </p>
        )}
        {done && <p className="mt-1 text-xs font-bold text-green-700">Descargado: {done}</p>}
        {error && <p className="mt-1 text-xs font-bold text-danger">{error}</p>}
      </div>
      <button
        className="btn-primary shrink-0"
        disabled={!ready || busy}
        onClick={() => {
          setBusy(true);
          setError(null);
          api
            .downloadConversationsXlsx(session.id)
            .then(setDone)
            .catch((e: Error) => setError(e.message))
            .finally(() => setBusy(false));
        }}
      >
        {busy ? <Spinner className="size-4" /> : <Download className="size-4" />} Conversaciones
      </button>
    </li>
  );
}

const ACTIVE: VentaPlayState['phase'][] = ['validating', 'importing'];

/** "Directo a VentaPlay": token → validar (en seco) → importar → informe */
export function VentaPlayExporter({ session }: { session: SessionSummary }) {
  const [state, setState] = useState<VentaPlayState | null>(null);
  const [token, setToken] = useState('');
  const [pnid, setPnid] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const linked = session.profile !== null;

  useEffect(() => {
    let alive = true;
    api
      .ventaplay(session.id)
      .then((s) => alive && setState(s))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [session.id]);

  // mientras importa, se lee el avance
  const phase = state?.phase ?? 'idle';
  useEffect(() => {
    if (!ACTIVE.includes(phase)) return;
    const t = setInterval(() => {
      api
        .ventaplay(session.id)
        .then(setState)
        .catch(() => {});
    }, 1500);
    return () => clearInterval(t);
  }, [session.id, phase]);

  async function act(fn: () => Promise<VentaPlayState>) {
    setBusy(true);
    setError(null);
    try {
      setState(await fn());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo');
    } finally {
      setBusy(false);
    }
  }

  const plan = state?.plan;
  const saved = state?.saved ?? null;
  const idleLike = phase === 'idle' || (phase === 'error' && !plan);
  const showForm = idleLike && !saved;
  const update = plan?.modo === 'actualizar';

  return (
    <li className="flex flex-col gap-4 py-4 sm:flex-row sm:items-start">
      <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-violeta-5 text-violeta">
        <Workflow className="size-5" />
      </span>
      <div className="min-w-0 flex-1 space-y-3">
        <div>
          <p className="font-black">Directo a VentaPlay CRM</p>
          <p className="text-sm text-ink-soft">
            Crea los clientes{session.migration ? ' y sus conversaciones' : ''} en la organización,
            sin pasar por un archivo. Validar no escribe nada.
          </p>
        </div>

        {idleLike && saved && (
          <div className="space-y-3 rounded-xl border border-line bg-slate-50/60 p-4 text-sm">
            <p className="font-bold text-ink">
              <CircleCheck className="mr-1 inline size-4 text-green-700" />
              Conectado a {saved.org.nombre}
              {saved.org.subdominio ? ` (${saved.org.subdominio})` : ''}
              {saved.phoneNumberId ? ` · WhatsApp ${saved.phoneNumberId}` : ''}
            </p>
            <p className="text-ink-soft">
              Ya enviados: <b className="text-ink">{fmtNumber(saved.enviados.clientes)}</b> clientes
              y <b className="text-ink">{fmtNumber(saved.enviados.mensajes)}</b> mensajes
              {saved.lastSyncAt ? ` (última vez: ${fmtDateTime(saved.lastSyncAt)})` : ''}.
              “Actualizar” manda solo lo nuevo.
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                className="btn-primary"
                disabled={!linked || busy}
                onClick={() => void act(() => api.ventaplayValidate(session.id, {}))}
              >
                {busy ? <Spinner className="size-4" /> : <RefreshCw className="size-4" />}{' '}
                Actualizar
              </button>
              <button
                className="btn-secondary"
                disabled={busy}
                onClick={() => void act(() => api.ventaplayForget(session.id, true))}
              >
                <Lock className="size-4" /> Olvidar token
              </button>
            </div>
          </div>
        )}

        {showForm && (
          <form
            className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,220px)_auto]"
            onSubmit={(e) => {
              e.preventDefault();
              void act(() =>
                api.ventaplayValidate(session.id, { token, phoneNumberId: pnid || null }),
              ).then(() => setToken(''));
            }}
          >
            <input
              className="input"
              type="password"
              autoComplete="off"
              placeholder="API key de la organización"
              aria-label="API key de la organización"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
            <input
              className="input"
              inputMode="numeric"
              placeholder="phone_number_id (opcional)"
              aria-label="phone_number_id del WhatsApp de la organización"
              value={pnid}
              onChange={(e) => setPnid(e.target.value.replace(/\D/g, ''))}
            />
            <button className="btn-primary" disabled={!linked || token.trim().length < 16 || busy}>
              {busy ? <Spinner className="size-4" /> : <KeyRound className="size-4" />} Validar
            </button>
          </form>
        )}

        {phase === 'validating' && (
          <p className="flex items-center gap-2 text-sm font-bold text-ink-soft">
            <Spinner className="size-4" /> Validando y probando en seco…
          </p>
        )}

        {plan && state && phase !== 'validating' && (
          <div className="space-y-3 rounded-xl border border-line bg-slate-50/60 p-4 text-sm">
            <p className="font-bold text-ink">
              <CircleCheck className="mr-1 inline size-4 text-green-700" />
              {state.org?.nombre}
              {state.org?.subdominio ? ` (${state.org.subdominio})` : ''}
              {state.phoneNumberId ? ` · WhatsApp ${state.phoneNumberId}` : ''}
            </p>
            {update && (
              <p className="text-ink-soft">
                <b className="text-ink">Actualizar:</b> solo lo que no se ha enviado antes (ya
                enviados: {fmtNumber(plan.yaEnviados.clientes)} clientes y{' '}
                {fmtNumber(plan.yaEnviados.mensajes)} mensajes).
              </p>
            )}
            {!plan.filas && (
              <p className="flex items-center gap-2 font-bold text-green-700">
                <CircleCheck className="size-4" /> Todo al día: no hay nada nuevo para enviar.
              </p>
            )}
            <ul className={`space-y-1 text-ink-soft ${plan.filas ? '' : 'hidden'}`}>
              <li>
                <b className="text-ink">{fmtNumber(plan.clientes)} clientes</b>:{' '}
                {fmtNumber(plan.nuevos)} nuevos y {fmtNumber(plan.existentes)} que ya existen (se
                completan sin pisar nada).
              </li>
              <li>
                {plan.soloContactos ? (
                  <>
                    <b className="text-ink">Solo contactos</b>: activa “Migrar a VentaPlay” y vuelve
                    a escanear para llevar las conversaciones.
                  </>
                ) : (
                  <>
                    <b className="text-ink">{fmtNumber(plan.mensajes)} mensajes</b> de{' '}
                    {fmtNumber(plan.chatsConMensajes)} chats.
                  </>
                )}
              </li>
              <li>
                Quedan fuera {fmtNumber(plan.sinNumero)} contactos sin número y{' '}
                {fmtNumber(plan.grupos)} grupos
                {plan.mensajesFuera ? ` (${fmtNumber(plan.mensajesFuera)} mensajes)` : ''}.
              </li>
              <li>
                Ocupa {fmtNumber(plan.filas)} filas del cupo diario de VentaPlay (50.000 por
                defecto).
              </li>
            </ul>

            {!plan.historialCompleto && !state.startedAt && (
              <p className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-amber-900">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" /> El historial todavía estaba
                llegando cuando validaste: lo que llegue después no entra. Espera “Historial
                completo” y vuelve a validar (repetir no duplica nada).
              </p>
            )}

            {plan.filas > 0 &&
              (phase === 'importing' ||
                phase === 'paused' ||
                phase === 'done' ||
                state.startedAt) && (
                <div className="space-y-2">
                  <Bar
                    label="Clientes"
                    done={state.progress.clientes.done}
                    total={state.progress.clientes.total}
                  />
                  {!plan.soloContactos && (
                    <Bar
                      label="Mensajes"
                      done={state.progress.mensajes.done}
                      total={state.progress.mensajes.total}
                    />
                  )}
                </div>
              )}

            {state.startedAt && (
              <p className="text-xs text-ink-soft">
                Clientes: {fmtNumber(state.result.clientes.created)} creados,{' '}
                {fmtNumber(state.result.clientes.updated)} completados,{' '}
                {fmtNumber(state.result.clientes.errors)} con error · Mensajes:{' '}
                {fmtNumber(state.result.mensajes.created)} creados,{' '}
                {fmtNumber(state.result.mensajes.skipped)} saltados,{' '}
                {fmtNumber(state.result.mensajes.errors)} con error
              </p>
            )}

            {state.result.codes.length > 0 && (
              <ul className="space-y-0.5 text-xs text-danger">
                {state.result.codes.slice(0, 6).map((c) => (
                  <li key={`${c.code}${c.detalle}`}>
                    {fmtNumber(c.n)} × {c.code}
                    {c.detalle ? `: ${c.detalle}` : ''}
                  </li>
                ))}
              </ul>
            )}

            {phase === 'paused' && (
              <p className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-amber-900">
                <PauseCircle className="mt-0.5 size-4 shrink-0" /> {state.pausedReason}
              </p>
            )}
            {phase === 'error' && state.error && (
              <p className="flex items-start gap-2 rounded-lg bg-red-50 px-3 py-2 text-red-800">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" /> {state.error}
              </p>
            )}
            {phase === 'done' && plan.filas > 0 && (
              <p className="flex items-center gap-2 font-bold text-green-700">
                <CircleCheck className="size-4" />{' '}
                {update ? 'Actualización terminada.' : 'Importación terminada.'}
              </p>
            )}

            <div className="flex flex-wrap gap-2">
              {state.canResume && (
                <button className="btn-primary" disabled={busy} onClick={() => setConfirm(true)}>
                  {phase === 'validated' ? (
                    <Workflow className="size-4" />
                  ) : (
                    <RefreshCw className="size-4" />
                  )}
                  {phase !== 'validated'
                    ? 'Retomar'
                    : update
                      ? 'Actualizar VentaPlay'
                      : 'Importar a VentaPlay'}
                </button>
              )}
              {phase === 'importing' && (
                <p className="flex items-center gap-2 font-bold text-violeta">
                  <Spinner className="size-4" />
                  {state.step === 'canario'
                    ? state.progress.clientes.done < state.progress.clientes.total
                      ? 'Probando con 5 clientes reales…'
                      : 'Probando con 5 mensajes reales…'
                    : state.step === 'clientes'
                      ? 'Cargando clientes…'
                      : 'Cargando mensajes…'}
                </p>
              )}
              {phase !== 'importing' && (
                <button
                  className="btn-secondary"
                  disabled={busy}
                  onClick={() => void act(() => api.ventaplayForget(session.id))}
                >
                  <Lock className="size-4" /> {phase === 'done' ? 'Cerrar' : 'Cancelar'}
                </button>
              )}
            </div>
          </div>
        )}

        {phase === 'error' && !plan && state?.error && (
          <p className="text-xs font-bold text-danger">{state.error}</p>
        )}
        {error && <p className="text-xs font-bold text-danger">{error}</p>}
        {!linked && (
          <p className="text-xs text-ink-soft">Vincula el WhatsApp para poder importar.</p>
        )}
      </div>

      <Dialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Importar a VentaPlay"
        footer={
          <>
            <button className="btn-secondary" onClick={() => setConfirm(false)} data-autofocus>
              Cancelar
            </button>
            <button
              className="btn-primary"
              disabled={busy}
              onClick={() => {
                setConfirm(false);
                void act(() => api.ventaplayImport(session.id));
              }}
            >
              <Workflow className="size-4" /> Sí, importar
            </button>
          </>
        }
      >
        {plan && state && (
          <p>
            Vas a cargar <b>{fmtNumber(plan.clientes)} clientes</b>
            {plan.soloContactos ? (
              ''
            ) : (
              <>
                {' '}
                y <b>{fmtNumber(plan.mensajes)} mensajes</b>
              </>
            )}{' '}
            en <b>{state.org?.nombre}</b>. Primero se prueban 5 clientes reales; si alguno falla, se
            detiene. Repetir no duplica nada.
          </p>
        )}
      </Dialog>
    </li>
  );
}

function Bar({ label, done, total }: { label: string; done: number; total: number }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <div>
      <div className="mb-1 flex justify-between text-xs font-bold text-ink-soft">
        <span>{label}</span>
        <span className="tabular-nums">
          {fmtNumber(done)} / {fmtNumber(total)}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-violeta-5">
        <div
          className="h-full rounded-full bg-violeta transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
