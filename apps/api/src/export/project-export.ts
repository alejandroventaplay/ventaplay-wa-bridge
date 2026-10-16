import ExcelJS from 'exceljs';
import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BufferJSON } from 'baileys';
import type { ArchivedMessage, ProjectInfo } from '@wa-bridge/shared';
import { e164, toLocalExcelDate } from './contacts-xlsx.js';

const TZ = 'America/Santiago';
const VIOLETA = 'FF450693';
const DATE_FMT = 'dd-mm-yyyy hh:mm:ss';

/** "Claudicación Melting Cook" → "claudicacion-melting-cook" */
export function projectSlug(name: string): string {
  return (
    name
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'proyecto'
  );
}

/** fecha y hora de Chile en texto ordenable: 2026-10-16 17:31:09 */
export function chileStamp(ms: number): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(ms));
}

const EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/heic': '.heic',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'audio/ogg': '.ogg',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'application/pdf': '.pdf',
};

/** nombre del archivo en la carpeta media/: fecha_id_nombre-original.ext */
export function mediaFileName(m: ArchivedMessage): string {
  const stamp = chileStamp(m.timestamp).replace(/[: ]/g, (c) => (c === ' ' ? '_' : ''));
  const mime = (m.media?.mimetype ?? '').split(';')[0]!.trim();
  const original = [...(m.media?.fileName ?? '').normalize('NFC')]
    .map((ch) => (ch.charCodeAt(0) < 32 || '/\\:*?"<>|'.includes(ch) ? '_' : ch))
    .join('')
    .trim()
    .slice(0, 80);
  const ext = /\.[a-z0-9]{1,5}$/i.test(original) ? '' : (EXT[mime] ?? '');
  return `${stamp}_${m.id}${original ? `_${original}` : ''}${ext}`;
}

/**
 * Escribe la carpeta del proyecto:
 *   proyecto.json   resumen + participantes
 *   mensajes.jsonl  un mensaje por línea con TODOS los datos y el original de WhatsApp
 *   mensajes.xlsx   lo mismo en tabla (Mensajes, Participantes, Resumen)
 *   media/          cada archivo bajado (solo se escribe si falta o cambió de tamaño)
 */
export async function writeProjectExport(
  dir: string,
  info: ProjectInfo,
  messages: ArchivedMessage[],
  readMedia: (id: string) => Promise<Buffer | null>,
): Promise<void> {
  await mkdir(join(dir, 'media'), { recursive: true, mode: 0o700 });

  const files = new Map<string, string>();
  for (const m of messages) {
    if (!m.media?.downloaded || m.deleted) continue;
    const name = mediaFileName(m);
    files.set(m.id, `media/${name}`);
    const path = join(dir, 'media', name);
    const have = await stat(path).catch(() => null);
    if (have && (!m.media.size || have.size === m.media.size)) continue;
    const buf = await readMedia(m.id);
    if (buf) await atomicWrite(path, buf);
  }

  const people = participants(messages);
  await atomicWrite(
    join(dir, 'proyecto.json'),
    JSON.stringify(
      { ...info, exportedAt: Date.now(), timeZone: TZ, participantsList: people },
      null,
      2,
    ),
  );

  const lines = messages.map((m) =>
    JSON.stringify(
      {
        ...m,
        timestampChile: chileStamp(m.timestamp),
        mediaFile: files.get(m.id) ?? null,
      },
      BufferJSON.replacer,
    ),
  );
  await atomicWrite(join(dir, 'mensajes.jsonl'), lines.join('\n') + (lines.length ? '\n' : ''));

  await atomicWrite(join(dir, 'mensajes.xlsx'), await workbook(info, messages, files, people));
}

interface Participant {
  key: string;
  name: string | null;
  phone: string | null;
  lid: string | null;
  messages: number;
  first: number;
  last: number;
}

function participants(messages: ArchivedMessage[]): Participant[] {
  const map = new Map<string, Participant>();
  for (const m of messages) {
    // el LID es estable; el número a veces viene y a veces no
    const key = m.fromMe ? 'yo' : (m.sender.lid ?? m.sender.jid ?? '?');
    const p = map.get(key) ?? {
      key,
      name: m.sender.name,
      phone: m.sender.phone,
      lid: m.sender.lid,
      messages: 0,
      first: m.timestamp,
      last: m.timestamp,
    };
    p.messages += 1;
    p.name = p.name ?? m.sender.name;
    p.phone = p.phone ?? m.sender.phone;
    p.lid = p.lid ?? m.sender.lid;
    p.first = Math.min(p.first, m.timestamp);
    p.last = Math.max(p.last, m.timestamp);
    map.set(key, p);
  }
  return [...map.values()].sort((a, b) => b.messages - a.messages);
}

const KIND_ES: Record<string, string> = {
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

async function workbook(
  info: ProjectInfo,
  messages: ArchivedMessage[],
  files: Map<string, string>,
  people: Participant[],
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'VentaPlay WA Bridge';

  const ws = wb.addWorksheet('Mensajes', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [
    { header: 'Fecha (Chile)', key: 'fecha', width: 19, style: { numFmt: DATE_FMT } },
    { header: 'Autor', key: 'autor', width: 22 },
    { header: 'Teléfono', key: 'telefono', width: 15 },
    { header: 'Tipo', key: 'tipo', width: 12 },
    { header: 'Texto / pie', key: 'texto', width: 60 },
    { header: 'Archivo', key: 'archivo', width: 30 },
    { header: 'MIME', key: 'mime', width: 18 },
    { header: 'Tamaño (bytes)', key: 'bytes', width: 13 },
    { header: 'Páginas', key: 'paginas', width: 8 },
    { header: 'Archivo bajado', key: 'ruta', width: 45 },
    { header: 'Verificado', key: 'verificado', width: 10 },
    { header: 'Responde a (id)', key: 'citaId', width: 24 },
    { header: 'Responde a (texto)', key: 'citaTexto', width: 40 },
    { header: 'Reenviado', key: 'reenviado', width: 10 },
    { header: 'Menciones', key: 'menciones', width: 24 },
    { header: 'Editado', key: 'editado', width: 9 },
    { header: 'Textos anteriores', key: 'anteriores', width: 40 },
    { header: 'Eliminado', key: 'eliminado', width: 19, style: { numFmt: DATE_FMT } },
    { header: 'Reacciones', key: 'reacciones', width: 24 },
    { header: 'Leído por', key: 'leido', width: 10 },
    { header: 'Tipo WhatsApp', key: 'tipoWa', width: 20 },
    { header: 'Origen', key: 'origen', width: 9 },
    { header: 'ID mensaje', key: 'id', width: 24 },
    { header: 'JID autor', key: 'jid', width: 28 },
    { header: 'LID autor', key: 'lid', width: 24 },
    { header: 'Nombre en WhatsApp', key: 'push', width: 20 },
    { header: 'Epoch (ms)', key: 'epoch', width: 15 },
  ];
  for (const m of messages)
    ws.addRow({
      fecha: toLocalExcelDate(m.timestamp),
      autor: m.fromMe ? `${m.sender.name ?? 'Yo'} (yo)` : m.sender.name,
      telefono: e164(m.sender.phone),
      tipo: KIND_ES[m.kind] ?? m.kind,
      texto: m.text,
      archivo: m.media?.fileName ?? null,
      mime: m.media?.mimetype ?? null,
      bytes: m.media?.size ?? null,
      paginas: m.media?.pageCount ?? null,
      ruta: files.get(m.id) ?? null,
      verificado: m.media ? (m.media.verified === null ? '' : m.media.verified ? 'sí' : 'NO') : '',
      citaId: m.quoted?.id ?? null,
      citaTexto: m.quoted?.text ?? null,
      reenviado: m.forwarded ? 'sí' : '',
      menciones: m.mentions.join(', ') || null,
      editado: m.edits.length && !m.deleted ? 'sí' : '',
      anteriores: m.edits.map((e) => e.previousText ?? '').join(' | ') || null,
      eliminado: m.deleted ? toLocalExcelDate(m.deleted.timestamp) : null,
      reacciones: m.reactions.map((r) => r.emoji).join(' ') || null,
      leido: m.receipts.filter((r) => r.read).length || null,
      tipoWa: m.type,
      origen: m.source,
      id: m.id,
      jid: m.sender.jid,
      lid: m.sender.lid,
      push: m.sender.pushName,
      epoch: m.timestamp,
    });
  styleHeader(ws);
  ws.autoFilter = { from: 'A1', to: { row: 1, column: ws.columns.length } };

  const wp = wb.addWorksheet('Participantes');
  wp.columns = [
    { header: 'Nombre', key: 'name', width: 26 },
    { header: 'Teléfono', key: 'phone', width: 16 },
    { header: 'LID', key: 'lid', width: 26 },
    { header: 'Mensajes', key: 'messages', width: 10 },
    { header: 'Primero', key: 'first', width: 19, style: { numFmt: DATE_FMT } },
    { header: 'Último', key: 'last', width: 19, style: { numFmt: DATE_FMT } },
  ];
  for (const p of people)
    wp.addRow({
      name: p.key === 'yo' ? `${p.name ?? 'Yo'} (yo)` : p.name,
      phone: e164(p.phone),
      lid: p.lid,
      messages: p.messages,
      first: toLocalExcelDate(p.first),
      last: toLocalExcelDate(p.last),
    });
  styleHeader(wp);

  const wr = wb.addWorksheet('Resumen');
  wr.columns = [
    { header: 'Dato', key: 'k', width: 28 },
    { header: 'Valor', key: 'v', width: 60 },
  ];
  const rows: [string, unknown][] = [
    ['Chat', info.name],
    ['JID', info.jid],
    ['Aislado desde', info.since ? chileStamp(info.since) : null],
    ['Mensajes', info.messages],
    ['Participantes', info.participants],
    ['Primer mensaje', info.first ? chileStamp(info.first) : null],
    ['Último mensaje', info.last ? chileStamp(info.last) : null],
    ['Archivos (bajados / total)', `${info.media.downloaded} / ${info.media.total}`],
    ...Object.entries(info.kinds).map(([k, n]) => [`· ${KIND_ES[k] ?? k}`, n] as [string, unknown]),
    ['Exportado', chileStamp(Date.now())],
  ];
  for (const [k, v] of rows) wr.addRow({ k, v });
  styleHeader(wr);

  return Buffer.from(await wb.xlsx.writeBuffer());
}

function styleHeader(ws: ExcelJS.Worksheet): void {
  const row = ws.getRow(1);
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: VIOLETA } };
  row.alignment = { vertical: 'middle' };
}

/** escribe a un temporal y renombra: nunca deja un archivo a medias */
async function atomicWrite(path: string, data: string | Buffer): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, data, { mode: 0o600 });
  await rename(tmp, path);
}
