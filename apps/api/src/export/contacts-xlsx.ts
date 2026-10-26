import ExcelJS from 'exceljs';
import type { SessionSummary } from '@wa-bridge/shared';
import { StatsAggregator, type Directory, type DirectoryPerson } from '../session/stats.js';

/** util = solo con nombre y celular (para el CRM) · completo = todo lo que llegó */
export type ContactsExportMode = 'util' | 'completo';

/** zona horaria en que mostramos las fechas del Excel */
const TZ = 'America/Santiago';
const VIOLETA = 'FF450693';
export const DATE_FMT = 'dd-mm-yyyy hh:mm';

/**
 * Excel guarda fechas "de reloj" sin zona horaria: convertimos el instante a la
 * hora de Chile y la escribimos como si fuera UTC para que se vea igual que en el teléfono.
 */
export function toLocalExcelDate(ms: number | null, timeZone = TZ): Date | null {
  if (!ms) return null;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(new Date(ms))
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, Number(p.value)]),
  ) as Record<'year' | 'month' | 'day' | 'hour' | 'minute' | 'second', number>;
  return new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second),
  );
}

/** +56912345678 (E.164, listo para importar) */
export const e164 = (phone: string | null) => (phone ? `+${phone}` : null);

/**
 * ID con que se unen el Excel de contactos y el de conversaciones (y la importación a
 * VentaPlay): el número sin "+" si lo conocemos; si no, el ID interno (LID).
 */
export const contactIdOf = (jid: string | null | undefined): string | null =>
  jid ? (jid.split('@')[0] ?? null) : null;
export const personId = (p: DirectoryPerson) => p.phone ?? contactIdOf(p.lid ?? p.jid);

const yesNo = (v: boolean | null) => (v === null ? null : v ? 'Sí' : 'No');

export function styleHeader(ws: ExcelJS.Worksheet): void {
  const header = ws.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: VIOLETA } };
  header.alignment = { vertical: 'middle' };
  header.height = 22;
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columnCount } };
}

export interface ContactsExportInput {
  session: SessionSummary;
  directory: Directory;
  mode?: ContactsExportMode;
  exportedAt?: number;
}

/** Arma el Excel de contactos: hojas Contactos, Grupos y Resumen. */
export async function buildContactsWorkbook(input: ContactsExportInput): Promise<Buffer> {
  const { session, directory } = input;
  const mode = input.mode ?? 'completo';
  const exportedAt = input.exportedAt ?? Date.now();
  const split = StatsAggregator.classify(directory);
  const people = mode === 'util' ? split.useful : directory.people;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'VentaPlay WA Bridge';
  wb.created = new Date(exportedAt);

  // ------------------------------------------------------------ Contactos
  const contacts = wb.addWorksheet('Contactos');
  contacts.columns = [
    { header: 'Nombre', key: 'name', width: 32 },
    { header: 'Teléfono', key: 'phone', width: 18 },
    { header: 'Nombre en la agenda', key: 'saved', width: 28 },
    { header: 'Nombre en WhatsApp', key: 'push', width: 24 },
    { header: 'Empresa (WhatsApp Business)', key: 'business', width: 28 },
    { header: 'Guardado en la agenda', key: 'inBook', width: 12 },
    { header: 'Mensajes', key: 'messages', width: 11 },
    { header: 'Primer mensaje', key: 'first', width: 17 },
    { header: 'Último mensaje', key: 'last', width: 17 },
    ...(mode === 'completo' ? [{ header: 'ID de WhatsApp', key: 'jid', width: 34 }] : []),
    { header: 'ID contacto', key: 'cid', width: 20 },
  ];
  for (const p of people) {
    contacts.addRow({
      name: p.displayName,
      phone: e164(p.phone),
      saved: p.savedName,
      push: p.pushName,
      business: p.businessName,
      inBook: yesNo(p.inAddressBook),
      messages: p.messages,
      first: toLocalExcelDate(p.firstMessageAt),
      last: toLocalExcelDate(p.lastMessageAt),
      jid: p.phone ? p.jid : (p.lid ?? p.jid),
      cid: personId(p),
    });
  }
  contacts.getColumn('phone').numFmt = '@';
  contacts.getColumn('cid').numFmt = '@';
  contacts.getColumn('first').numFmt = DATE_FMT;
  contacts.getColumn('last').numFmt = DATE_FMT;
  styleHeader(contacts);

  // ------------------------------------------------------------ Grupos (solo completo)
  const groups = mode === 'completo' ? wb.addWorksheet('Grupos') : null;
  if (groups) {
    groups.columns = [
      { header: 'Grupo', key: 'name', width: 36 },
      { header: 'Mensajes', key: 'messages', width: 11 },
      { header: 'Primer mensaje', key: 'first', width: 17 },
      { header: 'Último mensaje', key: 'last', width: 17 },
      { header: 'ID de WhatsApp', key: 'jid', width: 34 },
    ];
    for (const g of directory.groups) {
      groups.addRow({
        name: g.name,
        messages: g.messages,
        first: toLocalExcelDate(g.firstMessageAt),
        last: toLocalExcelDate(g.lastMessageAt),
        jid: g.jid,
      });
    }
    groups.getColumn('first').numFmt = DATE_FMT;
    groups.getColumn('last').numFmt = DATE_FMT;
    styleHeader(groups);
  }

  // ------------------------------------------------------------ Resumen
  const summary = wb.addWorksheet('Resumen');
  summary.columns = [
    { header: 'Dato', key: 'k', width: 30 },
    { header: 'Valor', key: 'v', width: 40 },
  ];
  const rows: [string, string | number | Date | null][] = [
    ['WhatsApp', session.label ?? session.profile?.name ?? null],
    ['Número', e164(session.profile?.phone ?? null)],
    ['Nombre del perfil', session.profile?.name ?? null],
    ['Exportado', toLocalExcelDate(exportedAt)],
    ['Tipo de descarga', mode === 'util' ? 'Útil para el CRM (con nombre y celular)' : 'Completa'],
    ['Contactos en este archivo', people.length],
    ['Contactos con nombre y celular', split.useful.length],
    ['Sin número (solo ID interno de WhatsApp)', split.noPhone],
    ['Con número pero sin nombre', split.noName],
    ['Contactos en total', split.total],
    ['Grupos', split.groups],
    ['Mensajes en el historial', session.stats.messages],
    ['Mensaje más antiguo', toLocalExcelDate(session.stats.oldestMessageAt)],
    ['Mensaje más reciente', toLocalExcelDate(session.stats.newestMessageAt)],
    ['Fuente', 'VentaPlay WA Bridge · solo lectura, sin contenido de mensajes'],
  ];
  for (const [k, v] of rows) {
    const row = summary.addRow({ k, v });
    if (v instanceof Date) row.getCell('v').numFmt = DATE_FMT;
  }
  summary.getColumn('v').alignment = { horizontal: 'left' };
  styleHeader(summary);

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out as ArrayBuffer);
}

/** contactos-barberia-don-pepe-2026-10-07.xlsx */
export function contactsFileName(
  session: SessionSummary,
  exportedAt = Date.now(),
  mode: ContactsExportMode = 'completo',
): string {
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
  return `contactos-${mode === 'util' ? 'util-' : ''}${slug}-${d}.xlsx`;
}
