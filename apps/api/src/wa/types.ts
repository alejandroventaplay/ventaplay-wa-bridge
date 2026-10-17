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
  /**
   * Solo existe si el dueño habilitó el envío (ALLOW_SEND). Manda un texto y devuelve
   * el mensaje enviado. Todo lo demás del socket sigue bloqueado por el candado.
   */
  sendText?(jid: string, text: string): Promise<unknown>;
  /** igual que sendText (solo con ALLOW_SEND): foto, video, audio o documento */
  sendMedia?(jid: string, media: OutgoingMedia): Promise<unknown>;
  /**
   * Solo para el dueño: le pide a SU teléfono que vuelva a subir la foto/audio de un
   * mensaje viejo cuyo archivo ya expiró en el CDN. No le escribe a nadie más.
   * Devuelve el mensaje con la ruta nueva.
   */
  reuploadMedia?(message: unknown): Promise<unknown>;
  /**
   * Solo para el dueño: le pide a SU teléfono un tramo de historial más antiguo que
   * `oldest` (History Sync a pedido). No le escribe a nadie más; los mensajes llegan
   * después por `messaging-history.set` con syncType ON_DEMAND.
   */
  fetchHistory?(count: number, oldest: HistoryAnchor, oldestTimestampMs: number): Promise<unknown>;
}

/** mensaje más antiguo que ya tenemos de un chat: desde ahí se pide hacia atrás */
export interface HistoryAnchor {
  remoteJid: string;
  id: string;
  fromMe: boolean;
}

/** syncType de WhatsApp para el historial pedido a demanda (proto.HistorySync.HistorySyncType) */
export const SYNC_ON_DEMAND = 6;

/** archivo que el dueño manda desde Mi vista o Claude */
export interface OutgoingMedia {
  kind: 'image' | 'video' | 'audio' | 'document';
  data: Buffer;
  mimetype: string;
  fileName: string;
  caption?: string | undefined;
}

export interface SocketFactoryOptions {
  sessionId: string;
  auth: StoredAuthState;
  logger: Logger;
}

export type SocketFactory = (opts: SocketFactoryOptions) => Promise<WaSocketLike>;

/** Descarga (y descifra) la media de un mensaje de WhatsApp. Solo HTTPS al CDN; no envía nada. */
export type MediaDownloader = (
  message: unknown,
  opts?: { reupload?: ((message: unknown) => Promise<unknown>) | undefined },
) => Promise<Buffer>;
