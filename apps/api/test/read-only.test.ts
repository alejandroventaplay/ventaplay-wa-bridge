import { describe, expect, it } from 'vitest';
import { enforceReadOnly, ReadOnlyViolation } from '../src/wa/read-only.js';

describe('candado de solo lectura', () => {
  it('bloquea envíos y cambios, deja intactas las lecturas', async () => {
    const sock = {
      sendMessage: async () => 'enviado',
      readMessages: async () => 'leído',
      sendPresenceUpdate: async () => 'online',
      groupCreate: async () => 'grupo',
      profilePictureUrl: async () => 'url',
      getBusinessProfile: async () => ({}),
      logout: async () => undefined,
    };
    const blocked = enforceReadOnly(sock);
    expect(blocked).toEqual(
      expect.arrayContaining(['sendMessage', 'readMessages', 'sendPresenceUpdate', 'groupCreate']),
    );
    expect(() => sock.sendMessage()).toThrow(ReadOnlyViolation);
    expect(() => sock.readMessages()).toThrow(ReadOnlyViolation);
    await expect(sock.profilePictureUrl()).resolves.toBe('url');
    await expect(sock.logout()).resolves.toBeUndefined();
  });
});

describe('candado sobre un socket real de Baileys', () => {
  it('todos los nombres bloqueados existen y quedan bloqueados', async () => {
    const { default: makeWASocket, initAuthCreds } = await import('baileys');
    const pino = (await import('pino')).default;
    const { BLOCKED_METHODS } = await import('../src/wa/read-only.js');
    const sock = makeWASocket({
      auth: { creds: initAuthCreds(), keys: { get: async () => ({}), set: async () => {} } },
      logger: pino({ level: 'silent' }),
    });
    try {
      const blocked = enforceReadOnly(sock);
      // si Baileys renombra algo, este test avisa
      expect(BLOCKED_METHODS.filter((m) => !blocked.includes(m))).toEqual([]);
      expect(() => sock.sendMessage('x@s.whatsapp.net', { text: 'hola' })).toThrow(
        ReadOnlyViolation,
      );
      expect(() => sock.readMessages([])).toThrow(ReadOnlyViolation);
      expect(typeof sock.profilePictureUrl).toBe('function');
    } finally {
      sock.ev.removeAllListeners(undefined as never);
      sock.end(undefined);
    }
  });
});
