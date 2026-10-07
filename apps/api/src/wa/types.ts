import type { BaileysEventMap, WABusinessProfile } from 'baileys';
import type { Logger } from 'pino';
import type { StoredAuthState } from './auth-state.js';

export type WaEventName = keyof BaileysEventMap;

/**
 * Lo único que la sesión usa del socket de Baileys. Mantenerlo chico permite
 * testear con un socket falso y usar el simulador en desarrollo.
 * No hay ningún método de envío: este servicio es de solo lectura.
 */
export interface WaSocketLike {
  ev: {
    on<K extends WaEventName>(event: K, listener: (arg: BaileysEventMap[K]) => void): void;
    removeAllListeners(event?: WaEventName): void;
  };
  user?: { id: string; name?: string; notify?: string; lid?: string } | undefined;
  end(error?: Error): void;
  logout(msg?: string): Promise<void>;
  profilePictureUrl(
    jid: string,
    type?: 'preview' | 'image',
    timeoutMs?: number,
  ): Promise<string | undefined>;
  getBusinessProfile(jid: string): Promise<WABusinessProfile | void>;
}

export interface SocketFactoryOptions {
  sessionId: string;
  auth: StoredAuthState;
  logger: Logger;
}

export type SocketFactory = (opts: SocketFactoryOptions) => Promise<WaSocketLike>;
