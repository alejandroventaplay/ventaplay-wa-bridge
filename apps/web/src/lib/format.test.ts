import { describe, expect, it } from 'vitest';
import {
  fmtAgo,
  fmtBytes,
  fmtChatStamp,
  fmtDayLabel,
  fmtDuration,
  fmtPhone,
  fmtSpan,
  initials,
} from './format';

describe('format', () => {
  it('teléfonos chilenos y extranjeros', () => {
    expect(fmtPhone('56912345678')).toBe('+56 9 1234 5678');
    expect(fmtPhone('5491122334455')).toBe('+5491122334455');
    expect(fmtPhone(null)).toBe('');
  });
  it('tiempo relativo', () => {
    const now = 1_000_000_000_000;
    expect(fmtAgo(now - 10_000, now)).toBe('recién');
    expect(fmtAgo(now - 5 * 60_000, now)).toBe('hace 5 min');
    expect(fmtAgo(now - 3 * 86_400_000, now)).toBe('hace 3 días');
  });
  it('duración', () => {
    const d = 24 * 3600 * 1000;
    const t0 = Date.UTC(2024, 0, 1);
    expect(fmtSpan(t0, t0 + 600 * d)).toBe('1 año y 7 meses');
    expect(fmtSpan(t0, t0 + 3 * d)).toBe('3 días');
    expect(fmtSpan(null, 1)).toBe('—');
  });
  it('iniciales', () => {
    expect(initials('Barbería Don Pepe')).toBe('BD');
    expect(initials('💈 Equipo')).toBe('E');
    expect(initials(null)).toBe('?');
  });
  it('fechas de chat como WhatsApp', () => {
    const now = new Date(2026, 9, 16, 15, 0).getTime();
    expect(fmtChatStamp(new Date(2026, 9, 16, 9, 5).getTime(), now)).toMatch(/09:05/);
    expect(fmtChatStamp(new Date(2026, 9, 15, 23, 0).getTime(), now)).toBe('Ayer');
    expect(fmtChatStamp(new Date(2026, 9, 1).getTime(), now)).toBe('01-10-26');
    expect(fmtDayLabel(new Date(2026, 9, 16, 1).getTime(), now)).toBe('Hoy');
    expect(fmtDayLabel(new Date(2026, 9, 12).getTime(), now)).toMatch(
      /^Lunes, 12 de octubre|^Lunes 12 de octubre/,
    );
  });
  it('duración de audios y tamaño de archivos', () => {
    expect(fmtDuration(7)).toBe('0:07');
    expect(fmtDuration(754)).toBe('12:34');
    expect(fmtBytes(412)).toBe('412 B');
    expect(fmtBytes(1_300_000)).toBe('1,2 MB');
  });
});

import { openFolderCommand } from './api';

describe('comando para abrir la carpeta', () => {
  it('arma open / explorer con la ruta entre comillas', () => {
    expect(openFolderCommand('/Users/a/proy x', 'MacIntel')).toBe('open "/Users/a/proy x"');
    expect(openFolderCommand('C:\\data\\proy', 'Win32')).toBe('explorer "C:\\data\\proy"');
    expect(openFolderCommand('/home/a/"x"', 'Linux x86_64')).toBe('xdg-open "/home/a/\\"x\\""');
  });
});
