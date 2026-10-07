import {
  CheckCircle2,
  MoreVertical,
  RefreshCw,
  ScanLine,
  Settings,
  Smartphone,
  TriangleAlert,
} from 'lucide-react';
import type { SessionSummary } from '@wa-bridge/shared';
import { useNow } from '../hooks/streams';
import { Spinner } from './ui';

interface Props {
  session: SessionSummary;
  busy: boolean;
  onNewQr: () => void;
  onSimulateScan?: (() => void) | undefined;
}

/** Pantalla de vinculación: QR con marca VentaPlay + instrucciones. */
export function LinkView({ session, busy, onNewQr, onSimulateScan }: Props) {
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
                ) : status === 'qr_expired' ? (
                  <div className="flex flex-col items-center gap-3 text-center">
                    <p className="font-black">El código expiró</p>
                    <p className="text-sm text-ink-soft">
                      WhatsApp los renueva unas veces y luego hay que pedir otro.
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
            <div className="flex items-center justify-between text-xs font-bold text-ink-soft">
              <span>El código se renueva solo</span>
              <span className="tabular-nums text-ink">{Math.ceil(left / 1000)} s</span>
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
