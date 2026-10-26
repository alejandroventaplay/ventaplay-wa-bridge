import { useState } from 'react';
import {
  CheckCircle2,
  Copy,
  KeyRound,
  Send,
  MoreVertical,
  RefreshCw,
  ScanLine,
  Settings,
  Smartphone,
  TriangleAlert,
} from 'lucide-react';
import type { SessionSummary } from '@wa-bridge/shared';
import { useNow } from '../hooks/streams';
import { fmtPhone } from '../lib/format';
import { Dialog, Spinner } from './ui';

interface Props {
  session: SessionSummary;
  busy: boolean;
  onNewQr: () => void;
  onSimulateScan?: (() => void) | undefined;
  /** vincular con código: pide el código de 8 caracteres para ese número */
  onPairingCode?: ((phone: string) => Promise<void>) | undefined;
  /** manda el código por WhatsApp desde el agente conectado */
  onSendPairing?: (() => Promise<void>) | undefined;
  /** nombre del agente que puede mandarlo; null = no hay agente con envío */
  pairingSender?: string | null | undefined;
}

/** Pantalla de vinculación: QR con marca VentaPlay + instrucciones. */
export function LinkView({
  session,
  busy,
  onNewQr,
  onSimulateScan,
  onPairingCode,
  onSendPairing,
  pairingSender,
}: Props) {
  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_420px]">
      <div className="card order-2 p-6 sm:p-8 lg:order-1">
        <h2 className="text-xl font-black sm:text-2xl">Vincula el WhatsApp</h2>
        <p className="mt-1 text-sm text-ink-soft">
          Con el teléfono{' '}
          {session.label ? <b className="text-ink">de {session.label}</b> : 'del cliente'} a mano:
        </p>
        <ol className="mt-6 space-y-5">
          <Step n={1} icon={<Smartphone className="size-4" />}>
            Abre <b>WhatsApp</b> en el teléfono.
          </Step>
          <Step
            n={2}
            icon={
              <span className="flex">
                <MoreVertical className="size-4" />
                <Settings className="size-4" />
              </span>
            }
          >
            Toca <b>Menú ⋮</b> (Android) o <b>Configuración</b> (iPhone).
          </Step>
          <Step n={3} icon={<ScanLine className="size-4" />}>
            Toca <b>Dispositivos vinculados</b> y luego <b>Vincular un dispositivo</b>.
          </Step>
          <Step n={4} icon={<CheckCircle2 className="size-4" />}>
            Apunta la cámara a este código. Deja el teléfono <b>encendido y con internet</b>{' '}
            mientras se copia el historial.
          </Step>
        </ol>
        <div className="mt-8 rounded-xl border border-turquesa/25 bg-turquesa-10/60 p-4 text-sm text-ink">
          <b className="text-turquesa-140">Solo leemos, nunca escribimos.</b> Copiamos contactos y
          chats para migrarlos a VentaPlay. No enviamos mensajes, no marcamos nada como leído y no
          aparecemos “en línea”.
        </div>
      </div>

      <div className="order-1 lg:order-2">
        <QrCard session={session} busy={busy} onNewQr={onNewQr} />
        {onPairingCode &&
          ['qr', 'qr_expired', 'starting', 'logged_out'].includes(session.status) && (
            <PairingBox
              session={session}
              onRequest={onPairingCode}
              onSend={onSendPairing}
              sender={pairingSender ?? null}
            />
          )}
        {onSimulateScan && session.status === 'qr' && (
          <button
            className="btn-secondary mt-3 w-full border-dashed text-amber-800"
            onClick={onSimulateScan}
          >
            Simular escaneo (solo simulador)
          </button>
        )}
      </div>
    </div>
  );
}

function Step({
  n,
  icon,
  children,
}: {
  n: number;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <li className="flex gap-4">
      <span className="grid size-8 shrink-0 place-items-center rounded-full bg-violeta text-sm font-black text-white">
        {n}
      </span>
      <div className="pt-1 text-[15px] leading-relaxed">
        <span className="mr-1.5 inline-flex translate-y-0.5 text-violeta-60">{icon}</span>
        {children}
      </div>
    </li>
  );
}

function QrCard({
  session,
  busy,
  onNewQr,
}: {
  session: SessionSummary;
  busy: boolean;
  onNewQr: () => void;
}) {
  const now = useNow(250);
  const { status, qr } = session;
  const total = qr ? (qr.sequence === 1 ? 60_000 : 20_000) : 1;
  const left = qr ? Math.max(0, qr.expiresAt - now) : 0;
  const pct = qr ? Math.min(100, (left / total) * 100) : 0;
  const unlinkedError = status === 'error' || (status === 'starting' && session.lastError);

  return (
    <div className="card overflow-hidden">
      <div className="bg-gradient-to-br from-violeta via-violeta-80 to-magenta p-[3px]">
        <div className="rounded-t-[calc(var(--radius-card)-3px)] bg-white p-5 sm:p-6">
          <div className="relative mx-auto aspect-square w-full max-w-[340px] overflow-hidden rounded-2xl bg-white">
            {status === 'qr' && qr ? (
              <>
                <img
                  key={qr.sequence}
                  src={qr.dataUrl}
                  alt="Código QR para vincular WhatsApp"
                  className="pop-in size-full [image-rendering:pixelated]"
                />
                {/* logo al centro: el QR usa corrección de errores alta, lo tolera */}
                <span className="absolute left-1/2 top-1/2 grid size-[21%] -translate-x-1/2 -translate-y-1/2 place-items-center rounded-xl bg-white p-1.5 shadow-sm ring-1 ring-violeta-10">
                  <img src="/ventaplay-logo-iso.svg" alt="" className="w-full" />
                </span>
              </>
            ) : (
              <QrPlaceholder>
                {status === 'connecting' ? (
                  <div className="pop-in flex flex-col items-center gap-3 text-center">
                    <CheckCircle2 className="size-14 text-whatsapp" />
                    <p className="text-lg font-black">¡Escaneado!</p>
                    <p className="flex items-center gap-2 text-sm text-ink-soft">
                      <Spinner className="size-4" /> Conectando con WhatsApp…
                    </p>
                  </div>
                ) : status === 'qr_expired' || status === 'logged_out' ? (
                  <div className="flex flex-col items-center gap-3 text-center">
                    <p className="font-black">
                      {status === 'logged_out' ? 'Listo para vincular' : 'El código expiró'}
                    </p>
                    <p className="text-sm text-ink-soft">
                      {status === 'logged_out'
                        ? 'Pide un código cuando la persona tenga el teléfono a mano.'
                        : 'WhatsApp los renueva unas veces y luego hay que pedir otro.'}
                    </p>
                    <button className="btn-primary mt-1" onClick={onNewQr} disabled={busy}>
                      {busy ? <Spinner className="size-4" /> : <RefreshCw className="size-4" />}{' '}
                      Generar nuevo código
                    </button>
                  </div>
                ) : unlinkedError ? (
                  <div className="flex flex-col items-center gap-3 px-4 text-center">
                    <TriangleAlert className="size-10 text-danger" />
                    <p className="font-black">No pudimos generar el código</p>
                    <p className="text-sm text-ink-soft">{session.lastError}</p>
                    {status === 'error' && (
                      <button className="btn-primary mt-1" onClick={onNewQr} disabled={busy}>
                        <RefreshCw className="size-4" /> Reintentar
                      </button>
                    )}
                  </div>
                ) : (
                  <div className="flex flex-col items-center gap-3 text-ink-soft">
                    <Spinner className="size-8 text-violeta" />
                    <p className="text-sm font-bold">Generando código…</p>
                  </div>
                )}
              </QrPlaceholder>
            )}
          </div>
        </div>
      </div>

      <div className="px-6 py-4">
        {status === 'qr' && qr ? (
          <>
            <div className="flex items-center justify-between gap-3 text-xs font-bold text-ink-soft">
              <span>El código se renueva solo</span>
              <span className="flex items-center gap-3">
                {/* el primer código de cada intento dura 60 s; los siguientes, 20 s */}
                {qr.sequence > 1 && (
                  <button
                    className="inline-flex items-center gap-1 text-violeta underline disabled:opacity-50"
                    onClick={onNewQr}
                    disabled={busy}
                    title="Empieza de nuevo con un código que dura 60 segundos"
                  >
                    <RefreshCw className="size-3" /> Reiniciar (60 s)
                  </button>
                )}
                <span className="tabular-nums text-ink">{Math.ceil(left / 1000)} s</span>
              </span>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-violeta-5">
              <div
                className="h-full rounded-full bg-gradient-to-r from-turquesa to-violeta-60 transition-[width] duration-300 ease-linear"
                style={{ width: `${pct}%` }}
              />
            </div>
          </>
        ) : (
          <p className="text-center text-xs font-bold text-ink-soft">
            WhatsApp → Dispositivos vinculados
          </p>
        )}
      </div>
    </div>
  );
}

/** Vincular con código: para cuando el teléfono no está al lado del computador */
function PairingBox({
  session,
  onRequest,
  onSend,
  sender,
}: {
  session: SessionSummary;
  onRequest: (phone: string) => Promise<void>;
  onSend?: (() => Promise<void>) | undefined;
  sender: string | null;
}) {
  const [confirm, setConfirm] = useState(false);
  const [sending, setSending] = useState(false);
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const p = session.pairing;

  async function request() {
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      await onRequest(phone);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo pedir el código');
    } finally {
      setBusy(false);
    }
  }

  const instructions = p
    ? [
        `Código para vincular el WhatsApp: ${p.code}`,
        '1. Abre WhatsApp → Configuración (o ⋮) → Dispositivos vinculados → Vincular un dispositivo.',
        '2. Abajo de la cámara toca "Vincular con el número de teléfono".',
        '3. Escribe el código. Vence en unos 2 minutos.',
      ].join('\n')
    : '';

  return (
    <div className="card mt-3 p-5">
      <p className="flex items-center gap-2 font-black text-ink">
        <KeyRound className="size-4 text-violeta" /> ¿El teléfono no está contigo?
      </p>
      {p ? (
        <div className="mt-3 space-y-3">
          <p
            className="select-all text-center font-mono text-3xl font-black tracking-[0.2em] text-violeta"
            aria-label="Código de vinculación"
          >
            {p.code}
          </p>
          <ol className="list-decimal space-y-1 pl-5 text-sm text-ink-soft">
            <li>
              En el teléfono: WhatsApp → <b>Dispositivos vinculados</b> →{' '}
              <b>Vincular un dispositivo</b>.
            </li>
            <li>
              Abajo de la cámara: <b>Vincular con el número de teléfono</b>.
            </li>
            <li>Escribir el código. Vence en unos 2 minutos: si vence, pide otro.</li>
          </ol>
          {p.sentAt && (
            <p className="rounded-lg bg-green-50 px-3 py-2 text-sm font-bold text-green-800">
              Enviado por WhatsApp a {fmtPhone(p.phone)}
              {p.sentVia ? ` desde ${p.sentVia}` : ''}.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {onSend && sender && (
              <button className="btn-primary" disabled={sending} onClick={() => setConfirm(true)}>
                {sending ? <Spinner className="size-4" /> : <Send className="size-4" />}
                {p.sentAt ? 'Reenviar por WhatsApp' : 'Enviar por WhatsApp'}
              </button>
            )}
            <button
              className={onSend && sender ? 'btn-secondary' : 'btn-primary'}
              onClick={() =>
                void navigator.clipboard
                  .writeText(instructions)
                  .then(() => setCopied(true))
                  .catch(() => setError('No pude copiar: selecciona el código a mano'))
              }
            >
              <Copy className="size-4" /> {copied ? 'Copiado' : 'Copiar instrucciones'}
            </button>
            <button className="btn-secondary" disabled={busy} onClick={() => void request()}>
              {busy ? <Spinner className="size-4" /> : <RefreshCw className="size-4" />} Otro código
            </button>
          </div>
        </div>
      ) : (
        <form
          className="mt-3 space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            void request();
          }}
        >
          <p className="text-sm text-ink-soft">
            Vincula con un <b>código de 8 letras</b> que se dicta o se manda por WhatsApp, sin
            escanear.
          </p>
          <div className="flex gap-2">
            <input
              className="input"
              type="tel"
              placeholder="Número del WhatsApp (+56 9 …)"
              aria-label="Número del WhatsApp a vincular"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
            <button
              className="btn-primary shrink-0"
              disabled={busy || phone.replace(/\D/g, '').length < 8}
            >
              {busy ? <Spinner className="size-4" /> : <KeyRound className="size-4" />} Pedir código
            </button>
          </div>
        </form>
      )}
      {error && <p className="mt-2 text-xs font-bold text-danger">{error}</p>}
      {p && onSend && (
        <Dialog
          open={confirm}
          onClose={() => setConfirm(false)}
          title="Enviar el código por WhatsApp"
          footer={
            <>
              <button className="btn-secondary" onClick={() => setConfirm(false)} data-autofocus>
                Cancelar
              </button>
              <button
                className="btn-primary"
                disabled={sending}
                onClick={() => {
                  setConfirm(false);
                  setSending(true);
                  setError(null);
                  onSend()
                    .catch((e: Error) => setError(e.message))
                    .finally(() => setSending(false));
                }}
              >
                <Send className="size-4" /> Enviar
              </button>
            </>
          }
        >
          <p>
            Se le manda a <b>{fmtPhone(p.phone)}</b> desde <b>{sender}</b> el código <b>{p.code}</b>{' '}
            con los pasos para vincular.
          </p>
        </Dialog>
      )}
    </div>
  );
}

function QrPlaceholder({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative grid size-full place-items-center rounded-2xl bg-violeta-5/60">
      {/* patrón suave de QR detrás */}
      <svg
        className="absolute inset-0 size-full text-violeta/[0.06]"
        viewBox="0 0 29 29"
        aria-hidden
      >
        {[
          [1, 1],
          [21, 1],
          [1, 21],
        ].map(([x, y]) => (
          <g key={`${x}-${y}`}>
            <rect
              x={x}
              y={y}
              width="7"
              height="7"
              rx="1.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
            />
            <rect x={x! + 2.2} y={y! + 2.2} width="2.6" height="2.6" rx="0.6" fill="currentColor" />
          </g>
        ))}
      </svg>
      <div className="relative">{children}</div>
    </div>
  );
}
