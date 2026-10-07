import { describe, expect, it } from 'vitest';
import { Cipher } from '../src/crypto.js';
import { TEST_KEY } from './helpers.js';

describe('Cipher', () => {
  it('cifra y descifra (round trip) con IV distinto cada vez', () => {
    const c = new Cipher(TEST_KEY);
    const a = c.encryptString('hola ventaplay');
    const b = c.encryptString('hola ventaplay');
    expect(a.equals(b)).toBe(false);
    expect(c.decryptString(a)).toBe('hola ventaplay');
  });

  it('rechaza datos manipulados o clave distinta', () => {
    const c = new Cipher(TEST_KEY);
    const blob = c.encryptString('secreto');
    const tampered = Buffer.from(blob);
    tampered[tampered.length - 1]! ^= 0xff;
    expect(() => c.decrypt(tampered)).toThrow();
    expect(() => new Cipher('b'.repeat(64)).decrypt(blob)).toThrow();
  });

  it('exige clave de 32 bytes', () => {
    expect(() => new Cipher('abcd')).toThrow();
  });
});
