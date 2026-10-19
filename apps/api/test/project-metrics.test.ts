import { describe, expect, it } from 'vitest';
import type { ArchivedMessage } from '@wa-bridge/shared';
import { computeProjectMetrics } from '../src/session/project-metrics.js';

const T0 = Date.parse('2026-10-15T15:00:00Z'); // 12:00 en Chile

function msg(
  i: number,
  who: 'yo' | 'ana' | 'beto',
  minutes: number,
  extra: Partial<ArchivedMessage> = {},
): ArchivedMessage {
  const people = {
    ana: {
      jid: '56911111111@s.whatsapp.net',
      lid: null,
      phone: '56911111111',
      name: 'Ana',
      pushName: null,
    },
    beto: {
      jid: '56922222222@s.whatsapp.net',
      lid: null,
      phone: '56922222222',
      name: 'Beto',
      pushName: null,
    },
    yo: { jid: null, lid: null, phone: null, name: null, pushName: null },
  };
  return {
    id: `M${i}`,
    chatJid: '1203@g.us',
    timestamp: T0 + minutes * 60_000,
    fromMe: who === 'yo',
    sender: people[who],
    type: 'conversation',
    kind: 'text',
    text: 'hola qué tal',
    quoted: null,
    mentions: [],
    forwarded: false,
    forwardingScore: null,
    ephemeralSeconds: null,
    media: null,
    location: null,
    edits: [],
    deleted: null,
    reactions: [],
    receipts: [],
    source: 'live',
    capturedAt: 0,
    updatedAt: 0,
    ...extra,
  };
}

describe('métricas por persona', () => {
  it('cuenta mensajes, palabras, notas de voz y mediana de respuesta', () => {
    const m = computeProjectMetrics('1203@g.us', [
      msg(1, 'ana', 0),
      msg(2, 'beto', 10),
      msg(3, 'ana', 12),
      msg(4, 'yo', 42, {
        kind: 'voice',
        text: null,
        media: { mimetype: 'audio/ogg', seconds: 20 } as never,
      }),
      msg(5, 'ana', 60 * 20), // 20 h después: no cuenta como respuesta
    ]);
    expect(m.total).toBe(5);
    const ana = m.people.find((p) => p.name === 'Ana')!;
    expect(ana.messages).toBe(3);
    expect(ana.words).toBe(9);
    expect(ana.replies).toBe(1); // respondió a Beto en 2 min
    expect(ana.medianReplyMinutes).toBe(2);
    const yo = m.people.find((p) => p.fromMe)!;
    expect(yo.voiceNotes).toBe(1);
    expect(yo.voiceSeconds).toBe(20);
    expect(m.people[0]!.name).toBe('Ana');
    expect(m.byHour[12]).toBe(4);
    expect(m.byDay[0]).toEqual({ day: '2026-10-15', messages: 4 });
  });

  it('filtra por ventana de días', () => {
    const m = computeProjectMetrics('x', [msg(1, 'ana', 0), msg(2, 'beto', 60 * 24 * 10)], {
      days: 3,
      now: T0 + 60_000 * 60 * 24 * 11,
    });
    expect(m.total).toBe(1);
    expect(m.people[0]!.name).toBe('Beto');
  });
});
