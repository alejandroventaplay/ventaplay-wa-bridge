import { useEffect, useState } from 'react';
import { Link } from 'react-router';
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
import type {
  PrivacyState,
  SessionSummary,
  VentaPlayState,
  WaContactsState,
} from '@wa-bridge/shared';
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

/** fila del panel: filtro personal / interés laboral con su estado y aprobación */
export function PrivacyExporter({ session }: { session: SessionSummary }) {
  const [p, setP] = useState<PrivacyState | null>(null);
  const ready = Boolean(session.migration && !session.migration.awaitingLink);
  useEffect(() => {
    if (!ready) return;
    let alive = true;
    api
      .privacy(session.id, true)
      .then((x) => alive && setP(x))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [session.id, ready, session.migration?.messages]);
  return (
    <li className="flex flex-col gap-4 py-4 sm:flex-row sm:items-start">
      <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-amber-50 text-amber-800">
        <ShieldCheck className="size-5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-black">Filtro personal / interés laboral</p>
        <p className="text-sm text-ink-soft">
          Opcional, antes de cargar a VentaPlay: separa lo personal de lo laboral, revisa la lista y
          aprueba. Lo que quede fuera no sale del Bridge (ni a VentaPlay ni en los Excel).
        </p>
        {p && (
          <p className="mt-2 text-xs font-bold text-ink-soft">
            Entran {fmtNumber(p.counts.incluidos)} · fuera {fmtNumber(p.counts.excluidos)} · por
            revisar {fmtNumber(p.counts.revisar)}
            {p.approval ? (
              <span className="text-green-700">
                {' '}
                · aprobado por {p.approval.by} ({fmtDateTime(p.approval.at)})
              </span>
            ) : p.active ? (
              <span className="text-amber-700"> · falta la aprobación final</span>
            ) : null}
          </p>
        )}
      </div>
      <Link
        to={`/s/${session.id}/filtro`}
        className={`btn-primary shrink-0 ${ready ? '' : 'pointer-events-none opacity-50'}`}
        aria-disabled={!ready}
      >
        <ShieldCheck className="size-4" /> {p?.approval ? 'Ver filtro' : 'Revisar y aprobar'}
      </Link>
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
  const pv = state?.privacy;
  /** filtro activo sin aprobar, o cambió después de validar: no se puede cargar */
  const privacyBlock = pv?.active ? !pv.approval || pv.stale : false;

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

        {showForm && (state?.previous.length ?? 0) > 0 && (
          <div className="rounded-xl border border-line bg-slate-50/60 p-4 text-sm text-ink-soft">
            {state!.previous.map((p) => (
              <p key={p.org}>
                <CircleCheck className="mr-1 inline size-4 text-green-700" />
                Ya enviaste a <b className="text-ink">{p.orgName ?? 'una organización'}</b>{' '}
                <b className="text-ink">{fmtNumber(p.clientes)}</b> clientes y{' '}
                <b className="text-ink">{fmtNumber(p.mensajes)}</b> mensajes
                {p.lastSyncAt ? ` (hasta ${fmtDateTime(p.lastSyncAt)})` : ''}.
              </p>
            ))}
            <p className="mt-1">
              Pega la API key de esa organización y valida: manda{' '}
              <b className="text-ink">solo lo nuevo</b>, no empieza de cero.
            </p>
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
              {plan.privados && (
                <li>
                  <b className="text-ink">Filtro personal / laboral</b>: quedan fuera{' '}
                  {fmtNumber(plan.privados.clientes)} contactos
                  {plan.privados.mensajes ? ` (${fmtNumber(plan.privados.mensajes)} mensajes)` : ''}
                  .
                </li>
              )}
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

            {privacyBlock && phase !== 'importing' && phase !== 'done' && (
              <div className="flex flex-wrap items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-amber-900">
                <ShieldCheck className="size-4 shrink-0" />
                <span className="flex-1">
                  {!pv?.approval
                    ? 'Falta la aprobación final del filtro personal / laboral.'
                    : 'El filtro cambió después de validar: valida de nuevo.'}
                </span>
                {!pv?.approval ? (
                  <Link
                    to={`/s/${session.id}/filtro`}
                    className="btn-secondary px-3 py-1.5 text-xs"
                  >
                    Revisar y aprobar
                  </Link>
                ) : (
                  <button
                    className="btn-secondary px-3 py-1.5 text-xs"
                    disabled={busy}
                    onClick={() => void act(() => api.ventaplayValidate(session.id, {}))}
                  >
                    <RefreshCw className="size-3.5" /> Validar de nuevo
                  </button>
                )}
              </div>
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
                <button
                  className="btn-primary"
                  disabled={busy || privacyBlock}
                  onClick={() => setConfirm(true)}
                >
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

        {(saved || phase === 'done') && phase !== 'importing' && linked && (
          <WaContactsPanel session={session} orgName={saved?.org.nombre ?? state?.org?.nombre} />
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
            {state.privacy.approval && (
              <>
                {' '}
                Filtro personal / laboral aprobado por <b>{state.privacy.approval.by}</b>.
              </>
            )}
          </p>
        )}
      </Dialog>
    </li>
  );
}

/**
 * Lo inverso: los clientes de VentaPlay como contactos en este WhatsApp, con un sufijo
 * ("Paciente") para saber de dónde vienen. Solo los que no tiene guardados; con autorización.
 */
function WaContactsPanel({
  session,
  orgName,
}: {
  session: SessionSummary;
  orgName: string | undefined;
}) {
  const [st, setSt] = useState<WaContactsState | null>(null);
  const [suffix, setSuffix] = useState('Paciente');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ask, setAsk] = useState(false);
  const [who, setWho] = useState(session.migration?.consentBy ?? '');
  const [ok, setOk] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .waContacts(session.id)
      .then((s) => {
        if (!alive) return;
        setSt(s);
        if (s.phase !== 'idle') setSuffix(s.suffix);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [session.id]);

  const phase = st?.phase ?? 'idle';
  useEffect(() => {
    if (phase !== 'running' && phase !== 'planning') return;
    const t = setInterval(() => {
      api
        .waContacts(session.id)
        .then(setSt)
        .catch(() => {});
    }, 1500);
    return () => clearInterval(t);
  }, [session.id, phase]);

  async function act(fn: () => Promise<WaContactsState>) {
    setBusy(true);
    setError(null);
    try {
      setSt(await fn());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo');
    } finally {
      setBusy(false);
    }
  }

  const plan = st?.plan;
  const nuevos = plan?.nuevos ?? 0;
  return (
    <div className="space-y-3 rounded-xl border border-line p-4 text-sm">
      <div>
        <p className="font-black">
          <ArrowRightLeft className="mr-1 inline size-4 text-violeta" /> Guardar los clientes en
          este WhatsApp
        </p>
        <p className="text-ink-soft">
          Crea como contacto a los clientes de {orgName ?? 'la organización'} que no tiene
          guardados, con un texto al final del nombre para saber que vienen de VentaPlay. Los que ya
          tiene no se tocan.
        </p>
      </div>

      {(phase === 'idle' || phase === 'planned' || phase === 'error') && (
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2">
            <span className="font-bold">Al final del nombre:</span>
            <input
              className="input w-36 py-1.5"
              value={suffix}
              maxLength={30}
              onChange={(e) => setSuffix(e.target.value)}
            />
          </label>
          <button
            className="btn-secondary"
            disabled={busy}
            onClick={() => void act(() => api.waContactsPlan(session.id, suffix))}
          >
            {busy ? <Spinner className="size-4" /> : <RefreshCw className="size-4" />} Ver cuántos
          </button>
        </div>
      )}

      {phase === 'planning' && (
        <p className="flex items-center gap-2 font-bold text-ink-soft">
          <Spinner className="size-4" /> Leyendo los clientes de VentaPlay…
        </p>
      )}

      {plan && phase !== 'planning' && (
        <div className="space-y-2">
          <p className="text-ink-soft">
            {fmtNumber(plan.total)} clientes en VentaPlay · {fmtNumber(plan.yaGuardados)} ya están
            en su WhatsApp · {fmtNumber(plan.yaCreados)} creados antes desde aquí ·{' '}
            {fmtNumber(plan.sinNumero)} sin número válido.
          </p>
          <p className="font-bold">
            Se crean <span className="text-violeta">{fmtNumber(nuevos)} contactos</span>
            {plan.ejemplos.length > 0 && (
              <span className="font-normal text-ink-soft">
                {' '}
                (por ejemplo: {plan.ejemplos.map((e) => `“${e}”`).join(', ')})
              </span>
            )}
          </p>
        </div>
      )}

      {phase === 'running' && st && (
        <div className="space-y-2">
          <Bar label="Contactos" done={st.progress.done} total={st.progress.total} />
          <p className="flex items-center gap-2 font-bold text-violeta">
            <Spinner className="size-4" /> Creando contactos, uno por segundo aprox. No cierres el
            Bridge.
          </p>
        </div>
      )}

      {phase === 'done' && st && (
        <p className="flex items-start gap-2 font-bold text-green-700">
          <CircleCheck className="mt-0.5 size-4 shrink-0" /> Listo: {fmtNumber(st.creados)}{' '}
          contactos creados en su WhatsApp
          {st.consentBy ? ` (autorizó ${st.consentBy})` : ''}
          {st.errores ? `, ${fmtNumber(st.errores)} con error` : ''}.
        </p>
      )}

      {phase === 'error' && st?.error && (
        <p className="flex items-start gap-2 rounded-lg bg-red-50 px-3 py-2 text-red-800">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" /> {st.error}
          {st.creados ? ` (alcanzó a crear ${fmtNumber(st.creados)})` : ''}
        </p>
      )}

      {(phase === 'planned' || phase === 'error') && nuevos > 0 && (
        <button className="btn-primary" disabled={busy} onClick={() => setAsk(true)}>
          <ShieldCheck className="size-4" />{' '}
          {phase === 'error' ? 'Reintentar' : `Crear ${fmtNumber(nuevos)} contactos`}
        </button>
      )}
      {error && <p className="text-xs font-bold text-danger">{error}</p>}

      <Dialog
        open={ask}
        onClose={() => setAsk(false)}
        title="Autorizar contactos en este WhatsApp"
        footer={
          <>
            <button className="btn-secondary" onClick={() => setAsk(false)} data-autofocus>
              Cancelar
            </button>
            <button
              className="btn-primary"
              disabled={!ok || who.trim().length < 2 || busy}
              onClick={() => {
                setAsk(false);
                setOk(false);
                void act(() => api.waContactsStart(session.id, { suffix, consentBy: who.trim() }));
              }}
            >
              <ShieldCheck className="size-4" /> Autorizo, crear contactos
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <p>
            Se van a crear <b>{fmtNumber(nuevos)} contactos</b> en el WhatsApp{' '}
            <b>{session.label ?? session.profile?.name}</b>, con “{suffix.trim()}” al final del
            nombre. No se envía ningún mensaje y los contactos que ya tiene no se modifican.
          </p>
          <input
            className="input w-full"
            placeholder="Quién autoriza (dueña o dueño del WhatsApp)"
            value={who}
            onChange={(e) => setWho(e.target.value)}
          />
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-1 accent-violeta"
              checked={ok}
              onChange={(e) => setOk(e.target.checked)}
            />
            <span>
              Soy la persona dueña de este WhatsApp (o tengo su permiso) y autorizo crear estos
              contactos.
            </span>
          </label>
        </div>
      </Dialog>
    </div>
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
