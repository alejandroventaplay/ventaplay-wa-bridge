import { describe, expect, it } from 'vitest';
import { fmtAgo, fmtPhone, fmtSpan, initials } from './format';

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
});
