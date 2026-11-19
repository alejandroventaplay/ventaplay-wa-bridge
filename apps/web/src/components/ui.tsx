import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import { Bot, KeyRound, LayoutGrid, LockKeyhole, LogOut, Menu, Settings, X } from 'lucide-react';
import type { SessionStatus, SessionSummary } from '@wa-bridge/shared';
import { useAuth } from '../hooks/auth';
import { useSessionsStream } from '../hooks/streams';
import { initials } from '../lib/format';

export function Logo({ className = '' }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <img src="/ventaplay-logo-iso.svg" alt="" className="h-6 w-auto" />
      <span className="text-[17px] font-black tracking-tight text-violeta">VentaPlay</span>
    </span>
  );
}

/**
 * Qué puede hacer este WhatsApp: respaldo (solo estadísticas), asistente sin envío,
 * o asistente que envía (siempre con tu confirmación y con límites).
 */
export function ModeBadge({
  session,
  compact = false,
}: {
  session: Pick<SessionSummary, 'assistant'>;
  compact?: boolean;
}) {
  const a = session.assistant;
  if (a?.send)
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-full border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs font-bold text-amber-800"
        title="Modo asistente: lee y busca tus chats y puede enviar desde tu número, siempre con tu confirmación y con límites"
      >
        <Bot className="size-3.5" aria-hidden />
        {compact ? 'Asistente · envía con tu OK' : 'Asistente · envío solo con tu confirmación'}
      </span>
    );
  if (a)
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-full border border-violeta/20 bg-violeta-5 px-2.5 py-1 text-xs font-bold text-violeta"
        title="Modo asistente: lee, busca y transcribe; el envío está apagado"
      >
        <Bot className="size-3.5" aria-hidden />
        {compact ? 'Asistente · sin envío' : 'Asistente · lectura, sin envío'}
      </span>
    );
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border border-turquesa/30 bg-turquesa-10 px-2.5 py-1 text-xs font-bold text-turquesa-140"
      title="Respaldo: solo estadísticas; nunca envía mensajes ni guarda su contenido"
    >
      <LockKeyhole className="size-3.5" aria-hidden />
      {compact ? 'Respaldo · solo lectura' : 'Respaldo · nunca enviamos mensajes'}
    </span>
  );
}

/**
 * Marco de la app: menú lateral fijo (en el celular, cajón con ☰) con los WhatsApp
 * conectados, las vistas del abierto (`nav`), Configuración y la cuenta.
 */
export function AppShell({
  children,
  session,
  nav,
}: {
  children: ReactNode;
  /** la sesión abierta: el sello muestra su modo (en el inicio no se muestra) */
  session?: Pick<SessionSummary, 'id' | 'assistant'> | null;
  /** submenú de la sesión abierta (Mi vista, General, fijados) */
  nav?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  // al navegar, el cajón del celular se cierra solo (ajuste durante el render, sin efecto)
  const here = location.pathname + location.search;
  const [seen, setSeen] = useState(here);
  if (seen !== here) {
    setSeen(here);
    setOpen(false);
  }
  return (
    <div className="min-h-screen lg:pl-72">
      {/* barra superior solo en celular */}
      <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-line/80 bg-white/90 px-4 backdrop-blur lg:hidden">
        <button
          className="grid size-9 place-items-center rounded-xl text-ink hover:bg-violeta-5"
          onClick={() => setOpen(true)}
          aria-label="Abrir menú"
        >
          <Menu className="size-5" />
        </button>
        <Link to="/" aria-label="Inicio">
          <Logo />
        </Link>
      </header>

      {open && (
        <div
          className="fixed inset-0 z-40 bg-ink/30 backdrop-blur-[2px] lg:hidden"
          onClick={() => setOpen(false)}
          aria-hidden
        />
      )}
      <aside
        className={`fixed inset-y-0 left-0 z-50 flex w-72 flex-col border-r border-line bg-white transition-transform duration-200 lg:translate-x-0 ${
          open ? 'translate-x-0 shadow-2xl' : '-translate-x-full'
        }`}
      >
        <Sidebar activeId={session?.id ?? null} nav={nav} onClose={() => setOpen(false)} />
      </aside>

      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:py-8">
        {session && (
          <div className="mb-4 flex justify-end md:hidden">
            <ModeBadge compact session={session} />
          </div>
        )}
        {children}
      </main>
    </div>
  );
}

function Sidebar({
  activeId,
  nav,
  onClose,
}: {
  activeId: string | null;
  nav?: ReactNode;
  onClose: () => void;
}) {
  const { state, logout } = useAuth();
  const { sessions: all, loaded } = useSessionsStream();
  // tu WhatsApp (asistente) primero; después los de clientes
  const sessions = [...all].sort(
    (a, b) => Number(Boolean(b.assistant)) - Number(Boolean(a.assistant)),
  );
  const location = useLocation();
  const email = state.phase === 'signed-in' ? state.email : null;
  const driver = state.phase === 'signed-in' ? state.health.driver : null;
  const authMode = state.phase === 'signed-in' ? state.health.auth : null;
  return (
    <>
      <div className="flex h-16 shrink-0 items-center gap-2 px-5">
        <Link to="/" className="flex items-center gap-2.5" aria-label="Inicio">
          <Logo />
          <span className="rounded-md bg-violeta-5 px-2 py-0.5 text-[11px] font-bold whitespace-nowrap text-violeta">
            WA Bridge
          </span>
        </Link>
        <button
          className="ml-auto grid size-8 place-items-center rounded-lg text-ink-soft hover:bg-violeta-5 lg:hidden"
          onClick={onClose}
          aria-label="Cerrar menú"
        >
          <X className="size-4" />
        </button>
      </div>
      {driver === 'simulator' && (
        <p className="mx-5 mb-2 rounded-md bg-amber-100 px-2 py-1 text-xs font-bold text-amber-800">
          Modo simulador
        </p>
      )}

      <nav className="flex-1 space-y-6 overflow-y-auto px-3 pt-2 pb-6" aria-label="Menú principal">
        <div>
          <NavItem
            to="/"
            icon={<LayoutGrid className="size-[18px]" />}
            label="Inicio"
            active={location.pathname === '/'}
          />
        </div>

        <div>
          <SectionLabel>WhatsApp</SectionLabel>
          <ul className="space-y-0.5">
            {sessions.map((s) => {
              const active = s.id === activeId;
              const name = s.label ?? s.profile?.name ?? 'Sin nombre';
              return (
                <li key={s.id}>
                  <Link
                    to={`/s/${s.id}`}
                    className={`flex items-center gap-3 rounded-xl px-3 py-2 transition ${
                      active ? 'bg-violeta-5' : 'hover:bg-canvas'
                    }`}
                  >
                    <span className="relative grid size-8 shrink-0 place-items-center rounded-full bg-violeta-10 text-xs font-black text-violeta">
                      {initials(name)}
                      <span
                        className={`absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-white ${STATUS[s.status].dot}`}
                        title={STATUS[s.status].label}
                      />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span
                        className={`block truncate text-sm font-bold ${active ? 'text-violeta' : 'text-ink'}`}
                      >
                        {name}
                      </span>
                      <span className="block truncate text-xs text-ink-soft">
                        {s.assistant ? 'Asistente' : s.migration ? 'Migración' : 'Respaldo'}
                        {' · '}
                        {STATUS[s.status].label}
                      </span>
                    </span>
                  </Link>
                  {active && nav && (
                    <div className="mt-1 mb-2 ml-[22px] border-l border-line pl-3">{nav}</div>
                  )}
                </li>
              );
            })}
            {loaded && !sessions.length && (
              <li className="px-3 py-2 text-sm text-ink-soft">Ninguno conectado todavía</li>
            )}
          </ul>
        </div>
      </nav>

      <div className="shrink-0 space-y-1 border-t border-line p-3">
        <NavItem
          to="/config"
          icon={<Settings className="size-[18px]" />}
          label="Configuración"
          active={location.pathname.startsWith('/config')}
        />
        <div className="flex items-center gap-3 rounded-xl px-3 py-2">
          <span className="grid size-8 shrink-0 place-items-center rounded-full bg-violeta text-xs font-bold text-white">
            {email ? (
              initials(email.split('@')[0]?.replace(/[._-]/g, ' '))
            ) : (
              <KeyRound className="size-4" />
            )}
          </span>
          <span className="min-w-0 flex-1 truncate text-sm text-ink-soft">
            {email ?? 'Acceso con token'}
          </span>
          {authMode !== 'none' && (
            <button
              className="grid size-8 place-items-center rounded-lg text-ink-soft hover:bg-red-50 hover:text-danger"
              onClick={() => void logout()}
              title="Cerrar sesión"
              aria-label="Cerrar sesión"
            >
              <LogOut className="size-4" />
            </button>
          )}
        </div>
      </div>
    </>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <p className="mb-1.5 px-3 text-[11px] font-black tracking-wider text-ink-soft/80 uppercase">
      {children}
    </p>
  );
}

/** ítem del menú lateral: link (`to`) o botón (`onClick`) */
export function NavItem({
  to,
  onClick,
  icon,
  label,
  active,
  badge,
  small = false,
}: {
  to?: string;
  onClick?: () => void;
  icon: ReactNode;
  label: string;
  active: boolean;
  badge?: ReactNode;
  small?: boolean;
}) {
  const cls = `flex w-full items-center gap-3 rounded-xl px-3 text-left transition ${
    small ? 'py-1.5 text-[13px]' : 'py-2 text-sm'
  } ${
    active
      ? 'bg-violeta text-white font-bold shadow-sm'
      : 'font-semibold text-ink/80 hover:bg-violeta-5 hover:text-violeta'
  }`;
  const inner = (
    <>
      <span className={`shrink-0 ${active ? 'text-white' : 'text-ink-soft'}`}>{icon}</span>
      <span className="min-w-0 flex-1 truncate" title={label}>
        {label}
      </span>
      {badge}
    </>
  );
  return to ? (
    <Link to={to} className={cls} aria-current={active ? 'page' : undefined}>
      {inner}
    </Link>
  ) : (
    <button
      type="button"
      onClick={onClick}
      className={cls}
      aria-current={active ? 'page' : undefined}
    >
      {inner}
    </button>
  );
}

/** título chico dentro de un submenú (p. ej. "Fijados") */
export function NavHeading({ children }: { children: ReactNode }) {
  return (
    <p className="mt-3 mb-1 flex items-center gap-1.5 px-3 text-[11px] font-black tracking-wider text-ink-soft/80 uppercase">
      {children}
    </p>
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
