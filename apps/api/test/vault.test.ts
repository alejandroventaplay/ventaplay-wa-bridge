import { describe, expect, it } from 'vitest';
import {
  extractContent,
  MessageVault,
  VAULT_KEY_PREFIX,
  VAULT_PER_CHAT,
  VAULT_WINDOW_MS,
} from '../src/session/message-vault.js';

const NOW = Date.UTC(2026, 9, 16, 12);
const day = 24 * 3600 * 1000;
const sec = (ms: number) => Math.floor(ms / 1000);

let n = 0;
function msg(jid: string, ts: number, message: object, extra: Record<string, unknown> = {}) {
  return {
    key: { id: `M${n++}`, remoteJid: jid, fromMe: false, ...extra },
    message,
    messageTimestamp: sec(ts),
    pushName: 'Sofía',
  };
}

describe('extractContent', () => {
  it('reconoce texto, media, ubicación, encuestas y envoltorios', () => {
    expect(extractContent({ conversation: 'hola' })).toMatchObject({ kind: 'text', text: 'hola' });
    expect(
      extractContent({
        ephemeralMessage: { message: { extendedTextMessage: { text: 'efímero' } } },
      }),
    ).toMatchObject({ kind: 'text', text: 'efímero' });
    expect(
      extractContent({ imageMessage: { mimetype: 'image/jpeg', caption: 'foto', width: 10 } }),
    ).toMatchObject({ kind: 'image', text: 'foto', downloadable: true });
    expect(extractContent({ audioMessage: { ptt: true, seconds: 7 } })).toMatchObject({
      kind: 'voice',
      media: { seconds: 7 },
    });
    expect(extractContent({ videoMessage: { gifPlayback: true } })?.kind).toBe('gif');
    expect(
      extractContent({
        documentWithCaptionMessage: {
          message: { documentMessage: { fileName: 'a.pdf', caption: 'ver' } },
        },
      }),
    ).toMatchObject({ kind: 'document', text: 'ver', media: { fileName: 'a.pdf' } });
    expect(
      extractContent({ locationMessage: { degreesLatitude: -33.4, degreesLongitude: -70.6 } }),
    ).toMatchObject({ kind: 'location', location: { lat: -33.4, lng: -70.6 } });
    expect(
      extractContent({ pollCreationMessageV3: { name: '¿Dónde?', options: [{ optionName: 'A' }] } })
        ?.text,
    ).toBe('¿Dónde?\n○ A');
  });

  it('ignora reacciones y mensajes de sistema', () => {
    expect(extractContent({ reactionMessage: { text: '👍' } })).toBeNull();
    expect(extractContent({ senderKeyDistributionMessage: {}, messageContextInfo: {} })).toBeNull();
    expect(extractContent({ protocolMessage: { type: 3 } })).toBeNull();
  });
});

describe('MessageVault', () => {
  it('guarda solo los últimos 10 por chat, sin duplicados', () => {
    const v = new MessageVault();
    const jid = '56911111111@s.whatsapp.net';
    const all = Array.from({ length: 25 }, (_, i) =>
      msg(jid, NOW - (25 - i) * 60_000, { conversation: `m${i}` }),
    );
    v.add(all.slice(10));
    v.add(all.slice(0, 15)); // llegan desordenados y repetidos
    const list = v.get(jid);
    expect(list).toHaveLength(VAULT_PER_CHAT);
    expect(list.map((m) => m.text)).toEqual(Array.from({ length: 10 }, (_, i) => `m${i + 15}`));
  });

  it('marca borrados y ediciones', () => {
    const v = new MessageVault();
    const jid = '56922222222@s.whatsapp.net';
    const a = msg(jid, NOW - 5000, { conversation: 'original' });
    const b = msg(jid, NOW - 4000, { imageMessage: { mimetype: 'image/jpeg' } });
    v.add([a, b]);
    v.add([
      msg(jid, NOW, {
        protocolMessage: {
          type: 14,
          key: { id: a.key.id },
          editedMessage: { conversation: 'editado' },
        },
      }),
      msg(jid, NOW, { protocolMessage: { type: 0, key: { id: b.key.id } } }),
    ]);
    const [ma, mb] = v.get(jid);
    expect(ma).toMatchObject({ text: 'editado', edited: true });
    expect(mb).toMatchObject({ kind: 'deleted', raw: null, media: null });
  });

  it('en grupos guarda el autor con número cuando viene por LID', () => {
    const v = new MessageVault();
    v.add([
      msg(
        '120363000@g.us',
        NOW,
        { conversation: 'hola grupo' },
        {
          participant: '123456789@lid',
          participantAlt: '56933333333@s.whatsapp.net',
        },
      ),
    ]);
    expect(v.get('120363000@g.us')[0]).toMatchObject({
      sender: '56933333333@s.whatsapp.net',
      senderAlt: '123456789@lid',
    });
  });

  it('en disco solo quedan los chats con actividad en 30 días y se recarga igual', () => {
    const v = new MessageVault();
    v.add([
      msg('56944444444@s.whatsapp.net', NOW - 2 * day, { conversation: 'reciente' }),
      msg('56955555555@s.whatsapp.net', NOW - VAULT_WINDOW_MS - day, { conversation: 'viejo' }),
    ]);
    expect(v.counts(NOW)).toEqual({ chats: 1, messages: 1 });
    const dirty = v.takeDirty(NOW);
    expect(dirty[`${VAULT_KEY_PREFIX}56955555555@s.whatsapp.net`]).toBeNull();
    const saved = dirty[`${VAULT_KEY_PREFIX}56944444444@s.whatsapp.net`];
    expect(saved).toContain('reciente');
    expect(Object.keys(v.takeDirty(NOW))).toHaveLength(0);

    const again = new MessageVault();
    again.load(new Map([[`${VAULT_KEY_PREFIX}56944444444@s.whatsapp.net`, saved!]]));
    expect(again.get('56944444444@s.whatsapp.net')[0]?.text).toBe('reciente');
  });

  it('guarda el mensaje original solo cuando hay media para descargar', () => {
    const v = new MessageVault();
    const jid = '56966666666@s.whatsapp.net';
    v.add([
      msg(jid, NOW - 1000, { conversation: 'texto' }),
      msg(jid, NOW, { audioMessage: { ptt: true, mediaKey: 'abc' } }),
    ]);
    const [t, a] = v.get(jid);
    expect(t?.raw).toBeNull();
    expect(a?.raw).toContain('mediaKey');
  });
});
