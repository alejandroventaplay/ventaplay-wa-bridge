import { describe, expect, it } from 'vitest';
import { isExpiredMedia, withBinaryKeys } from '../src/wa/baileys-socket.js';

describe('media vencida', () => {
  it('reconoce el 404/410 del CDN tanto en Boom como en errores simples', () => {
    expect(isExpiredMedia({ output: { statusCode: 410 } })).toBe(true);
    expect(isExpiredMedia({ output: { statusCode: 404 } })).toBe(true);
    expect(isExpiredMedia({ status: 410 })).toBe(true);
    expect(isExpiredMedia({ output: { statusCode: 403 } })).toBe(true);
    expect(isExpiredMedia({ output: { statusCode: 500 } })).toBe(false);
    expect(isExpiredMedia(new Error('timeout'))).toBe(false);
  });

  it('devuelve las llaves binarias guardadas como base64 a Buffer', () => {
    const key = Buffer.from('llave-de-prueba-32-bytes-1234567');
    const m = withBinaryKeys({
      key: { id: 'x' },
      message: { imageMessage: { mediaKey: key.toString('base64'), url: 'https://x', seconds: 3 } },
    });
    expect(Buffer.isBuffer(m.message.imageMessage.mediaKey)).toBe(true);
    expect((m.message.imageMessage.mediaKey as unknown as Buffer).equals(key)).toBe(true);
    expect(m.message.imageMessage.url).toBe('https://x');
  });
});
