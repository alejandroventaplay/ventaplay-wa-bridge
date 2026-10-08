import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { emptyStats, type SessionSummary } from '@wa-bridge/shared';
import {
  buildContactsWorkbook,
  contactsFileName,
  e164,
  toLocalExcelDate,
} from '../src/export/contacts-xlsx.js';
import { StatsAggregator } from '../src/session/stats.js';
import { buildFakeHistory } from '../src/wa/simulator.js';

const PN = '56911112222@s.whatsapp.net';
const LID = '123456789012345@lid';

function sample(): StatsAggregator {
  const s = new StatsAggregator();
  s.addHistoryBatch({
    contacts: [
      { id: PN, lid: LID, phoneNumber: PN, name: 'Pepe Barbería', notify: 'Pepe' },
      { id: '56933334444@s.whatsapp.net', notify: 'Ana', verifiedName: 'Ana Spa' },
    ],
    chats: [
      { id: LID, conversationTimestamp: 1_760_000_000 },
      { id: '120363000000000001@g.us', name: 'Clientes VIP' },
    ],
    messages: [
      {
        key: { id: 'a', remoteJid: LID },
        message: { conversation: 'x' },
        messageTimestamp: 1_750_000_000,
      },
      {
        key: { id: 'b', remoteJid: LID },
        message: { conversation: 'x' },
        messageTimestamp: 1_760_000_000,
      },
      {
        key: { id: 'c', remoteJid: '120363000000000001@g.us', participant: PN },
        message: { conversation: 'x' },
        messageTimestamp: 1_755_000_000,
      },
    ],
  });
  return s;
}

function summaryOf(s: StatsAggregator): SessionSummary {
  return {
    id: 'x',
    label: 'Barbería Don Pepe',
    status: 'connected',
    createdAt: 0,
    updatedAt: 0,
    connectedAt: 0,
    qr: null,
    profile: {
      jid: '56900000000@s.whatsapp.net',
      phone: '56900000000',
      name: 'Don Pepe',
      isBusiness: true,
    },
    stats: s.summary(),
    lastError: null,
    readOnly: true,
  };
}

describe('agenda para exportar', () => {
  it('unifica LID y número y separa los nombres por origen', () => {
    const { people, groups } = sample().directory();
    const pepe = people.find((p) => p.phone === '56911112222')!;
    expect(pepe).toMatchObject({
      displayName: 'Pepe Barbería',
      savedName: 'Pepe Barbería',
      pushName: 'Pepe',
      lid: LID,
      inAddressBook: true,
      messages: 2,
      firstMessageAt: 1_750_000_000_000,
      lastMessageAt: 1_760_000_000_000,
    });
    const ana = people.find((p) => p.phone === '56933334444')!;
    expect(ana).toMatchObject({
      displayName: 'Ana',
      savedName: null,
      businessName: 'Ana Spa',
      inAddressBook: false,
      messages: 0,
    });
    expect(people).toHaveLength(2);
    expect(groups).toEqual([expect.objectContaining({ name: 'Clientes VIP', messages: 1 })]);
  });

  it('con un snapshot viejo (sin detalle) exporta igual y no inventa si está en la agenda', () => {
    const snap = sample().snapshot();
    delete snap.contactInfo;
    delete snap.contactInfoComplete;
    const restored = new StatsAggregator(snap);
    restored.addContacts([{ id: '56955556666@s.whatsapp.net', notify: 'Luis' }]);
    const again = new StatsAggregator(restored.snapshot());
    const { people } = again.directory();
    const pepe = people.find((p) => p.phone === '56911112222')!;
    expect(pepe.displayName).toBe('Pepe Barbería');
    expect(pepe.inAddressBook).toBeNull();
    expect(people.find((p) => p.phone === '56955556666')!.inAddressBook).toBeNull();
  });

  it('el snapshot conserva el detalle por contacto', () => {
    const again = new StatsAggregator(sample().snapshot());
    expect(again.directory().people.find((p) => p.phone === '56911112222')!.inAddressBook).toBe(
      true,
    );
  });
});

describe('Excel de contactos', () => {
  it('trae hojas Contactos, Grupos y Resumen con teléfonos en formato +56', async () => {
    const s = new StatsAggregator();
    for (const b of buildFakeHistory()) s.addHistoryBatch(b);
    const dir = s.directory();
    const buf = await buildContactsWorkbook({ session: summaryOf(s), directory: dir });

    const wb = new ExcelJS.Workbook();
    // los tipos de exceljs usan el Buffer de una versión vieja de @types/node
    await wb.xlsx.load(buf as never);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Contactos', 'Grupos', 'Resumen']);

    const ws = wb.getWorksheet('Contactos')!;
    expect(ws.getRow(1).getCell(1).value).toBe('Nombre');
    expect(ws.getRow(1).getCell(2).value).toBe('Teléfono');
    expect(ws.rowCount - 1).toBe(dir.people.length);
    expect(dir.people.length).toBe(48);
    for (let r = 2; r <= ws.rowCount; r++) {
      expect(String(ws.getRow(r).getCell(2).value)).toMatch(/^\+569\d{8}$/);
      expect(ws.getRow(r).getCell(1).value).toBeTruthy();
    }
    // nadie sale sin nombre y los que no están guardados igual tienen su nombre de WhatsApp
    expect(dir.people.some((p) => p.inAddressBook === false && p.pushName)).toBe(true);
    expect(wb.getWorksheet('Grupos')!.rowCount - 1).toBe(dir.groups.length);
  });

  it('muestra las fechas en hora de Chile', () => {
    // 15 ene 2026 12:00 UTC = 09:00 en Santiago (horario de verano, UTC-3)
    expect(toLocalExcelDate(Date.UTC(2026, 0, 15, 12, 0, 0))!.toISOString()).toBe(
      '2026-01-15T09:00:00.000Z',
    );
    expect(toLocalExcelDate(null)).toBeNull();
    expect(e164('56911112222')).toBe('+56911112222');
  });

  it('arma un nombre de archivo limpio', () => {
    const s = summaryOf(new StatsAggregator());
    expect(contactsFileName(s, Date.UTC(2026, 9, 7, 15))).toBe(
      'contactos-barberia-don-pepe-2026-10-07.xlsx',
    );
    expect(contactsFileName({ ...s, label: null, profile: null, stats: emptyStats() })).toMatch(
      /^contactos-whatsapp-\d{4}-\d{2}-\d{2}\.xlsx$/,
    );
  });
});
