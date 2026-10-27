import { PassThrough } from 'node:stream';
import ExcelJS from 'exceljs';
import type { SessionSummary } from '@wa-bridge/shared';
import type { StoredMessage } from '../session/message-vault.js';
import { isGroupJid, phoneOf, type Directory } from '../session/stats.js';
import { contactIdOf, DATE_FMT, e164, personId, toLocalExcelDate } from './contacts-xlsx.js';

/**
 * Excel de conversaciones (modo migración). Funciona como una base de datos liviana:
 * Chats (una fila por chat) y Mensajes (una por mensaje) se unen por "ID chat", y con el
 * Excel de contactos por "ID contacto" (el número sin "+", o el ID interno si WhatsApp no
 * dio el número). Los mensajes no repiten nombre ni número. Los archivos no van: solo su
 * tipo y nombre.
 */
export interface ConversationsExportInput {
  session: SessionSummary;
  directory: Directory;
  chats: { jid: string; messages: StoredMessage[] }[];
  exportedAt?: number;
}

const VIOLETA = 'FF450693';
/** Excel no acepta más de 32.767 caracteres por celda */
const MAX_CELL = 32_000;

const KIND: Record<StoredMessage['kind'], string> = {
  text: 'texto',
  image: 'imagen',
  gif: 'gif',
  video: 'video',
  audio: 'audio',
  voice: 'nota de voz',
  sticker: 'sticker',
  document: 'documento',
  location: 'ubicación',
  contact: 'contacto',
  poll: 'encuesta',
  deleted: 'borrado',
  other: 'otro',
};

function header(ws: ExcelJS.Worksheet, columns: Partial<ExcelJS.Column>[]): void {
  ws.columns = columns;
  const row = ws.getRow(1);
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: VIOLETA } };
  row.height = 22;
  row.commit();
}

/** autor de un mensaje como ID contacto */
function authorId(m: StoredMessage, chatJid: string, sessionPhone: string | null): string | null {
  if (m.fromMe) return sessionPhone;
  if (!isGroupJid(chatJid)) return contactIdOf(chatJid);
  return phoneOf(m.sender) ?? phoneOf(m.senderAlt) ?? contactIdOf(m.sender);
}

export async function buildConversationsWorkbook(input: ConversationsExportInput): Promise<Buffer> {
  const { session, directory, chats } = input;
  const exportedAt = input.exportedAt ?? Date.now();
  const sessionPhone = session.profile?.phone?.replace(/\D/g, '') || null;
  const people = new Map(directory.people.map((p) => [p.jid, p]));
  const groups = new Map(directory.groups.map((g) => [g.jid, g]));

  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve, reject) => {
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream, useStyles: true });
  wb.creator = 'VentaPlay WA Bridge';
  wb.created = new Date(exportedAt);
  const frozen = { views: [{ state: 'frozen' as const, ySplit: 1 }] };

  // ------------------------------------------------------------ Chats
  const ws = wb.addWorksheet('Chats', frozen);
  header(ws, [
    { header: 'ID chat', key: 'id', width: 24 },
    { header: 'ID contacto', key: 'cid', width: 18 },
    { header: 'Tipo', key: 'tipo', width: 10 },
    { header: 'Nombre', key: 'name', width: 32 },
    { header: 'Teléfono', key: 'phone', width: 18 },
    { header: 'Mensajes', key: 'n', width: 11 },
    { header: 'Primer mensaje', key: 'first', width: 17 },
    { header: 'Último mensaje', key: 'last', width: 17 },
  ]);
  let total = 0;
  for (const c of chats) {
    const group = isGroupJid(c.jid);
    const p = group ? null : people.get(c.jid);
    total += c.messages.length;
    const row = ws.addRow({
      id: contactIdOf(c.jid),
      cid: group ? null : p ? personId(p) : contactIdOf(c.jid),
      tipo: group ? 'grupo' : 'persona',
      name: group ? (groups.get(c.jid)?.name ?? null) : (p?.displayName ?? p?.pushName ?? null),
      phone: group ? null : e164(phoneOf(c.jid)),
      n: c.messages.length,
      first: toLocalExcelDate(c.messages[0]?.ts ?? null),
      last: toLocalExcelDate(c.messages.at(-1)?.ts ?? null),
    });
    row.getCell('first').numFmt = DATE_FMT;
    row.getCell('last').numFmt = DATE_FMT;
    row.commit();
  }
  ws.commit();

  // ------------------------------------------------------------ Mensajes
  const wm = wb.addWorksheet('Mensajes', frozen);
  header(wm, [
    { header: 'ID mensaje', key: 'id', width: 26 },
    { header: 'ID chat', key: 'chat', width: 24 },
    { header: 'Fecha', key: 'fecha', width: 17 },
    { header: 'De', key: 'de', width: 12 },
    { header: 'Autor (ID contacto)', key: 'autor', width: 18 },
    { header: 'Tipo', key: 'tipo', width: 12 },
    { header: 'Texto', key: 'texto', width: 70 },
    { header: 'Archivo', key: 'archivo', width: 28 },
    { header: 'Editado', key: 'editado', width: 9 },
  ]);
  for (const c of chats) {
    const chatId = contactIdOf(c.jid);
    const group = isGroupJid(c.jid);
    for (const m of c.messages) {
      const row = wm.addRow({
        id: m.id,
        chat: chatId,
        fecha: toLocalExcelDate(m.ts),
        de: m.fromMe ? 'yo' : group ? 'participante' : 'contacto',
        autor: authorId(m, c.jid, sessionPhone),
        tipo: KIND[m.kind],
        texto: m.text ? m.text.slice(0, MAX_CELL) : null,
        archivo: m.media ? (m.media.fileName ?? m.media.mimetype ?? null) : null,
        editado: m.edited ? 'Sí' : null,
      });
      row.getCell('fecha').numFmt = DATE_FMT;
      row.commit();
    }
  }
  wm.commit();

  // ------------------------------------------------------------ Resumen
  const wr = wb.addWorksheet('Resumen');
  header(wr, [
    { header: 'Dato', key: 'k', width: 34 },
    { header: 'Valor', key: 'v', width: 44 },
  ]);
  const rows: [string, string | number | Date | null][] = [
    ['WhatsApp', session.label ?? session.profile?.name ?? null],
    ['Número', e164(sessionPhone)],
    ['Exportado', toLocalExcelDate(exportedAt)],
    ['Chats', chats.length],
    ['Chats de personas', chats.filter((c) => !isGroupJid(c.jid)).length],
    ['Grupos', chats.filter((c) => isGroupJid(c.jid)).length],
    ['Mensajes', total],
    [
      'Cómo se unen',
      'Mensajes.ID chat = Chats.ID chat · Chats.ID contacto = Contactos.ID contacto',
    ],
    ['Archivos', 'No incluidos: solo tipo y nombre'],
    ['Fuente', 'VentaPlay WA Bridge · modo migración'],
  ];
  for (const [k, v] of rows) {
    const row = wr.addRow({ k, v });
    if (v instanceof Date) row.getCell('v').numFmt = DATE_FMT;
    row.commit();
  }
  wr.commit();

  await wb.commit();
  await done;
  return Buffer.concat(chunks);
}

/** conversaciones-taller-demo-2026-10-26.xlsx */
export function conversationsFileName(session: SessionSummary, exportedAt = Date.now()): string {
  const base = session.label ?? session.profile?.name ?? session.profile?.phone ?? 'whatsapp';
  const slug =
    base
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'whatsapp';
  const d = toLocalExcelDate(exportedAt)!.toISOString().slice(0, 10);
  return `conversaciones-${slug}-${d}.xlsx`;
}
