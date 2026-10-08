import { describe, expect, it } from 'vitest';
import { normalizeJid, StatsAggregator, toMs } from '../src/session/stats.js';
import { buildFakeHistory } from '../src/wa/simulator.js';

const PN = '56911111111@s.whatsapp.net';
const LID = '123456789@lid';
const GROUP = '120363025000000@g.us';

describe('helpers', () => {
  it('normaliza jids con dispositivo', () => {
    expect(normalizeJid('56911111111:12@s.whatsapp.net')).toBe(PN);
    expect(normalizeJid('56911111111@c.us')).toBe(PN);
  });
  it('convierte timestamps de segundos a ms', () => {
    expect(toMs(1700000000)).toBe(1700000000000);
    expect(toMs({ toNumber: () => 1700000000 })).toBe(1700000000000);
    expect(toMs(null)).toBeNull();
  });
});

describe('StatsAggregator', () => {
  it('cuenta chats, grupos y mensajes, deduplicando', () => {
    const s = new StatsAggregator();
    const msg = (jid: string, id: string, ts: number) => ({
      key: { remoteJid: jid, id },
      message: { conversation: 'x' },
      messageTimestamp: ts,
    });
    s.addHistoryBatch({
      chats: [{ id: PN, name: 'Ana' }, { id: GROUP, name: 'Equipo' }, { id: 'status@broadcast' }],
      contacts: [{ id: PN, name: 'Ana' }],
      messages: [
        msg(PN, '1', 1000),
        msg(PN, '2', 2000),
        msg(GROUP, '3', 1500),
        msg(PN, '1', 1000),
        msg('status@broadcast', '9', 1),
      ],
      progress: 40,
      syncType: 0,
    });
    const r = s.summary();
    expect(r).toMatchObject({
      chats: 2,
      individualChats: 1,
      groups: 1,
      messages: 3,
      contacts: 1,
      progress: 40,
      state: 'running',
      batches: 1,
    });
    expect(r.oldestMessageAt).toBe(1000 * 1000);
    expect(r.newestMessageAt).toBe(2000 * 1000);
    expect(r.topChats[0]).toMatchObject({
      jid: PN,
      name: 'Ana',
      phone: '56911111111',
      messages: 2,
    });
  });

  it('ignora mensajes de protocolo', () => {
    const s = new StatsAggregator();
    s.addMessages([
      { key: { remoteJid: PN, id: 'p' }, message: { protocolMessage: {} }, messageTimestamp: 5 },
    ]);
    expect(s.summary().messages).toBe(0);
  });

  it('fusiona un chat por LID con su número cuando llega el mapeo', () => {
    const s = new StatsAggregator();
    s.addMessages([
      { key: { remoteJid: LID, id: 'a' }, message: { conversation: 'x' }, messageTimestamp: 10 },
    ]);
    s.addMessages([
      { key: { remoteJid: PN, id: 'b' }, message: { conversation: 'x' }, messageTimestamp: 11 },
    ]);
    expect(s.summary().chats).toBe(2);
    s.addLidMapping({ lid: LID, pn: PN });
    const r = s.summary();
    expect(r.chats).toBe(1);
    expect(r.topChats[0]).toMatchObject({ jid: PN, messages: 2 });
  });

  it('aprende el mapeo desde remoteJidAlt', () => {
    const s = new StatsAggregator();
    s.addMessages([
      {
        key: { remoteJid: LID, remoteJidAlt: PN, id: 'a' },
        message: { conversation: 'x' },
        messageTimestamp: 10,
      },
    ]);
    expect(s.summary().topChats[0]?.phone).toBe('56911111111');
  });

  it('marca completo cuando WhatsApp confirma cada tipo de sync, o por inactividad', () => {
    const a = new StatsAggregator();
    a.addHistoryBatch({ chats: [], contacts: [], messages: [], syncType: 0 }, 1000);
    a.addHistoryBatch({ chats: [], contacts: [], messages: [], syncType: 2 }, 1000);
    a.markSyncStatus(0, 'complete');
    expect(a.summary().state).toBe('running');
    a.markSyncStatus(2, 'complete');
    expect(a.summary()).toMatchObject({
      state: 'complete',
      progress: 100,
      completionInferred: false,
    });

    // sin historial completo a la vista: pausa y, si sigue sin llegar nada, se da por terminado
    const b = new StatsAggregator();
    b.addHistoryBatch({ chats: [], contacts: [], messages: [] }, 1000);
    const idle = { pauseMs: 120_000, giveUpMs: 900_000 };
    expect(b.checkIdle(idle, 50_000)).toBe(false);
    expect(b.checkIdle(idle, 200_000)).toBe(true);
    expect(b.summary().state).toBe('paused');
    expect(b.checkIdle(idle, 1_000_000)).toBe(true);
    expect(b.summary()).toMatchObject({ state: 'complete', completionInferred: true });
  });

  it('como en un teléfono real: RECENT llega rápido, FULL por partes con pausas largas', () => {
    const a = new StatsAggregator();
    const idle = { pauseMs: 120_000, giveUpMs: 900_000 };
    const lote = (syncType: number, progress: number | null, t: number) =>
      a.addHistoryBatch({ chats: [], contacts: [], messages: [], syncType, progress }, t);
    lote(5, null, 0);
    lote(0, 100, 1_000);
    lote(1, null, 2_000);
    lote(4, null, 3_000);
    expect(a.summary().state).toBe('complete'); // por ahora no hay más que esperar
    lote(3, 3, 400_000);
    expect(a.summary()).toMatchObject({ state: 'running', progress: 3, recentProgress: 3 });
    lote(3, 100, 410_000);
    lote(2, 2, 420_000);
    lote(2, 79, 430_000);
    expect(a.summary()).toMatchObject({
      state: 'running',
      progress: 79,
      recentProgress: 100,
      fullProgress: 79,
    });
    // 12 minutos sin lotes: en pausa, nunca "completo" mientras FULL no llegue a 100
    expect(a.checkIdle(idle, 430_000 + 720_000)).toBe(true);
    expect(a.summary().state).toBe('paused');
    expect(a.checkIdle(idle, 430_000 + 5_000_000)).toBe(false);
    expect(a.summary().state).toBe('paused');
    lote(2, 92, 6_000_000);
    expect(a.summary().state).toBe('running');
    lote(2, 100, 6_010_000);
    expect(a.summary()).toMatchObject({
      state: 'complete',
      progress: 100,
      completionInferred: false,
    });
  });

  it('termina al llegar FULL a 100 aunque tipos de un lote quedaran pendientes en un snapshot viejo', () => {
    const a = new StatsAggregator();
    a.addHistoryBatch({ chats: [], contacts: [], messages: [], syncType: 2, progress: 98 }, 1);
    const snap = a.snapshot();
    snap.syncTypes = { '5': false, '1': false, '4': false, '0': true, '3': true, '2': false };
    const b = new StatsAggregator(snap);
    b.addHistoryBatch({ chats: [], contacts: [], messages: [], syncType: 2, progress: 100 }, 2);
    expect(b.summary()).toMatchObject({ state: 'complete', progress: 100, fullProgress: 100 });
  });

  it('un snapshot viejo que dio por completo un sync a medias queda en pausa', () => {
    const a = new StatsAggregator();
    a.addHistoryBatch({ chats: [], contacts: [], messages: [], syncType: 2, progress: 79 }, 1);
    const snap = { ...a.snapshot(), state: 'complete' as const, completionInferred: true };
    delete (snap as { syncProgress?: unknown }).syncProgress;
    snap.progress = 79;
    expect(new StatsAggregator(snap).summary().state).toBe('paused');
  });

  it('sobrevive a un snapshot/restore', () => {
    const a = new StatsAggregator();
    for (const b of buildFakeHistory()) a.addHistoryBatch(b);
    const restored = new StatsAggregator(JSON.parse(JSON.stringify(a.snapshot())));
    expect(restored.summary()).toEqual(a.summary());
  });

  it('el historial falso del simulador es coherente', () => {
    const a = new StatsAggregator();
    for (const b of buildFakeHistory()) a.addHistoryBatch(b);
    const r = a.summary();
    expect(r.groups).toBe(6);
    expect(r.contacts).toBe(48);
    expect(r.individualChats).toBe(38); // los chats por LID se fusionan con su número
    expect(r.messages).toBeGreaterThan(2000);
    expect(r.topChats).toHaveLength(10);
  });
});

describe('nombres', () => {
  it('prefiere el nombre guardado en la agenda por sobre el pushName', () => {
    const s = new StatsAggregator();
    s.addMessages([
      {
        key: { remoteJid: PN, id: 'a' },
        message: { conversation: 'x' },
        messageTimestamp: 1,
        pushName: 'Anita 🌸',
      },
    ]);
    expect(s.summary().topChats[0]?.name).toBe('Anita 🌸');
    s.addContacts([{ id: PN, name: 'Ana Pérez (clienta)' }]);
    expect(s.summary().topChats[0]?.name).toBe('Ana Pérez (clienta)');
  });
});

describe('sync que se reabre', () => {
  it('si llegan lotes FULL después de que RECENT terminó, vuelve a "running"', () => {
    const a = new StatsAggregator();
    a.addHistoryBatch({ chats: [], contacts: [], messages: [], syncType: 3 }, 1);
    a.markSyncStatus(3, 'complete');
    expect(a.summary().state).toBe('complete');
    a.addHistoryBatch({ chats: [], contacts: [], messages: [], syncType: 2 }, 2);
    expect(a.summary().state).toBe('running');
    a.markSyncStatus(2, 'complete');
    expect(a.summary().state).toBe('complete');
  });
});
