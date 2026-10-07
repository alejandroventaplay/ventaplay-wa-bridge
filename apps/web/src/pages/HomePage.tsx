import { useState, type FormEvent } from 'react';
import { useNavigate, Link } from 'react-router';
import { ChevronRight, Plus, QrCode } from 'lucide-react';
import type { SessionSummary } from '@wa-bridge/shared';
import { useNow, useSessionsStream } from '../hooks/streams';
import { api } from '../lib/api';
import { fmtAgo, fmtNumber, fmtPhone } from '../lib/format';
import { AppShell, Avatar, Dialog, Spinner, StatusBadge } from '../components/ui';

export function HomePage() {
  const { sessions, loaded } = useSessionsStream();
  const [open, setOpen] = useState(false);

  return (
    <AppShell>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-black tracking-tight">WhatsApp conectados</h1>
          <p className="mt-1 text-ink-soft">
            Vincula el WhatsApp de un cliente para copiar sus contactos y chats.
          </p>
        </div>
        <button className="btn-primary" onClick={() => setOpen(true)}>
          <Plus className="size-4" /> Conectar WhatsApp
        </button>
      </div>

      <div className="mt-8">
        {!loaded ? (
          <div className="grid place-items-center py-24 text-violeta">
            <Spinner className="size-8" />
          </div>
        ) : sessions.length === 0 ? (
          <EmptyState onCreate={() => setOpen(true)} />
        ) : (
          <ul className="grid gap-3">
            {sessions.map((s) => (
              <SessionRow key={s.id} s={s} />
            ))}
          </ul>
        )}
      </div>

      <CreateDialog open={open} onClose={() => setOpen(false)} />
    </AppShell>
  );
}

function SessionRow({ s }: { s: SessionSummary }) {
  const now = useNow(30_000);
  const name = s.profile?.name ?? s.label ?? 'WhatsApp sin nombre';
  return (
    <li>
      <Link
        to={`/s/${s.id}`}
        className="card group flex items-center gap-4 p-4 transition hover:border-violeta-60/40 hover:shadow-md sm:p-5"
      >
        <Avatar name={name} src={s.profile?.pictureUrl} size={48} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="truncate font-black">{s.label ?? name}</span>
            <StatusBadge status={s.status} />
          </div>
          <p className="mt-0.5 truncate text-sm text-ink-soft">
            {s.profile
              ? `${s.profile.name ?? ''} ${fmtPhone(s.profile.phone)}`.trim()
              : 'Aún sin vincular'}
            <span className="mx-1.5">·</span>
            {fmtAgo(s.updatedAt, now)}
          </p>
        </div>
        {s.stats.messages > 0 && (
          <dl className="hidden gap-6 text-right md:flex">
            <Mini label="Contactos" value={s.stats.contacts} />
            <Mini label="Chats" value={s.stats.chats} />
            <Mini label="Mensajes" value={s.stats.messages} />
          </dl>
        )}
        <ChevronRight className="size-5 text-ink-soft transition group-hover:translate-x-0.5 group-hover:text-violeta" />
      </Link>
    </li>
  );
}

function Mini({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dd className="font-black tabular-nums">{fmtNumber(value)}</dd>
      <dt className="text-xs text-ink-soft">{label}</dt>
    </div>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="card flex flex-col items-center px-6 py-16 text-center">
      <span className="grid size-16 place-items-center rounded-2xl bg-violeta-5 text-violeta">
        <QrCode className="size-8" />
      </span>
      <h2 className="mt-5 text-xl font-black">Todavía no hay WhatsApp conectados</h2>
      <p className="mt-2 max-w-md text-sm text-ink-soft">
        Genera un código QR, escanéalo desde el teléfono del cliente y verás al instante cuántos
        contactos, chats y mensajes trae para migrar.
      </p>
      <button className="btn-primary mt-6" onClick={onCreate}>
        <Plus className="size-4" /> Conectar el primero
      </button>
    </div>
  );
}

function CreateDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const s = await api.create(label.trim() || null);
      setLabel('');
      onClose();
      navigate(`/s/${s.id}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="Conectar un WhatsApp">
      <form onSubmit={submit}>
        <label className="label" htmlFor="label">
          ¿De quién es este WhatsApp?
        </label>
        <input
          id="label"
          className="input"
          placeholder="Ej: Barbería Don Pepe"
          maxLength={80}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
        <p className="mt-2 text-xs">
          Es solo una etiqueta para encontrarlo después. Puedes dejarla vacía.
        </p>
        {error && <p className="mt-3 text-sm font-bold text-danger">{error}</p>}
        <div className="mt-6 flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn-primary" disabled={busy}>
            {busy ? <Spinner className="size-4" /> : <QrCode className="size-4" />} Generar QR
          </button>
        </div>
      </form>
    </Dialog>
  );
}
