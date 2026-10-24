import { describe, expect, it } from 'vitest';
import { ChatArchive, MEDIA_KEY } from '../src/session/chat-archive.js';
import type { StoredMessage } from '../src/session/message-vault.js';

const G = '120363412234546089@g.us';
const ME = { meJid: '56912345678@s.whatsapp.net', meLid: '111@lid' };
const LEON = '56911111111@s.whatsapp.net';

const msg = (id: string, message: object, extra: Record<string, unknown> = {}) => ({
  key: { remoteJid: G, id, fromMe: false, participant: '222@lid', participantAlt: LEON },
  message,
  messageTimestamp: 1_792_000_000,
  pushName: 'Leon',
  ...extra,
});

describe('archivo de proyectos', () => {
  it('solo guarda chats aislados, con todos los metadatos', () => {
    const a = new ChatArchive();
    expect(a.ingest([msg('A1', { conversation: 'hola' })], 'live', ME)).toBe(0);
    a.track(G, 1);
    const n = a.ingest(
      [
        msg('A1', { conversation: 'hola' }),
        msg('A2', {
          extendedTextMessage: {
            text: 'te mando la factura @56912345678',
            contextInfo: {
              stanzaId: 'A1',
              participant: LEON,
              quotedMessage: { conversation: 'hola' },
              mentionedJid: [ME.meJid],
              isForwarded: true,
              forwardingScore: 2,
            },
          },
        }),
        msg('A3', {
          documentMessage: {
            mimetype: 'application/pdf',
            fileName: 'factura-123.pdf',
            fileLength: 2048,
            pageCount: 2,
            fileSha256: Buffer.from('abc'),
            caption: 'Factura proveedor',
          },
        }),
      ],
      'history',
      ME,
    );
    expect(n).toBe(3);
    const [, a2, a3] = a.messages(G);
    expect(a2).toMatchObject({
      type: 'extendedTextMessage',
      quoted: { id: 'A1', participant: LEON, text: 'hola' },
      mentions: [ME.meJid],
      forwarded: true,
      forwardingScore: 2,
      sender: { jid: LEON, lid: '222@lid', phone: '56911111111', pushName: 'Leon' },
      source: 'history',
    });
    expect(a3).toMatchObject({
      kind: 'document',
      text: 'Factura proveedor',
      media: {
        fileName: 'factura-123.pdf',
        pageCount: 2,
        sha256: Buffer.from('abc').toString('base64'),
        downloaded: false,
      },
    });
    expect(a3!.rawJson).toContain('factura-123.pdf');
    expect(a.pendingMedia(G).map((r) => r.id)).toEqual(['A3']);
  });

  it('guarda ediciones con el texto anterior, borrados, reacciones y recibos', () => {
    const a = new ChatArchive();
    a.track(G, 1);
    a.ingest([msg('B1', { conversation: 'total 10.000' })], 'live', ME);
    // edición (protocolMessage 14)
    a.ingest(
      [
        msg('E1', {
          protocolMessage: {
            type: 14,
            key: { id: 'B1' },
            editedMessage: { conversation: 'total 12.000' },
          },
        }),
      ],
      'live',
      ME,
    );
    // reacción mía y quitada después por Leon
    a.ingest(
      [
        msg(
          'R1',
          { reactionMessage: { key: { id: 'B1' }, text: '👍', senderTimestampMs: 5 } },
          { key: { remoteJid: G, id: 'R1', fromMe: true } },
        ),
        msg('R2', { reactionMessage: { key: { id: 'B1' }, text: '😬', senderTimestampMs: 6 } }),
        msg('R3', { reactionMessage: { key: { id: 'B1' }, text: '', senderTimestampMs: 7 } }),
      ],
      'live',
      ME,
    );
    a.receipts([
      {
        key: { remoteJid: G, id: 'B1' },
        receipt: { userJid: LEON, receiptTimestamp: 100, readTimestamp: 200 },
      },
    ]);
    let b1 = a.get(G, 'B1')!;
    expect(b1.text).toBe('total 12.000');
    expect(b1.edits).toEqual([{ timestamp: 1_792_000_000_000, previousText: 'total 10.000' }]);
    expect(b1.reactions).toEqual([{ sender: ME.meJid, emoji: '👍', timestamp: 5 }]);
    expect(b1.receipts).toEqual([{ jid: LEON, delivered: 100_000, read: 200_000, played: null }]);
    // borrado: se marca pero no se pierde lo que decía
    a.ingest([msg('D1', { protocolMessage: { type: 0, key: { id: 'B1' } } })], 'live', ME);
    b1 = a.get(G, 'B1')!;
    expect(b1.deleted).not.toBeNull();
    expect(b1.kind).toBe('deleted');
    expect(b1.edits.at(-1)?.previousText).toBe('total 12.000');
    // repetido desde el historial: no pisa lo acumulado
    a.ingest([msg('B1', { conversation: 'total 10.000' })], 'history', ME);
    expect(a.get(G, 'B1')!.deleted).not.toBeNull();
  });

  it('copia la bóveda, persiste y vuelve a cargar', () => {
    const a = new ChatArchive();
    a.track(G, 1);
    const stored: StoredMessage[] = [
      {
        id: 'V1',
        fromMe: true,
        ts: 1000,
        kind: 'text',
        text: 'les mande la cita',
        sender: null,
        pushName: null,
        media: null,
      },
    ];
    expect(a.backfill(G, stored, ME)).toBe(1);
    expect(a.get(G, 'V1')).toMatchObject({ source: 'vault', sender: { jid: ME.meJid } });
    a.ingest([msg('M1', { imageMessage: { mimetype: 'image/jpeg', fileLength: 10 } })], 'live', ME);
    a.mediaDone(G, 'M1', { ok: true, size: 10, verified: true }, 50);

    const dirty = a.takeDirty();
    expect(Object.keys(dirty)).toHaveLength(3);
    const b = new ChatArchive();
    b.load(new Map(Object.entries(dirty)));
    expect(b.list().map((p) => p.jid)).toEqual([G]);
    expect(b.messages(G).map((m) => m.id)).toEqual(['V1', 'M1']);
    expect(b.get(G, 'M1')!.media).toMatchObject({ downloaded: true, verified: true });
    expect(b.pendingMedia()).toEqual([]);

    // dejar de aislar devuelve las claves a borrar, incluida la media
    expect(b.untrack(G)).toContain(MEDIA_KEY(G, 'M1'));
    expect(b.list()).toEqual([]);
  });

  it('se rinde con la media después de 3 intentos', () => {
    const a = new ChatArchive();
    a.track(G, 1);
    a.ingest([msg('M2', { imageMessage: { mimetype: 'image/jpeg' } })], 'live', ME);
    for (let i = 0; i < 3; i++) a.mediaDone(G, 'M2', { ok: false, error: 'expiró' });
    expect(a.pendingMedia()).toEqual([]);
    expect(a.get(G, 'M2')!.media?.error).toBe('expiró');
  });
});

describe('timestamps', () => {
  it('entiende Long serializado de la bóveda', async () => {
    const { tsOf } = await import('../src/session/chat-archive.js');
    expect(tsOf({ low: 1_792_000_000, high: 0, unsigned: true })).toBe(1_792_000_000_000);
    expect(tsOf('1792000000')).toBe(1_792_000_000_000);
    expect(tsOf(1_792_000_000_000)).toBe(1_792_000_000_000);
    expect(tsOf(null)).toBeNull();
  });
});
