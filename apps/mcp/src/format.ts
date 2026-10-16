import type { ChatMessage, MessageKind, PersonalChat } from '@wa-bridge/shared';

const TZ = 'America/Santiago';
const dt = new Intl.DateTimeFormat('es-CL', {
  timeZone: TZ,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** 16-10-2026 18:42 (hora de Chile) */
export const when = (ms: number) => dt.format(new Date(ms)).replace(',', '');

export function phone(p: string | null | undefined): string {
  if (!p) return '';
  if (p.length === 11 && p.startsWith('569')) return `+56 9 ${p.slice(3, 7)} ${p.slice(7)}`;
  return `+${p}`;
}

const LABEL: Record<MessageKind, string> = {
  text: '',
  image: '📷 Foto',
  video: '🎥 Video',
  gif: 'GIF',
  audio: '🎵 Audio',
  voice: '🎤 Nota de voz',
  sticker: 'Sticker',
  document: '📄 Documento',
  location: '📍 Ubicación',
  contact: '👤 Contacto',
  poll: '📊 Encuesta',
  deleted: '(mensaje eliminado)',
  other: '(mensaje no compatible)',
};

/** el contenido de un mensaje en una línea legible */
export function body(m: Pick<ChatMessage, 'kind' | 'text' | 'media'>): string {
  if (m.kind === 'text') return m.text ?? '';
  const parts = [LABEL[m.kind]];
  if (m.kind === 'voice' || m.kind === 'audio' || m.kind === 'video') {
    const s = m.media?.seconds;
    if (s) parts[0] += ` ${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  }
  if (m.kind === 'document' && m.media?.fileName) parts.push(m.media.fileName);
  if (m.text) parts.push(m.text);
  return parts.filter(Boolean).join(' · ');
}

export function author(m: ChatMessage, isGroup: boolean, chatName: string): string {
  if (m.fromMe) return 'Tú';
  if (!isGroup) return chatName;
  return m.senderName ?? (m.senderPhone ? phone(m.senderPhone) : 'Alguien');
}

/** encabezado de un chat: nombre, número/grupo y jid (para usar en otras herramientas) */
export function chatTitle(c: Pick<PersonalChat, 'name' | 'phone' | 'isGroup' | 'jid'>): string {
  const extra = c.isGroup ? 'grupo' : phone(c.phone) || 'sin número visible';
  return `${c.name} (${extra}) — jid: ${c.jid}`;
}

export function transcript(c: PersonalChat, messages: ChatMessage[]): string {
  return messages
    .map(
      (m) =>
        `[${when(m.timestamp)}] ${author(m, c.isGroup, c.name)}: ${body(m)}${m.edited ? ' (editado)' : ''}`,
    )
    .join('\n');
}

/** una fila de la lista de chats */
export function chatLine(c: PersonalChat): string {
  const who = c.previewFromMe ? 'Tú' : c.isGroup ? (c.previewSender ?? 'Alguien') : c.name;
  const preview = body({ kind: c.previewKind, text: c.preview, media: null }).replace(/\s+/g, ' ');
  const pending = !c.previewFromMe && !c.isGroup ? ' ⏳ sin responder' : '';
  return `- ${chatTitle(c)}\n  último: ${when(c.lastMessageAt)} · ${who}: ${preview.slice(0, 140)}${pending}`;
}
