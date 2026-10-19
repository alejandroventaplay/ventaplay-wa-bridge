import { describe, expect, it } from 'vitest';
import { isSupportedAudio, resampleTo16k, toMono } from '../src/transcribe/transcriber.js';

describe('transcriber (utilidades de audio)', () => {
  it('acepta las notas de voz de WhatsApp (OGG/Opus)', () => {
    expect(isSupportedAudio('audio/ogg; codecs=opus')).toBe(true);
    expect(isSupportedAudio('audio/mpeg')).toBe(false);
    expect(isSupportedAudio(null)).toBe(false);
  });

  it('baja de 48 kHz a 16 kHz promediando', () => {
    const input = Float32Array.from([0, 3, 6, 9, 12, 15]);
    expect(Array.from(resampleTo16k(input, 48_000))).toEqual([3, 12]);
    expect(resampleTo16k(input, 16_000)).toBe(input);
  });

  it('mezcla estéreo a mono', () => {
    const out = toMono([Float32Array.from([1, 1]), Float32Array.from([0, 3])]);
    expect(Array.from(out)).toEqual([0.5, 2]);
  });
});
