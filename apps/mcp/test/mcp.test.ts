import { describe, expect, it } from 'vitest';
import type { PersonalChat } from '@wa-bridge/shared';
import { normalizePhone, parseEnv, resolveChat } from '../src/bridge.js';
import { body, transcript } from '../src/format.js';

const chat = (name: string, extra: Partial<PersonalChat> = {}): PersonalChat => ({
  jid: `${Math.abs([...name].reduce((h, c) => h * 31 + c.charCodeAt(0), 7)) % 1e9}@s.whatsapp.net`,
  name,
  phone: null,
  isGroup: false,
  isSelf: false,
  lastMessageAt: Date.UTC(2026, 9, 16, 21, 42),
  preview: 'hola',
  previewKind: 'text',
  previewFromMe: false,
  previewSender: null,
  stored: 1,
  ...extra,
});

describe('conector', () => {
  it('lee el token y el puerto del .env', () => {
    expect(parseEnv('PORT=4010\nAPI_TOKEN="abc def"\n# x\nOWNER_PHONE=569 # comentario')).toEqual({
      PORT: '4010',
      API_TOKEN: 'abc def',
      OWNER_PHONE: '569',
    });
  });

  it('normaliza números chilenos', () => {
    expect(normalizePhone('+56 9 8951 8540')).toBe('56989518540');
    expect(normalizePhone('989518540')).toBe('56989518540');
    expect(normalizePhone('89518540')).toBe('56989518540');
  });

  it('encuentra chats por nombre sin tildes, por número o avisa si es ambiguo', () => {
    const items = [
      chat('Sofía Fernández', { phone: '56991112222' }),
      chat('Sofía Pérez'),
      chat('Domingo Burgos'),
    ];
    expect(resolveChat(items, 'domingo').ok).toBe(true);
    expect(resolveChat(items, 'sofia fernandez')).toMatchObject({ ok: true });
    expect(resolveChat(items, '9 9111 2222')).toMatchObject({ ok: true });
    expect(resolveChat(items, 'sofia')).toMatchObject({ ok: false, reason: 'many' });
    expect(resolveChat(items, 'nadie')).toMatchObject({ ok: false, reason: 'none' });
  });

  it('arma transcripciones legibles con hora de Chile', () => {
    const c = chat('Sofía');
    const t = transcript(c, [
      {
        id: '1',
        fromMe: false,
        timestamp: Date.UTC(2026, 9, 16, 21, 42),
        kind: 'voice',
        text: null,
        senderJid: null,
        senderName: null,
        senderPhone: null,
        media: { mimetype: 'audio/ogg', seconds: 40 },
      },
      {
        id: '2',
        fromMe: true,
        timestamp: Date.UTC(2026, 9, 16, 21, 45),
        kind: 'text',
        text: 'ya voy',
        senderJid: null,
        senderName: null,
        senderPhone: null,
        media: null,
      },
    ]);
    expect(t).toBe('[16-10-2026 18:42] Sofía: 🎤 Nota de voz 0:40\n[16-10-2026 18:45] Tú: ya voy');
    expect(
      body({ kind: 'document', text: 'ver', media: { mimetype: null, fileName: 'a.pdf' } }),
    ).toBe('📄 Documento · a.pdf · ver');
  });
});
