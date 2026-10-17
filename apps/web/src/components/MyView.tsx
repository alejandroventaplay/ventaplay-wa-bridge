import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ArrowLeft,
  Ban,
  BarChart3,
  Camera,
  Download,
  FileText,
  Film,
  FolderKanban,
  Headphones,
  History,
  ImageOff,
  Lock,
  MapPin,
  MessageCircle,
  Mic,
  Search,
  Smile,
  UserRound,
  Users,
} from 'lucide-react';
import type {
  ChatMessage,
  HistoryFetchStatus,
  MessageKind,
  PersonalChat,
  PersonalChatList,
  PersonalChatMessages,
  SessionSummary,
} from '@wa-bridge/shared';
import { useNow } from '../hooks/streams';
import { api, mediaBlob, type MediaBlob } from '../lib/api';
import {
  fmtBytes,
  fmtChatStamp,
  fmtDate,
  fmtDayLabel,
  fmtDuration,
  fmtNumber,
  fmtPhone,
  fmtTime,
  isSameDay,
} from '../lib/format';
import { Composer } from './Composer';
import { Avatar, Spinner } from './ui';

type Filter = 'people' | 'groups';

/**
 * "Mi vista": tus conversaciones y grupos de los últimos 30 días, con los últimos
 * mensajes de cada uno, al estilo WhatsApp. Con ALLOW_SEND puedes escribir y mandar
 * fotos o archivos (con límites); nunca marca como leído ni te pone "en línea".
 */
export function MyView({
  session,
  projects = [],
  onIsolate,
  onProjectsChanged,
}: {
  session: SessionSummary;
  /** chats aislados como proyecto */
  projects?: string[];
  /** aísla el chat (o abre su pestaña si ya lo está) */
  onIsolate?: (jid: string) => Promise<void>;
  /** algo creó o cambió un proyecto por fuera (p. ej. traer toda la conversación) */
  onProjectsChanged?: () => void;
}) {
  const id = session.id;
  const [list, setList] = useState<PersonalChatList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('people');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const now = useNow(60_000);
  const version = `${session.personal?.chats ?? 0}:${session.personal?.messages ?? 0}`;

  // recarga la lista cuando llegan mensajes nuevos (con un respiro para agrupar)
  useEffect(() => {
    let alive = true;
    const t = setTimeout(
      () => {
        api
          .personalChats(id)
          .then((l) => alive && (setList(l), setError(null)))
          .catch((e: Error) => alive && setError(e.message));
      },
      list ? 1500 : 0,
    );
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, version]);

  const items = useMemo(() => {
    const q = normalize(query.trim());
    return (list?.items ?? []).filter(
      (c) =>
        (filter === 'groups' ? c.isGroup : !c.isGroup) &&
        (!q ||
          normalize(c.name).includes(q) ||
          (c.phone ?? '').includes(q.replace(/\D/g, '') || '§') ||
          normalize(c.preview ?? '').includes(q)),
    );
  }, [list, filter, query]);

  const current = list?.items.find((c) => c.jid === selected) ?? null;

  if (!list && !error)
    return (
      <div className="card grid h-[60vh] place-items-center text-violeta">
        <Spinner className="size-8" />
      </div>
    );

  return (
    <div className="space-y-3">
      <div className="card grid h-[calc(100dvh-230px)] min-h-[560px] overflow-hidden lg:grid-cols-[minmax(300px,380px)_1fr]">
        {/* lista */}
        <aside
          className={`min-h-0 flex-col border-line lg:flex lg:border-r ${current ? 'hidden' : 'flex'}`}
        >
          <div className="space-y-3 border-b border-line p-4">
            <div className="flex items-baseline justify-between gap-2">
              <h2 className="text-lg font-black">Chats</h2>
              <span className="text-xs text-ink-soft">
                Últimos {list?.windowDays ?? 30} días · {list?.perChat ?? 10} mensajes c/u
              </span>
            </div>
            <div className="grid grid-cols-2 gap-1 rounded-xl bg-violeta-5 p-1" role="tablist">
              <SegButton active={filter === 'people'} onClick={() => setFilter('people')}>
                <MessageCircle className="size-4" /> Conversaciones
                <Count n={list?.individual ?? 0} active={filter === 'people'} />
              </SegButton>
              <SegButton active={filter === 'groups'} onClick={() => setFilter('groups')}>
                <Users className="size-4" /> Grupos
                <Count n={list?.groups ?? 0} active={filter === 'groups'} />
              </SegButton>
            </div>
            <label className="relative block">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-soft" />
              <input
                className="input py-2 pl-9"
                placeholder="Buscar un chat"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {error && <p className="p-4 text-sm text-danger">{error}</p>}
            {items.length === 0 && !error && (
              <EmptyList
                filtering={Boolean(query)}
                waiting={(session.personal?.chats ?? 0) === 0}
                syncing={session.stats.state !== 'complete'}
              />
            )}
            <ul>
              {items.map((c) => (
                <li key={c.jid}>
                  <ChatRow
                    chat={c}
                    now={now}
                    active={c.jid === selected}
                    onClick={() => setSelected(c.jid)}
                  />
                </li>
              ))}
            </ul>
          </div>
        </aside>

        {/* conversación */}
        <section className={`min-h-0 flex-col lg:flex ${current ? 'flex' : 'hidden'}`}>
          {current ? (
            <ChatPanel
              key={current.jid}
              sessionId={id}
              chat={current}
              now={now}
              sendEnabled={Boolean(session.personal?.sendEnabled)}
              isolated={projects.includes(current.jid)}
              onIsolate={onIsolate}
              onProjectsChanged={onProjectsChanged}
              onBack={() => setSelected(null)}
            />
          ) : (
            <NoChat sendEnabled={Boolean(session.personal?.sendEnabled)} />
          )}
        </section>
      </div>
      <p className="flex items-center justify-center gap-1.5 text-xs text-ink-soft">
        <Lock className="size-3.5" /> Solo tú ves esta pestaña. Los mensajes quedan cifrados en este
        equipo y se borran al desconectar.
      </p>
    </div>
  );
}

// ----------------------------------------------------------------- lista

function SegButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-sm font-bold transition ${
        active ? 'bg-white text-violeta shadow-sm' : 'text-ink-soft hover:text-ink'
      }`}
    >
      {children}
    </button>
  );
}

function Count({ n, active }: { n: number; active: boolean }) {
  return (
    <span
      className={`rounded-full px-1.5 text-xs tabular-nums ${active ? 'bg-violeta-10 text-violeta' : 'bg-white/70'}`}
    >
      {fmtNumber(n)}
    </span>
  );
}

function ChatAvatar({ chat, size = 46 }: { chat: PersonalChat; size?: number }) {
  if (chat.isGroup)
    return (
      <span
        style={{ width: size, height: size }}
        className="grid shrink-0 place-items-center rounded-full bg-turquesa-10 text-turquesa-140"
        aria-hidden
      >
        <Users style={{ width: size * 0.45, height: size * 0.45 }} />
      </span>
    );
  return <Avatar name={chat.name} size={size} />;
}

function ChatRow({
  chat,
  now,
  active,
  onClick,
}: {
  chat: PersonalChat;
  now: number;
  active: boolean;
  onClick: () => void;
}) {
  const who = chat.previewFromMe ? 'Tú' : chat.isGroup ? chat.previewSender : null;
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-3 border-b border-line/60 px-4 py-3 text-left transition ${
        active ? 'bg-violeta-5' : 'hover:bg-canvas'
      }`}
    >
      <ChatAvatar chat={chat} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate font-bold">{chat.name}</span>
          <span className="shrink-0 text-xs text-ink-soft tabular-nums">
            {fmtChatStamp(chat.lastMessageAt, now)}
          </span>
        </span>
        <span className="mt-0.5 flex items-center gap-1 text-sm text-ink-soft">
          {who && <span className="shrink-0 font-semibold">{who}:</span>}
          <KindIcon kind={chat.previewKind} className="size-3.5 shrink-0" />
          <span className="truncate">{previewText(chat.previewKind, chat.preview)}</span>
        </span>
      </span>
    </button>
  );
}

function EmptyList({
  filtering,
  waiting,
  syncing,
}: {
  filtering: boolean;
  waiting: boolean;
  syncing: boolean;
}) {
  return (
    <div className="grid place-items-center gap-2 px-6 py-16 text-center text-sm text-ink-soft">
      {waiting && syncing ? <Spinner className="size-6 text-violeta" /> : null}
      <p>
        {filtering
          ? 'Ningún chat coincide con la búsqueda.'
          : waiting && syncing
            ? 'Copiando tus mensajes desde WhatsApp…'
            : 'No hay chats con actividad en los últimos 30 días.'}
      </p>
    </div>
  );
}

function NoChat({ sendEnabled }: { sendEnabled: boolean }) {
  return (
    <div className="grid h-full place-items-center bg-[#f0f2f5] p-10 text-center">
      <div className="max-w-sm">
        <span className="mx-auto mb-4 grid size-16 place-items-center rounded-full bg-violeta-10 text-violeta">
          <MessageCircle className="size-8" />
        </span>
        <p className="text-lg font-black">Elige un chat</p>
        <p className="mt-1 text-sm text-ink-soft">
          {sendEnabled
            ? 'Verás sus últimos mensajes y podrás responder con texto, fotos o archivos. No marca como leído.'
            : 'Verás sus últimos mensajes. Esta vista es de solo lectura: no envía nada ni marca como leído.'}
        </p>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------- chat

/**
 * "Traer toda la conversación": le pide a tu teléfono el historial antiguo del chat
 * por tramos y lo guarda completo en su proyecto. Muestra el avance mientras llega.
 */
function FetchHistoryButton({
  sessionId,
  jid,
  onOpen,
  onChanged,
}: {
  sessionId: string;
  jid: string;
  onOpen?: ((jid: string) => Promise<void>) | undefined;
  /** el chat quedó aislado como proyecto: la pestaña nueva debe aparecer */
  onChanged?: (() => void) | undefined;
}) {
  const [st, setSt] = useState<HistoryFetchStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const running = st?.state === 'running';

  useEffect(() => {
    let alive = true;
    api
      .historyStatus(sessionId, jid)
      .then((s) => alive && setSt(s))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [sessionId, jid]);

  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !running) onChanged?.();
    wasRunning.current = running;
  }, [running, onChanged]);

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => {
      api
        .historyStatus(sessionId, jid)
        .then(setSt)
        .catch((e: Error) => setError(e.message));
    }, 2000);
    return () => clearInterval(t);
  }, [running, sessionId, jid]);

  const finished = st && (st.state === 'done' || st.state === 'error');
  const label = running
    ? `Trayendo… ${fmtNumber(st.total)}`
    : finished && st.state === 'done'
      ? `Completa · ${fmtNumber(st.total)}`
      : 'Traer toda la conversación';
  const title = running
    ? `Pidiéndole el historial a tu teléfono (tramo ${st.pages + 1}). +${fmtNumber(st.added)} mensajes antiguos hasta ahora.`
    : st?.state === 'done'
      ? `${fmtNumber(st.total)} mensajes guardados desde el ${fmtDate(st.oldest)}${
          st.reason === 'limit' ? ' (tope de tramos: vuelve a pedir para seguir)' : ''
        }${
          st.reason === 'timeout'
            ? '. No llegó nada más antiguo: o ya estaba completa, o el teléfono no respondió (prueba con WhatsApp abierto en el teléfono)'
            : ''
        }. Clic para ver todo.`
      : st?.state === 'error'
        ? `No se pudo: ${st.error ?? error ?? 'error'}`
        : 'Le pide a tu teléfono todo el historial antiguo de este chat y lo guarda completo, sin tope';

  return (
    <button
      className="btn-secondary px-3 py-2"
      disabled={running}
      title={error ?? title}
      onClick={() => {
        setError(null);
        if (st?.state === 'done' && onOpen) {
          void onOpen(jid).catch((e: Error) => setError(e.message));
          return;
        }
        api
          .fetchHistory(sessionId, jid)
          .then((s) => {
            setSt(s);
            onChanged?.();
          })
          .catch((e: Error) => setError(e.message));
      }}
    >
      {running ? <Spinner className="size-4" /> : <History className="size-4" />}
      <span className="hidden sm:inline">{error ? 'Reintentar' : label}</span>
    </button>
  );
}

function ChatPanel({
  sessionId,
  chat,
  now,
  sendEnabled,
  isolated,
  onIsolate,
  onProjectsChanged,
  onBack,
}: {
  sessionId: string;
  chat: PersonalChat;
  now: number;
  sendEnabled: boolean;
  isolated: boolean;
  onIsolate?: (jid: string) => Promise<void>;
  onProjectsChanged?: (() => void) | undefined;
  onBack: () => void;
}) {
  const [isolating, setIsolating] = useState(false);
  const [data, setData] = useState<PersonalChatMessages | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dropped, setDropped] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);

  /** agrega lo recién enviado sin esperar a recargar el chat */
  function onSent(m: ChatMessage) {
    setData((d) =>
      d && !d.messages.some((x) => x.id === m.id) ? { ...d, messages: [...d.messages, m] } : d,
    );
  }

  useEffect(() => {
    let alive = true;
    api
      .personalMessages(sessionId, chat.jid)
      .then((d) => alive && (setData(d), setError(null)))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [sessionId, chat.jid, chat.lastMessageAt]);

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [data]);

  const subtitle = chat.isGroup
    ? 'Grupo'
    : chat.phone
      ? fmtPhone(chat.phone)
      : 'Contacto sin número visible';

  return (
    <>
      <header className="flex items-center gap-3 border-b border-line bg-white px-4 py-3">
        <button className="btn-secondary px-2 py-2 lg:hidden" onClick={onBack} aria-label="Volver">
          <ArrowLeft className="size-4" />
        </button>
        <ChatAvatar chat={chat} size={40} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-black">{chat.name}</p>
          <p className="truncate text-xs text-ink-soft">{subtitle}</p>
        </div>
        <FetchHistoryButton
          sessionId={sessionId}
          jid={chat.jid}
          onOpen={onIsolate}
          onChanged={onProjectsChanged}
        />
        {onIsolate && (
          <button
            className="btn-secondary px-3 py-2"
            disabled={isolating}
            title={
              isolated
                ? 'Este chat ya se guarda completo: abre su pestaña'
                : 'Guardar TODO este chat (sin tope) con sus metadatos y archivos, en su propia pestaña'
            }
            onClick={() => {
              setIsolating(true);
              onIsolate(chat.jid)
                .catch((e: Error) => setError(e.message))
                .finally(() => setIsolating(false));
            }}
          >
            {isolating ? <Spinner className="size-4" /> : <FolderKanban className="size-4" />}
            <span className="hidden sm:inline">
              {isolated ? 'Ver proyecto' : 'Aislar como proyecto'}
            </span>
          </button>
        )}
      </header>

      <div
        ref={scroller}
        onDragOver={(e) => {
          if (!sendEnabled || !e.dataTransfer.types.includes('Files')) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          if (!sendEnabled) return;
          e.preventDefault();
          setDragging(false);
          const f = e.dataTransfer.files[0];
          if (f) setDropped(f);
        }}
        className={`relative min-h-0 flex-1 overflow-y-auto bg-[#efeae2] px-3 py-4 sm:px-8 ${
          dragging ? 'ring-4 ring-violeta-60 ring-inset' : ''
        }`}
        style={{
          backgroundImage:
            'radial-gradient(rgb(69 6 147 / 0.05) 1px, transparent 1px), radial-gradient(rgb(8 200 167 / 0.05) 1px, transparent 1px)',
          backgroundSize: '22px 22px',
          backgroundPosition: '0 0, 11px 11px',
        }}
      >
        {!data && !error && (
          <div className="grid h-full place-items-center text-violeta">
            <Spinner className="size-7" />
          </div>
        )}
        {error && <p className="text-center text-sm text-danger">{error}</p>}
        {data && (
          <div className="mx-auto flex max-w-3xl flex-col gap-1">
            <p className="mx-auto mb-3 rounded-lg bg-[#fff5c4] px-3 py-1.5 text-center text-xs text-[#54656f] shadow-sm">
              <Lock className="mr-1 inline size-3" />
              Últimos {data.messages.length} mensajes de este chat
            </p>
            {data.messages.map((m, i) => {
              const prev = data.messages[i - 1];
              const newDay = !prev || !isSameDay(prev.timestamp, m.timestamp);
              const sameAuthor =
                !newDay && prev && prev.fromMe === m.fromMe && prev.senderJid === m.senderJid;
              return (
                <div key={m.id}>
                  {newDay && (
                    <div className="my-3 flex justify-center">
                      <span className="rounded-lg bg-white px-3 py-1 text-xs font-semibold text-[#54656f] shadow-sm">
                        {fmtDayLabel(m.timestamp, now)}
                      </span>
                    </div>
                  )}
                  <Bubble
                    sessionId={sessionId}
                    chatJid={chat.jid}
                    message={m}
                    showSender={chat.isGroup && !m.fromMe && !sameAuthor}
                    tight={Boolean(sameAuthor)}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>

      {sendEnabled ? (
        <Composer sessionId={sessionId} chatJid={chat.jid} onSent={onSent} dropped={dropped} />
      ) : (
        <footer className="flex items-center gap-2 border-t border-line bg-[#f0f2f5] px-4 py-3 text-sm text-ink-soft">
          <Smile className="size-5 opacity-50" />
          <span className="flex-1 rounded-lg bg-white px-3 py-2 text-ink-soft/80">
            Solo lectura · el envío no está habilitado en este equipo
          </span>
        </footer>
      )}
    </>
  );
}

const SENDER_COLORS = [
  '#450693',
  '#039c7f',
  '#c2410c',
  '#be185d',
  '#1d4ed8',
  '#7c3aed',
  '#0f766e',
  '#b45309',
];
const colorFor = (key: string) => {
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return SENDER_COLORS[h % SENDER_COLORS.length];
};

function Bubble({
  sessionId,
  chatJid,
  message: m,
  showSender,
  tight,
}: {
  sessionId: string;
  chatJid: string;
  message: ChatMessage;
  showSender: boolean;
  tight: boolean;
}) {
  const visual = m.kind === 'image' || m.kind === 'video' || m.kind === 'gif';
  const sticker = m.kind === 'sticker';
  const sender = m.senderName ?? (m.senderPhone ? fmtPhone(m.senderPhone) : 'Participante');
  return (
    <div className={`flex ${m.fromMe ? 'justify-end' : 'justify-start'} ${tight ? '' : 'mt-1.5'}`}>
      <div
        className={`relative max-w-[85%] sm:max-w-[70%] ${
          sticker
            ? ''
            : `rounded-lg px-2 pt-1.5 pb-1 shadow-[0_1px_0.5px_rgb(11_20_26/0.13)] ${
                m.fromMe ? 'bg-[#d9fdd3]' : 'bg-white'
              }`
        } ${visual ? 'p-1' : ''}`}
      >
        {showSender && (
          <p
            className={`mb-0.5 truncate text-[13px] font-bold ${visual ? 'px-1' : ''}`}
            style={{ color: colorFor(m.senderJid ?? sender) }}
          >
            {sender}
            {m.senderName && m.senderPhone && (
              <span className="ml-2 font-normal text-ink-soft">{fmtPhone(m.senderPhone)}</span>
            )}
          </p>
        )}
        <Content sessionId={sessionId} chatJid={chatJid} m={m} />
        <span
          className={`float-right ml-2 mt-1 flex items-center gap-1 text-[11px] leading-none text-[#667781] ${
            visual ? 'px-1 pb-0.5' : ''
          } ${sticker ? 'rounded bg-white/80 px-1 py-0.5' : ''}`}
        >
          {m.edited && <span>Editado</span>}
          {fmtTime(m.timestamp)}
        </span>
      </div>
    </div>
  );
}

function Text({ children }: { children: string | null }) {
  if (!children) return null;
  return (
    <span className="text-[14.5px] leading-snug break-words whitespace-pre-wrap text-[#111b21]">
      {linkify(children)}
    </span>
  );
}

function Content({
  sessionId,
  chatJid,
  m,
}: {
  sessionId: string;
  chatJid: string;
  m: ChatMessage;
}) {
  switch (m.kind) {
    case 'text':
      return <Text>{m.text}</Text>;
    case 'image':
      return (
        <>
          <MediaView sessionId={sessionId} chatJid={chatJid} m={m} kind="image" />
          {m.text && (
            <div className="px-1 pt-1">
              <Text>{m.text}</Text>
            </div>
          )}
        </>
      );
    case 'video':
    case 'gif':
      return (
        <>
          <MediaView sessionId={sessionId} chatJid={chatJid} m={m} kind={m.kind} />
          {m.text && (
            <div className="px-1 pt-1">
              <Text>{m.text}</Text>
            </div>
          )}
        </>
      );
    case 'sticker':
      return <MediaView sessionId={sessionId} chatJid={chatJid} m={m} kind="sticker" />;
    case 'voice':
    case 'audio':
      return <AudioView sessionId={sessionId} chatJid={chatJid} m={m} />;
    case 'document':
      return <DocumentView sessionId={sessionId} chatJid={chatJid} m={m} />;
    case 'location':
      return (
        <a
          className="flex items-center gap-2 text-[14.5px] text-[#027eb5] hover:underline"
          href={
            m.location
              ? `https://maps.google.com/?q=${m.location.lat},${m.location.lng}`
              : undefined
          }
          target="_blank"
          rel="noreferrer"
        >
          <MapPin className="size-5 shrink-0 text-danger" />
          {m.text ?? 'Ubicación'}
        </a>
      );
    case 'contact':
      return (
        <span className="flex items-center gap-2 text-[14.5px]">
          <UserRound className="size-5 shrink-0 text-ink-soft" /> {m.text ?? 'Contacto'}
        </span>
      );
    case 'poll':
      return (
        <span className="flex gap-2">
          <BarChart3 className="mt-0.5 size-4 shrink-0 text-ink-soft" />
          <Text>{m.text}</Text>
        </span>
      );
    case 'deleted':
      return (
        <span className="flex items-center gap-1.5 text-[14px] text-[#667781] italic">
          <Ban className="size-4" /> Se eliminó este mensaje
        </span>
      );
    default:
      return (
        <span className="text-[14px] text-[#667781] italic">
          Mensaje no compatible (ábrelo en el teléfono)
        </span>
      );
  }
}

function useMedia(sessionId: string, chatJid: string, msgId: string) {
  const [state, setState] = useState<{ blob: MediaBlob | null; error: string | null }>({
    blob: null,
    error: null,
  });
  useEffect(() => {
    let alive = true;
    mediaBlob(sessionId, chatJid, msgId)
      .then((blob) => alive && setState({ blob, error: null }))
      .catch((e: Error) => alive && setState({ blob: null, error: e.message }));
    return () => {
      alive = false;
    };
  }, [sessionId, chatJid, msgId]);
  return state;
}

function MediaView({
  sessionId,
  chatJid,
  m,
  kind,
}: {
  sessionId: string;
  chatJid: string;
  m: ChatMessage;
  kind: 'image' | 'video' | 'gif' | 'sticker';
}) {
  const { blob, error } = useMedia(sessionId, chatJid, m.id);
  const w = m.media?.width ?? 0;
  const h = m.media?.height ?? 0;
  const ratio = w && h ? Math.min(Math.max(h / w, 0.4), 1.6) : 0.75;
  const box =
    kind === 'sticker'
      ? { width: 150, height: 150 }
      : { width: 'min(330px, 62vw)', aspectRatio: `${1 / ratio}` };

  if (error)
    return (
      <div
        style={box}
        className="grid place-items-center rounded-md bg-black/5 p-3 text-center text-xs text-ink-soft"
      >
        <span>
          <ImageOff className="mx-auto mb-1 size-6" />
          {kind === 'sticker' ? 'Sticker' : kind === 'image' ? 'Foto' : 'Video'} no disponible
        </span>
      </div>
    );
  if (!blob)
    return (
      <div style={box} className="grid place-items-center rounded-md bg-black/5 text-ink-soft">
        <Spinner className="size-6" />
      </div>
    );
  if (blob.thumbnail || kind === 'image' || kind === 'sticker')
    return (
      <a href={blob.url} target="_blank" rel="noreferrer" className="relative block">
        <img
          src={blob.url}
          alt=""
          style={box}
          className={`rounded-md object-cover ${kind === 'sticker' ? 'object-contain' : ''} ${blob.thumbnail ? 'blur-[1px]' : ''}`}
        />
        {blob.thumbnail && (
          <span className="absolute inset-x-0 bottom-2 mx-auto w-fit rounded-full bg-black/55 px-2 py-0.5 text-[11px] text-white">
            Vista previa · el original ya no está en WhatsApp
          </span>
        )}
      </a>
    );
  return (
    <video
      src={blob.url}
      style={box}
      className="rounded-md bg-black object-contain"
      controls={kind === 'video'}
      autoPlay={kind === 'gif'}
      loop={kind === 'gif'}
      muted={kind === 'gif'}
      playsInline
    />
  );
}

function AudioView({
  sessionId,
  chatJid,
  m,
}: {
  sessionId: string;
  chatJid: string;
  m: ChatMessage;
}) {
  const { blob, error } = useMedia(sessionId, chatJid, m.id);
  const voice = m.kind === 'voice';
  return (
    <div className="flex min-w-[240px] items-center gap-2 py-1">
      <span
        className={`grid size-10 shrink-0 place-items-center rounded-full ${
          voice ? 'bg-turquesa text-white' : 'bg-[#ff8f2c] text-white'
        }`}
      >
        {voice ? <Mic className="size-5" /> : <Headphones className="size-5" />}
      </span>
      {blob ? (
        <audio src={blob.url} controls preload="metadata" className="h-9 w-56 max-w-full" />
      ) : (
        <span className="text-xs text-ink-soft">
          {error ? 'Audio no disponible' : <Spinner className="size-4" />}{' '}
          {fmtDuration(m.media?.seconds)}
        </span>
      )}
    </div>
  );
}

function DocumentView({
  sessionId,
  chatJid,
  m,
}: {
  sessionId: string;
  chatJid: string;
  m: ChatMessage;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const name = m.media?.fileName ?? 'Documento';
  async function open() {
    setBusy(true);
    try {
      const { url } = await mediaBlob(sessionId, chatJid, m.id);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="min-w-[240px]">
      <button
        onClick={() => void open()}
        className="flex w-full items-center gap-3 rounded-md bg-black/5 px-3 py-2.5 text-left hover:bg-black/10"
      >
        <FileText className="size-8 shrink-0 text-violeta" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-bold">{name}</span>
          <span className="block text-xs text-ink-soft">
            {failed
              ? 'Ya no está disponible en WhatsApp'
              : [fmtBytes(m.media?.size), extOf(name)].filter(Boolean).join(' · ')}
          </span>
        </span>
        {busy ? <Spinner className="size-4" /> : <Download className="size-4 text-ink-soft" />}
      </button>
      {m.text && (
        <div className="px-1 pt-1">
          <Text>{m.text}</Text>
        </div>
      )}
    </div>
  );
}

// ----------------------------------------------------------------- utilidades

function KindIcon({ kind, className }: { kind: MessageKind; className?: string }) {
  switch (kind) {
    case 'image':
      return <Camera className={className} />;
    case 'video':
    case 'gif':
      return <Film className={className} />;
    case 'voice':
      return <Mic className={className} />;
    case 'audio':
      return <Headphones className={className} />;
    case 'document':
      return <FileText className={className} />;
    case 'location':
      return <MapPin className={className} />;
    case 'contact':
      return <UserRound className={className} />;
    case 'poll':
      return <BarChart3 className={className} />;
    case 'deleted':
      return <Ban className={className} />;
    case 'sticker':
      return <Smile className={className} />;
    default:
      return null;
  }
}

const KIND_LABEL: Record<MessageKind, string> = {
  text: '',
  image: 'Foto',
  video: 'Video',
  gif: 'GIF',
  audio: 'Audio',
  voice: 'Mensaje de voz',
  sticker: 'Sticker',
  document: 'Documento',
  location: 'Ubicación',
  contact: 'Contacto',
  poll: 'Encuesta',
  deleted: 'Se eliminó este mensaje',
  other: 'Mensaje',
};

function previewText(kind: MessageKind, text: string | null): string {
  if (kind === 'deleted') return KIND_LABEL.deleted;
  if (kind === 'poll') return text?.split('\n')[0] ?? KIND_LABEL.poll;
  return text?.replace(/\s+/g, ' ') || KIND_LABEL[kind] || '';
}

const extOf = (name: string) => /\.([a-z0-9]{1,5})$/i.exec(name)?.[1]?.toUpperCase() ?? '';

const normalize = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');

/** convierte las URLs del texto en links */
function linkify(text: string): ReactNode[] {
  const parts = text.split(/(https?:\/\/[^\s]+)/g);
  return parts.map((p, i) =>
    /^https?:\/\//.test(p) ? (
      <a
        key={i}
        href={p}
        target="_blank"
        rel="noreferrer"
        className="text-[#027eb5] hover:underline"
      >
        {p}
      </a>
    ) : (
      p
    ),
  );
}
