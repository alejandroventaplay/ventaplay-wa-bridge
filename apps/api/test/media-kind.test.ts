import { describe, expect, it } from 'vitest';
import { cleanFileName, mediaKindFor } from '../src/session/wa-session.js';
import { toContent } from '../src/wa/baileys-socket.js';

describe('archivos salientes', () => {
  it('elige cómo se manda según el tipo', () => {
    expect(mediaKindFor('image/jpeg')).toBe('image');
    expect(mediaKindFor('image/png')).toBe('image');
    expect(mediaKindFor('image/heic')).toBe('document');
    expect(mediaKindFor('image/gif')).toBe('document');
    expect(mediaKindFor('video/mp4')).toBe('video');
    expect(mediaKindFor('video/quicktime')).toBe('document');
    expect(mediaKindFor('audio/mpeg')).toBe('audio');
    expect(mediaKindFor('application/pdf')).toBe('document');
    expect(mediaKindFor('')).toBe('document');
  });

  it('limpia el nombre del archivo', () => {
    expect(cleanFileName('/Users/x/Desktop/propuesta.pdf')).toBe('propuesta.pdf');
    expect(cleanFileName('C:\\docs\\a.xlsx')).toBe('a.xlsx');
    expect(cleanFileName('  ')).toBe('archivo');
  });

  it('arma el contenido de Baileys sin campos de más', () => {
    const data = Buffer.from('x');
    expect(
      toContent({ kind: 'image', data, mimetype: 'image/png', fileName: 'a.png', caption: 'hola' }),
    ).toEqual({ image: data, mimetype: 'image/png', caption: 'hola' });
    expect(
      toContent({ kind: 'audio', data, mimetype: 'audio/mpeg', fileName: 'a.mp3', caption: 'x' }),
    ).toEqual({
      audio: data,
      mimetype: 'audio/mpeg',
    });
    expect(
      toContent({ kind: 'document', data, mimetype: 'application/pdf', fileName: 'a.pdf' }),
    ).toEqual({ document: data, mimetype: 'application/pdf', fileName: 'a.pdf' });
  });
});
