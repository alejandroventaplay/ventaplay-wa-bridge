import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Ban,
  CheckCheck,
  Download,
  FileText,
  Folder,
  FolderOpen,
  Forward,
  Image as ImageIcon,
  Pencil,
  RefreshCw,
  Reply,
  Search,
  Smile,
  SquareTerminal,
  Users,
  X,
} from 'lucide-react';
import type { ArchivedMessage, MessageKind, ProjectInfo, SessionSummary } from '@wa-bridge/shared';
import { api, openFolderCommand, projectMediaBlob } from '../lib/api';
import { fmtAgo, fmtBytes, fmtDateTime, fmtNumber, fmtPhone } from '../lib/format';
import { Spinner } from './ui';

const KIND_ES: Record<MessageKind, string> = {
  text: 'Texto',
  image: 'Foto',
  video: 'Video',
  gif: 'GIF',
  audio: 'Audio',
  voice: 'Nota de voz',
  sticker: 'Sticker',
  document: 'Documento',
  location: 'Ubicación',
  contact: 'Contacto',
  poll: 'Encuesta',
  deleted: 'Eliminado',
  other: 'Otro',
};

/**
 * Pestaña de un proyecto: un chat aislado con TODO lo que llegó, cada mensaje con
 * sus metadatos, y la carpeta exportada (JSONL + Excel + archivos) para analizarlo.
 */
export function ProjectView({ session, jid }: { session: SessionSummary; jid: string }) {
  const id = session.id;
  const [data, setData] = useState<{ project: ProjectInfo; messages: ArchivedMessage[] } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<MessageKind | ''>('');
  const [who, setWho] = useState('');
  const [open, setOpen] = useState<ArchivedMessage | null>(null);
  const [exporting, setExporting] = useState(false);
  const version = `${session.personal?.messages ?? 0}:${session.updatedAt}`;

  useEffect(() => {
    let alive = true;
    const t = setTimeout(
      () =>
        void api
          .projectMessages(id, jid)
          .then((d) => alive && (setData(d), setError(null)))
          .catch((e: Error) => alive && setError(e.message)),
      data ? 1500 : 0,
    );
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, jid, version]);

  const people = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of data?.messages ?? []) map.set(personKey(m), personLabel(m));
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1], 'es'));
  }, [data]);

  const rows = useMemo(() => {
    const q = fold(query.trim());
    return (data?.messages ?? [])
      .filter(
        (m) =>
          (!kind || m.kind === kind) &&
          (!who || personKey(m) === who) &&
          (!q ||
            fold(m.text ?? '').includes(q) ||
            fold(m.media?.fileName ?? '').includes(q) ||
            fold(personLabel(m)).includes(q)),
      )
      .reverse();
  }, [data, query, kind, who]);

  const [copied, setCopied] = useState(false);
  const [opening, setOpening] = useState(false);

  async function copyCommand(dir: string) {
    try {
      await navigator.clipboard.writeText(openFolderCommand(dir));
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setError('No se pudo copiar al portapapeles');
    }
  }

  async function openFolder() {
    setOpening(true);
    try {
      await api.openProjectFolder(id, jid);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setOpening(false);
    }
  }

  async function exportNow() {
    setExporting(true);
    try {
      const project = await api.exportProject(id, jid);
      setData((d) => (d ? { ...d, project } : d));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setExporting(false);
    }
  }

  if (!data && !error)
    return (
      <div className="card grid h-[50vh] place-items-center text-violeta">
        <Spinner className="size-8" />
      </div>
    );
  if (!data) return <p className="card p-6 text-sm text-danger">{error}</p>;

  const p = data.project;
  return (
    <div className="space-y-4">
      <section className="card p-5">
        <div className="flex flex-wrap items-start gap-4">
          <span className="grid size-12 shrink-0 place-items-center rounded-2xl bg-turquesa-10 text-turquesa-140">
            <Users className="size-6" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-xl font-black">{p.name}</h2>
            <p className="text-sm text-ink-soft">
              Proyecto aislado {fmtAgo(p.since)} · se guarda todo lo que llega, sin tope
            </p>
          </div>
        </div>
        <dl className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Mensajes" value={fmtNumber(p.messages)} />
          <Stat label="Participantes" value={fmtNumber(p.participants)} />
          <Stat
            label="Archivos bajados"
            value={`${fmtNumber(p.media.downloaded)} / ${fmtNumber(p.media.total)}`}
            hint={p.media.bytes ? fmtBytes(p.media.bytes) : undefined}
            warn={p.media.failed ? `${p.media.failed} no se pudieron bajar` : undefined}
          />
          <Stat
            label="Desde · hasta"
            value={p.first ? shortDate(p.first) : '—'}
            hint={p.last ? `hasta ${shortDate(p.last)}` : undefined}
          />
        </dl>
        <div className="mt-4 flex flex-wrap gap-1.5">
          {Object.entries(p.kinds)
            .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
            .map(([k, n]) => (
              <button
                key={k}
                onClick={() => setKind(kind === k ? '' : (k as MessageKind))}
                className={`rounded-full px-2.5 py-1 text-xs font-bold transition ${
                  kind === k
                    ? 'bg-violeta text-white'
                    : 'bg-violeta-5 text-violeta hover:bg-violeta-10'
                }`}
              >
                {KIND_ES[k as MessageKind] ?? k} · {n}
              </button>
            ))}
        </div>
        {p.exportDir && (
          <div className="mt-5 flex flex-wrap items-center gap-3 rounded-xl bg-canvas px-4 py-3">
            <Folder className="size-5 shrink-0 text-violeta" />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-bold text-ink-soft">
                Carpeta para analizar (JSONL, Excel y archivos) · se actualiza sola
                {p.exportedAt ? ` · última vez ${fmtAgo(p.exportedAt)}` : ''}
              </p>
              <code className="block truncate text-sm" title={p.exportDir}>
                {p.exportDir}
              </code>
            </div>
            <button
              className="btn-secondary px-3 py-2"
              onClick={() => void copyCommand(p.exportDir!)}
              title={`Copia: ${openFolderCommand(p.exportDir)} — pégalo en la Terminal y se abre la carpeta`}
            >
              {copied ? (
                <CheckCheck className="size-4 text-turquesa-140" />
              ) : (
                <SquareTerminal className="size-4" />
              )}
              {copied ? '¡Copiado!' : 'Copiar comando'}
            </button>
            <button
              className="btn-secondary px-3 py-2"
              onClick={() => void openFolder()}
              disabled={opening}
              title="Abre la carpeta en Finder (Mac) o el Explorador (Windows)"
            >
              {opening ? <Spinner className="size-4" /> : <FolderOpen className="size-4" />}
              Abrir carpeta
            </button>
            <button
              className="btn-primary px-3 py-2"
              onClick={() => void exportNow()}
              disabled={exporting}
            >
              {exporting ? <Spinner className="size-4" /> : <RefreshCw className="size-4" />}
              Exportar ahora
            </button>
          </div>
        )}
      </section>

      <section className="card overflow-hidden">
        <div className="flex flex-wrap gap-2 border-b border-line p-3">
          <label className="relative min-w-[200px] flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-soft" />
            <input
              className="input py-2 pl-9"
              placeholder="Buscar texto, archivo o persona"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <select
            className="input w-auto py-2"
            value={who}
            onChange={(e) => setWho(e.target.value)}
            aria-label="Persona"
          >
            <option value="">Todas las personas</option>
            {people.map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
          <select
            className="input w-auto py-2"
            value={kind}
            onChange={(e) => setKind(e.target.value as MessageKind | '')}
            aria-label="Tipo"
          >
            <option value="">Todos los tipos</option>
            {Object.keys(p.kinds).map((k) => (
              <option key={k} value={k}>
                {KIND_ES[k as MessageKind] ?? k}
              </option>
            ))}
          </select>
        </div>
        <p className="border-b border-line bg-canvas px-4 py-2 text-xs text-ink-soft">
          {fmtNumber(rows.length)} de {fmtNumber(data.messages.length)} mensajes · del más nuevo al
          más antiguo · clic para ver todos los datos
        </p>
        <div className="max-h-[70vh] overflow-auto">
          <table className="w-full text-left text-sm">
            <thead className="sticky top-0 z-10 bg-white text-xs text-ink-soft shadow-[0_1px_0_var(--color-line)]">
              <tr>
                <th className="px-4 py-2 font-bold">Fecha</th>
                <th className="px-2 py-2 font-bold">Autor</th>
                <th className="px-2 py-2 font-bold">Tipo</th>
                <th className="px-2 py-2 font-bold">Contenido</th>
                <th className="px-4 py-2 font-bold">Metadatos</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr
                  key={m.id}
                  onClick={() => setOpen(m)}
                  className="cursor-pointer border-b border-line/60 align-top hover:bg-violeta-5"
                >
                  <td className="px-4 py-2.5 whitespace-nowrap text-ink-soft tabular-nums">
                    {fmtDateTime(m.timestamp)}
                  </td>
                  <td className="max-w-[160px] truncate px-2 py-2.5 font-semibold">
                    {personLabel(m)}
                  </td>
                  <td className="px-2 py-2.5 whitespace-nowrap">{KIND_ES[m.kind]}</td>
                  <td className="px-2 py-2.5">
                    {m.media?.fileName && (
                      <span className="mb-0.5 flex items-center gap-1 text-xs font-bold text-violeta">
                        <FileText className="size-3.5" /> {m.media.fileName}
                      </span>
                    )}
                    <span className="line-clamp-2 break-words whitespace-pre-wrap">
                      {m.deleted ? (
                        <span className="text-ink-soft italic">
                          Eliminado · decía: {m.edits.at(-1)?.previousText ?? '—'}
                        </span>
                      ) : (
                        (m.text ?? <span className="text-ink-soft">—</span>)
                      )}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    <Badges m={m} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!rows.length && (
            <p className="p-10 text-center text-sm text-ink-soft">Ningún mensaje coincide.</p>
          )}
        </div>
      </section>

      {open && <Detail sessionId={id} jid={jid} message={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  warn,
}: {
  label: string;
  value: string;
  hint?: string;
  warn?: string;
}) {
  return (
    <div className="rounded-xl border border-line px-4 py-3">
      <dt className="text-xs font-bold text-ink-soft">{label}</dt>
      <dd className="mt-0.5 text-xl font-black tabular-nums">{value}</dd>
      {hint && <dd className="text-xs text-ink-soft">{hint}</dd>}
      {warn && <dd className="text-xs text-danger">{warn}</dd>}
    </div>
  );
}

function Badges({ m }: { m: ArchivedMessage }) {
  const items: [ReactNode, string][] = [];
  if (m.quoted) items.push([<Reply className="size-3.5" />, 'Responde a otro mensaje']);
  if (m.forwarded) items.push([<Forward className="size-3.5" />, 'Reenviado']);
  if (m.edits.length && !m.deleted) items.push([<Pencil className="size-3.5" />, 'Editado']);
  if (m.deleted) items.push([<Ban className="size-3.5" />, 'Eliminado']);
  if (m.media)
    items.push([
      m.media.downloaded ? (
        <Download className="size-3.5 text-turquesa-140" />
      ) : (
        <Download className="size-3.5 opacity-40" />
      ),
      m.media.downloaded ? 'Archivo bajado' : (m.media.error ?? 'Archivo pendiente'),
    ]);
  if (m.receipts.some((r) => r.read))
    items.push([<CheckCheck className="size-3.5 text-[#53bdeb]" />, 'Leído']);
  return (
    <span className="flex flex-wrap items-center gap-1.5 text-ink-soft">
      {items.map(([icon, title], i) => (
        <span key={i} title={title}>
          {icon}
        </span>
      ))}
      {m.reactions.length > 0 && (
        <span className="rounded-full bg-canvas px-1.5 text-xs" title="Reacciones">
          {m.reactions.map((r) => r.emoji).join('')}
        </span>
      )}
    </span>
  );
}

function Detail({
  sessionId,
  jid,
  message: m,
  onClose,
}: {
  sessionId: string;
  jid: string;
  message: ArchivedMessage;
  onClose: () => void;
}) {
  const [raw, setRaw] = useState<unknown>(null);
  const [rawBusy, setRawBusy] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [mediaError, setMediaError] = useState<string | null>(null);

  useEffect(() => {
    if (!m.media?.downloaded) return;
    let alive = true;
    let made: string | null = null;
    projectMediaBlob(sessionId, jid, m.id)
      .then((u) => {
        made = u;
        if (alive) setUrl(u);
      })
      .catch((e: Error) => alive && setMediaError(e.message));
    return () => {
      alive = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [sessionId, jid, m.id, m.media?.downloaded]);

  async function loadRaw() {
    setRawBusy(true);
    try {
      const r = await api.projectMessages(sessionId, jid, {
        before: m.timestamp + 1,
        limit: 50,
        raw: true,
      });
      setRaw(r.messages.find((x) => x.id === m.id)?.raw ?? null);
    } finally {
      setRawBusy(false);
    }
  }

  const { raw: _r, ...fields } = m;
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/30" onClick={onClose}>
      <aside
        className="flex h-full w-full max-w-xl flex-col bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0 flex-1">
            <p className="truncate font-black">{personLabel(m)}</p>
            <p className="text-xs text-ink-soft">
              {KIND_ES[m.kind]} · {fmtDateTime(m.timestamp)}
            </p>
          </div>
          <button className="btn-secondary px-2 py-2" onClick={onClose} aria-label="Cerrar">
            <X className="size-4" />
          </button>
        </header>
        <div className="flex-1 space-y-4 overflow-y-auto p-5 text-sm">
          {m.text && <p className="rounded-xl bg-canvas p-3 whitespace-pre-wrap">{m.text}</p>}
          {m.media && (
            <div className="rounded-xl border border-line p-3">
              {url && m.kind === 'image' ? (
                <a href={url} target="_blank" rel="noreferrer">
                  <img src={url} alt="" className="max-h-72 rounded-lg" />
                </a>
              ) : null}
              <p className="mt-2 flex items-center gap-2 font-bold">
                {m.kind === 'image' ? (
                  <ImageIcon className="size-4 text-violeta" />
                ) : (
                  <FileText className="size-4 text-violeta" />
                )}
                {m.media.fileName ?? KIND_ES[m.kind]}
              </p>
              <p className="text-xs text-ink-soft">
                {[
                  m.media.mimetype,
                  fmtBytes(m.media.size),
                  m.media.pageCount && `${m.media.pageCount} págs.`,
                ]
                  .filter(Boolean)
                  .join(' · ')}
                {m.media.verified === true && ' · hash verificado'}
                {m.media.verified === false && ' · ⚠ el hash no coincide'}
              </p>
              {url ? (
                <a
                  className="btn-secondary mt-2 px-3 py-1.5"
                  href={url}
                  download={m.media.fileName ?? `${m.id}`}
                >
                  <Download className="size-4" /> Descargar
                </a>
              ) : (
                <p className="mt-2 text-xs text-ink-soft">
                  {mediaError ?? m.media.error ?? 'Todavía no se baja este archivo'}
                </p>
              )}
            </div>
          )}
          {m.reactions.length > 0 && (
            <p className="flex items-center gap-2">
              <Smile className="size-4 text-ink-soft" />
              {m.reactions.map((r) => `${r.emoji} ${fmtPhone(r.sender.split('@')[0])}`).join(' · ')}
            </p>
          )}
          <div>
            <p className="mb-1 text-xs font-bold text-ink-soft">Todos los datos</p>
            <pre className="max-h-[40vh] overflow-auto rounded-xl bg-[#1a0b2e] p-3 text-[11.5px] leading-relaxed text-white">
              {JSON.stringify(fields, null, 2)}
            </pre>
          </div>
          <div>
            {raw ? (
              <>
                <p className="mb-1 text-xs font-bold text-ink-soft">Mensaje original de WhatsApp</p>
                <pre className="max-h-[40vh] overflow-auto rounded-xl bg-canvas p-3 text-[11.5px] leading-relaxed">
                  {JSON.stringify(raw, null, 2)}
                </pre>
              </>
            ) : (
              <button
                className="btn-secondary px-3 py-1.5"
                onClick={() => void loadRaw()}
                disabled={rawBusy}
              >
                {rawBusy ? <Spinner className="size-4" /> : null} Ver mensaje original de WhatsApp
              </button>
            )}
          </div>
        </div>
      </aside>
    </div>
  );
}

const personKey = (m: ArchivedMessage) => (m.fromMe ? 'yo' : (m.sender.lid ?? m.sender.jid ?? '?'));
const personLabel = (m: ArchivedMessage) =>
  m.fromMe ? 'Tú' : (m.sender.name ?? (m.sender.phone ? fmtPhone(m.sender.phone) : 'Participante'));
const shortDate = (ms: number) =>
  new Date(ms).toLocaleDateString('es-CL', { day: 'numeric', month: 'short', year: 'numeric' });
const fold = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');
