import { describe, expect, it } from 'vitest';
import { SendLimiter } from '../src/session/send-limiter.js';

describe('SendLimiter', () => {
  it('frena por minuto, por hora y entre mensajes al mismo chat', () => {
    const l = new SendLimiter({ perMinute: 3, perHour: 5, perDay: 6, sameChatGapMs: 2000 });
    const t0 = 1_000_000_000_000;
    for (let i = 0; i < 3; i++) {
      expect(l.check(`c${i}`, t0 + i)).toBeNull();
      l.record(`c${i}`, t0 + i);
    }
    expect(l.check('c9', t0 + 10)).toMatch(/minuto/);
    expect(l.check('c2', t0 + 61_000)).toBeNull();
    l.record('c3', t0 + 61_000);
    expect(l.check('c3', t0 + 61_500)).toMatch(/segundos/);
    l.record('c4', t0 + 62_000);
    expect(l.check('c5', t0 + 63_000)).toMatch(/hora/);
    expect(l.remaining(t0 + 63_000)).toEqual({ hour: 0, day: 1 });
    expect(l.check('c5', t0 + 3_700_000)).toBeNull();
  });
});
