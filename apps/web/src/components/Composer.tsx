import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { FileText, Film, Headphones, Paperclip, SendHorizontal, X } from 'lucide-react';
import type { ChatMessage } from '@wa-bridge/shared';
import { api, MAX_SEND_BYTES } from '../lib/api';
import { fmtBytes } from '../lib/format';
import { Spinner } from './ui';

/** tipos que WhatsApp muestra en línea; el resto se manda como documento */
const INLINE = /^(image\/(jpeg|png)|video\/(mp4|3gpp)|audio\/(ogg|mpeg|mp4|aac|amr|x-m4a|mp3).*)$/;

/**
 * Caja para escribir en Mi vista: texto, fotos y archivos desde tu número.
 * Enter envía, Shift+Enter hace un salto de línea. Pegar una imagen la adjunta.
 */
export function Composer({
  sessionId,
  chatJid,
  onSent,
  dropped,
}: {
  sessionId: string;
  chatJid: string;
  onSent: (m: ChatMessage) => void;
  /** archivo soltado sobre la conversación */
  dropped: File | null;
}) {
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [asDocument, setAsDocument] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [left, setLeft] = useState<number | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (dropped) attach(dropped);
  }, [dropped]);

  // la caja crece con el texto (hasta ~6 líneas)
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 150)}px`;
  }, [text]);

  function attach(f: File) {
    setError(null);
    if (f.size > MAX_SEND_BYTES) {
      setError(`"${f.name}" pesa ${fmtBytes(f.size)}; el máximo es 16 MB`);
      return;
    }
    setFile(f);
    setAsDocument(false);
    box.current?.focus();
  }

  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const f = [...e.clipboardData.files][0];
    if (f) {
      e.preventDefault();
      attach(f);
    }
  }

  async function send() {
    const body = text.trim();
    if (busy || (!body && !file)) return;
    setBusy(true);
    setError(null);
    try {
      const r = file
        ? await api.sendFile(sessionId, chatJid, file, { caption: body, asDocument })
        : await api.sendText(sessionId, chatJid, body);
      onSent(r.message);
      setText('');
      setFile(null);
      setLeft(r.remaining.day);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      box.current?.focus();
    }
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  }

  const canSend = !busy && (Boolean(text.trim()) || Boolean(file));

  return (
    <footer className="border-t border-line bg-[#f0f2f5] px-3 py-2.5 sm:px-4">
      {file && (
        <Attachment
          key={`${file.name}|${file.size}|${file.lastModified}`}
          file={file}
          asDocument={asDocument}
          onToggle={() => setAsDocument((v) => !v)}
          onRemove={() => setFile(null)}
          disabled={busy}
        />
      )}
      {error && (
        <p role="alert" className="mb-2 rounded-lg bg-red-50 px-3 py-1.5 text-xs text-danger">
          {error}
        </p>
      )}
      <div className="flex items-end gap-2">
        <button
          type="button"
          className="grid size-10 shrink-0 place-items-center rounded-full text-ink-soft transition hover:bg-black/5 hover:text-ink disabled:opacity-50"
          onClick={() => picker.current?.click()}
          disabled={busy}
          aria-label="Adjuntar foto o archivo"
          title="Adjuntar foto o archivo (máx. 16 MB)"
        >
          <Paperclip className="size-5" />
        </button>
        <input
          ref={picker}
          type="file"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) attach(f);
            e.target.value = '';
          }}
        />
        <textarea
          ref={box}
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          onPaste={onPaste}
          maxLength={file ? 1024 : 4096}
          placeholder={file ? 'Agrega un comentario (opcional)' : 'Escribe un mensaje'}
          aria-label="Mensaje"
          className="max-h-[150px] min-h-10 flex-1 resize-none rounded-lg bg-white px-3 py-2.5 text-[14.5px] leading-snug text-[#111b21] outline-none placeholder:text-ink-soft/70 focus:ring-2 focus:ring-violeta-10"
        />
        <button
          type="button"
          onClick={() => void send()}
          disabled={!canSend}
          aria-label="Enviar"
          className="grid size-10 shrink-0 place-items-center rounded-full bg-violeta text-white transition hover:bg-violeta-80 active:scale-95 disabled:bg-violeta/40"
        >
          {busy ? <Spinner className="size-5" /> : <SendHorizontal className="size-5" />}
        </button>
      </div>
      {left !== null && left <= 20 && (
        <p className="mt-1.5 text-center text-[11px] text-ink-soft">
          Te quedan {left} envíos hoy (límite para cuidar tu número)
        </p>
      )}
    </footer>
  );
}

function Attachment({
  file,
  asDocument,
  onToggle,
  onRemove,
  disabled,
}: {
  file: File;
  asDocument: boolean;
  onToggle: () => void;
  onRemove: () => void;
  disabled: boolean;
}) {
  const isImage = file.type.startsWith('image/');
  const inline = INLINE.test(file.type);
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => {
    if (!isImage) return;
    const r = new FileReader();
    r.onload = () => setPreview(String(r.result));
    r.readAsDataURL(file);
    return () => r.abort();
  }, [file, isImage]);

  const Icon = file.type.startsWith('video/')
    ? Film
    : file.type.startsWith('audio/')
      ? Headphones
      : FileText;

  return (
    <div className="mb-2 flex items-center gap-3 rounded-lg bg-white p-2 shadow-sm">
      {preview ? (
        <img src={preview} alt="" className="size-14 shrink-0 rounded-md object-cover" />
      ) : (
        <span className="grid size-14 shrink-0 place-items-center rounded-md bg-violeta-5 text-violeta">
          <Icon className="size-7" />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-bold">{file.name}</p>
        <p className="text-xs text-ink-soft">
          {fmtBytes(file.size)} ·{' '}
          {inline && !asDocument ? kindLabel(file.type) : 'se envía como documento'}
        </p>
        {inline && (
          <label className="mt-1 inline-flex cursor-pointer items-center gap-1.5 text-xs text-ink-soft">
            <input
              type="checkbox"
              checked={asDocument}
              onChange={onToggle}
              disabled={disabled}
              className="accent-violeta"
            />
            Enviar como documento (sin comprimir)
          </label>
        )}
      </div>
      <button
        type="button"
        onClick={onRemove}
        disabled={disabled}
        aria-label="Quitar archivo"
        className="grid size-8 shrink-0 place-items-center rounded-full text-ink-soft hover:bg-black/5 hover:text-ink"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}

function kindLabel(type: string): string {
  if (type.startsWith('image/')) return 'foto';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  return 'archivo';
}
