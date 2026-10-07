import { useEffect, useRef, type ReactNode } from 'react';
import { Link } from 'react-router';
import { LockKeyhole, LogOut, X } from 'lucide-react';
import type { SessionStatus } from '@wa-bridge/shared';
import { useAuth } from '../hooks/auth';
import { initials } from '../lib/format';

export function Logo({ className = '' }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <img src="/ventaplay-logo-iso.svg" alt="" className="h-6 w-auto" />
      <span className="text-[17px] font-black tracking-tight text-violeta">VentaPlay</span>
    </span>
  );
}

export function ReadOnlyBadge({ compact = false }: { compact?: boolean }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border border-turquesa/30 bg-turquesa-10 px-2.5 py-1 text-xs font-bold text-turquesa-140"
      title="Este servicio nunca envía mensajes ni marca chats como leídos"
    >
      <LockKeyhole className="size-3.5" aria-hidden />
      {compact ? 'Solo lectura' : 'Solo lectura · nunca enviamos mensajes'}
    </span>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { state, logout } = useAuth();
  const email = state.phase === 'signed-in' ? state.email : null;
  const driver = state.phase === 'signed-in' ? state.health.driver : null;
  const authMode = state.phase === 'signed-in' ? state.health.auth : null;
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-line/80 bg-white/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-3 px-4 sm:px-6">
          <Link to="/" className="flex items-center gap-3" aria-label="Inicio">
            <Logo />
            <span className="hidden rounded-md bg-violeta-5 px-2 py-0.5 text-xs font-bold text-violeta sm:inline">
              WA Bridge
            </span>
          </Link>
          {driver === 'simulator' && (
            <span className="rounded-md bg-amber-100 px-2 py-0.5 text-xs font-bold text-amber-800">
              Simulador
            </span>
          )}
          <div className="ml-auto flex items-center gap-3">
            <span className="hidden md:inline-flex">
              <ReadOnlyBadge compact />
            </span>
            {email && (
              <span
                className="grid size-8 place-items-center rounded-full bg-violeta text-xs font-bold text-white"
                title={email}
              >
                {initials(email.split('@')[0]?.replace(/[._-]/g, ' '))}
              </span>
            )}
            {authMode !== 'none' && (
              <button
                className="btn-secondary px-3 py-2"
                onClick={() => void logout()}
                title="Cerrar sesión"
              >
                <LogOut className="size-4" aria-hidden />
                <span className="hidden sm:inline">Salir</span>
              </button>
            )}
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">{children}</main>
    </div>
  );
}

const STATUS: Record<SessionStatus, { label: string; cls: string; dot: string; pulse?: boolean }> =
  {
    starting: {
      label: 'Preparando',
      cls: 'bg-slate-100 text-slate-700',
      dot: 'bg-slate-400',
      pulse: true,
    },
    qr: {
      label: 'Esperando escaneo',
      cls: 'bg-violeta-5 text-violeta',
      dot: 'bg-violeta-60',
      pulse: true,
    },
    connecting: {
      label: 'Conectando',
      cls: 'bg-turquesa-10 text-turquesa-140',
      dot: 'bg-turquesa',
      pulse: true,
    },
    connected: { label: 'Conectado', cls: 'bg-green-50 text-green-700', dot: 'bg-whatsapp' },
    reconnecting: {
      label: 'Reconectando',
      cls: 'bg-amber-50 text-amber-800',
      dot: 'bg-amber-500',
      pulse: true,
    },
    qr_expired: { label: 'QR expirado', cls: 'bg-slate-100 text-slate-600', dot: 'bg-slate-400' },
    logged_out: { label: 'Desconectado', cls: 'bg-slate-100 text-slate-600', dot: 'bg-slate-400' },
    error: { label: 'Error', cls: 'bg-red-50 text-red-700', dot: 'bg-danger' },
  };

export function StatusBadge({ status }: { status: SessionStatus }) {
  const s = STATUS[status];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold ${s.cls}`}
    >
      <span className="relative flex size-2">
        {s.pulse && (
          <span
            className={`absolute inline-flex size-full animate-ping rounded-full opacity-60 ${s.dot}`}
          />
        )}
        <span className={`relative inline-flex size-2 rounded-full ${s.dot}`} />
      </span>
      {s.label}
    </span>
  );
}

export function Avatar({
  name,
  src,
  size = 48,
}: {
  name: string | null | undefined;
  src?: string | null;
  size?: number;
}) {
  const style = { width: size, height: size, fontSize: Math.round(size * 0.36) };
  if (src)
    return (
      <img src={src} alt="" style={style} className="rounded-full object-cover ring-2 ring-white" />
    );
  return (
    <span
      style={style}
      className="grid shrink-0 place-items-center rounded-full bg-gradient-to-br from-violeta to-magenta font-bold text-white ring-2 ring-white"
      aria-hidden
    >
      {initials(name)}
    </span>
  );
}

export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    ref.current?.querySelector<HTMLElement>('input, button[data-autofocus]')?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-ink/40 p-4 backdrop-blur-sm"
      onMouseDown={onClose}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="card pop-in w-full max-w-md p-6"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <h2 className="text-lg font-black">{title}</h2>
          <button
            className="rounded-lg p-1 text-ink-soft hover:bg-slate-100"
            onClick={onClose}
            aria-label="Cerrar"
          >
            <X className="size-5" />
          </button>
        </div>
        <div className="text-sm leading-relaxed text-ink-soft">{children}</div>
        {footer && <div className="mt-6 flex flex-wrap justify-end gap-2">{footer}</div>}
      </div>
    </div>
  );
}

export function Spinner({ className = 'size-5' }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9.5" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
      <path
        d="M21.5 12a9.5 9.5 0 0 0-9.5-9.5"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function FullScreenMessage({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-screen place-items-center bg-canvas p-6">
      <div className="card w-full max-w-md p-8 text-center">{children}</div>
    </div>
  );
}
