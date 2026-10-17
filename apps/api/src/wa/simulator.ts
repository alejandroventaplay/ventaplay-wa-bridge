import { EventEmitter } from 'node:events';
import type { BaileysEventMap, WABusinessProfile } from 'baileys';
import type { HistoryBatch } from '../session/stats.js';
import {
  type HistoryAnchor,
  type MediaDownloader,
  type OutgoingMedia,
  type SocketFactory,
  type SocketFactoryOptions,
  SYNC_ON_DEMAND,
  type WaSocketLike,
} from './types.js';

/**
 * Simulador de WhatsApp para desarrollar la UI sin un teléfono (WA_DRIVER=simulator).
 * Emite QRs que rotan, permite "escanear" vía POST /sessions/:id/simulate-scan
 * y luego entrega un historial falso en lotes, como lo haría WhatsApp.
 * Jamás se usa en producción (config.ts lo impide).
 */

const DEMO_JID = '56912345678@s.whatsapp.net';
const DEMO_LID = '118477331234567@lid';
/** tramos de historial antiguo que entrega el simulador antes de decir "no hay más" */
const SIM_HISTORY_PAGES = 3;

interface Timing {
  firstQrMs: number;
  qrRotateMs: number;
  maxQrs: number;
  openMs: number;
  batchEveryMs: number;
}

const DEFAULT_TIMING: Timing = {
  firstQrMs: 400,
  qrRotateMs: 20_000,
  maxQrs: 6,
  openMs: 900,
  batchEveryMs: 1_200,
};

class SimSocket implements WaSocketLike {
  readonly ev = new EventEmitter() as unknown as WaSocketLike['ev'] & EventEmitter;
  user: WaSocketLike['user'] = undefined;
  private timers: NodeJS.Timeout[] = [];
  private ended = false;

  constructor(
    private readonly opts: SocketFactoryOptions,
    private readonly timing: Timing,
    private readonly onEnd: () => void,
  ) {}

  run(): void {
    const linked = Boolean(this.opts.auth.state.creds.me?.id);
    this.later(0, () => this.emit('connection.update', { connection: 'connecting' }));
    if (linked) {
      this.later(this.timing.openMs, () => this.open(false));
      return;
    }
    for (let i = 0; i < this.timing.maxQrs; i++) {
      this.later(this.timing.firstQrMs + i * this.timing.qrRotateMs, () =>
        this.emit('connection.update', {
          qr: `2@SIMULADO-VENTAPLAY-${Date.now()}-${i},bridge,dev`,
        }),
      );
    }
    // sin escaneo: WhatsApp corta con 408
    this.later(this.timing.firstQrMs + this.timing.maxQrs * this.timing.qrRotateMs, () =>
      this.close(408, 'QR refs attempts ended'),
    );
  }

  /** el "teléfono" escanea el QR */
  scan(): void {
    this.clearTimers();
    const creds = this.opts.auth.state.creds;
    creds.me = { id: '56912345678:7@s.whatsapp.net', lid: DEMO_LID, name: 'Barbería Demo' };
    creds.platform = 'smba';
    this.emit('creds.update', { me: creds.me, platform: creds.platform });
    this.emit('connection.update', { isNewLogin: true });
    this.later(300, () => this.close(515, 'restart required'));
  }

  private open(withHistory: boolean): void {
    this.user = { id: '56912345678:7@s.whatsapp.net', name: 'Barbería Demo', lid: DEMO_LID };
    this.emit('connection.update', { connection: 'open' });
    if (!withHistory) return;
    const batches = buildFakeHistory();
    batches.forEach((b, i) => {
      this.later(this.timing.batchEveryMs * (i + 1), () => {
        this.emit('messaging-history.set', {
          chats: b.chats as BaileysEventMap['messaging-history.set']['chats'],
          contacts: b.contacts as BaileysEventMap['messaging-history.set']['contacts'],
          messages: b.messages as BaileysEventMap['messaging-history.set']['messages'],
          lidPnMappings: (b.lidPnMappings ??
            []) as BaileysEventMap['messaging-history.set']['lidPnMappings'],
          progress: b.progress ?? null,
          syncType: b.syncType ?? null,
          isLatest: b.isLatest ?? false,
        });
      });
    });
    this.later(this.timing.batchEveryMs * (batches.length + 1), () => {
      this.emit('messaging-history.status', { syncType: 0, status: 'complete', explicit: true });
      this.emit('messaging-history.status', { syncType: 2, status: 'complete', explicit: true });
    });
  }

  openAfterRestart(): void {
    this.later(this.timing.openMs, () => this.open(true));
  }

  async logout(): Promise<void> {
    this.close(401, 'Intentional Logout');
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.clearTimers();
    this.onEnd();
  }

  /** el "teléfono" vuelve a subir la media: devuelve el mensaje con la ruta nueva */
  async reuploadMedia(message: unknown): Promise<unknown> {
    const m = message as { key?: unknown; message?: Record<string, Record<string, unknown>> };
    const inner = { ...(m.message ?? {}) };
    for (const k of Object.keys(inner))
      inner[k] = { ...inner[k], directPath: '/fresh', expired: false };
    return { key: m.key, message: inner };
  }

  async sendText(jid: string, text: string): Promise<unknown> {
    if (!this.user) throw new Error('no conectado');
    return {
      key: { id: `SIMOUT${Date.now().toString(16).toUpperCase()}`, remoteJid: jid, fromMe: true },
      message: { conversation: text },
      messageTimestamp: Math.floor(Date.now() / 1000),
    };
  }

  async sendMedia(jid: string, media: OutgoingMedia): Promise<unknown> {
    if (!this.user) throw new Error('no conectado');
    const base = { mimetype: media.mimetype, fileLength: media.data.length };
    const caption = media.caption ? { caption: media.caption } : {};
    const message =
      media.kind === 'image'
        ? { imageMessage: { ...base, ...caption, width: 480, height: 320 } }
        : media.kind === 'video'
          ? { videoMessage: { ...base, ...caption, seconds: 5 } }
          : media.kind === 'audio'
            ? { audioMessage: { ...base, seconds: 5 } }
            : { documentMessage: { ...base, ...caption, fileName: media.fileName } };
    const id = `SIMOUT${Date.now().toString(16).toUpperCase()}`;
    rememberSent(id, media.data);
    return {
      key: { id, remoteJid: jid, fromMe: true },
      message,
      messageTimestamp: Math.floor(Date.now() / 1000),
    };
  }

  /** pedidos de historial que ya respondió el "teléfono", por chat */
  private historyPages = new Map<string, number>();

  /**
   * El "teléfono" responde el historial a pedido: SIM_HISTORY_PAGES tramos de mensajes
   * más antiguos que `oldest` y luego uno vacío (ya no hay más).
   */
  async fetchHistory(count: number, oldest: HistoryAnchor, oldestTs: number): Promise<unknown> {
    if (!this.user) throw new Error('no conectado');
    const jid = oldest.remoteJid;
    const page = (this.historyPages.get(jid) ?? 0) + 1;
    this.historyPages.set(jid, page);
    const n = page > SIM_HISTORY_PAGES ? 0 : Math.min(count, 20);
    const group = jid.endsWith('@g.us');
    const messages = Array.from({ length: n }, (_, i) => {
      const fromMe = i % 3 === 0;
      return {
        key: {
          remoteJid: jid,
          id: `SIMOLD${page}X${i}`,
          fromMe,
          ...(group && !fromMe ? { participant: DEMO_JID } : {}),
        },
        messageTimestamp: Math.floor((oldestTs - (n - i) * 3_600_000) / 1000),
        message: { conversation: `Mensaje antiguo ${page}.${i + 1}` },
      };
    });
    this.later(this.timing.batchEveryMs / 4, () =>
      this.emit('messaging-history.set', {
        chats: [],
        contacts: [],
        messages: messages as BaileysEventMap['messaging-history.set']['messages'],
        lidPnMappings: [],
        progress: null,
        syncType: SYNC_ON_DEMAND,
        isLatest: false,
      } as BaileysEventMap['messaging-history.set']),
    );
    return `SIMREQ${page}`;
  }

  async profilePictureUrl(): Promise<string | undefined> {
    return undefined;
  }

  async getBusinessProfile(): Promise<WABusinessProfile> {
    return {
      wid: DEMO_JID,
      description: 'Barbería de prueba para el simulador de VentaPlay',
      category: 'Barbería',
      email: 'demo@ventaplay.com',
      website: ['https://ventaplay.com'],
      address: 'Santiago, Chile',
      business_hours: {},
    };
  }

  private emit<K extends keyof BaileysEventMap>(event: K, arg: BaileysEventMap[K]): void {
    if (this.ended) return;
    (this.ev as unknown as EventEmitter).emit(event, arg);
  }

  private close(statusCode: number, message: string): void {
    const error = Object.assign(new Error(message), { output: { statusCode } });
    this.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error, date: new Date() },
    });
    this.end();
  }

  private later(ms: number, fn: () => void): void {
    const t = setTimeout(fn, ms);
    t.unref?.();
    this.timers.push(t);
  }

  private clearTimers(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }
}

export interface Simulator {
  factory: SocketFactory;
  /** simula que el teléfono escanea el QR de esa sesión; false si no está mostrando QR */
  scan(sessionId: string): boolean;
  /** "descarga" la media falsa de los mensajes del simulador */
  downloadMedia: MediaDownloader;
}

export function createSimulator(timing: Partial<Timing> = {}): Simulator {
  const t = { ...DEFAULT_TIMING, ...timing };
  const live = new Map<string, SimSocket>();
  const justScanned = new Set<string>();

  const factory: SocketFactory = async (opts) => {
    const sock = new SimSocket(opts, t, () => {
      if (live.get(opts.sessionId) === sock) live.delete(opts.sessionId);
    });
    live.set(opts.sessionId, sock);
    if (justScanned.delete(opts.sessionId)) {
      // reinicio tras el escaneo: abre y entrega historial
      setTimeout(() => {
        (sock.ev as unknown as EventEmitter).emit('connection.update', {
          connection: 'connecting',
        });
        sock.openAfterRestart();
      }, 0);
    } else {
      setTimeout(() => sock.run(), 0);
    }
    return sock;
  };

  return {
    factory,
    scan(sessionId) {
      const sock = live.get(sessionId);
      if (!sock || sock.user) return false;
      justScanned.add(sessionId);
      sock.scan();
      return true;
    },
    downloadMedia: async (raw, opts) => {
      // media "vencida" en el CDN: solo se baja si el teléfono la vuelve a subir
      if (isExpired(raw)) {
        if (!opts?.reupload) throw new Error('media vencida (410)');
        return fakeMedia(await opts.reupload(raw));
      }
      return fakeMedia(raw);
    },
  };
}

/** archivos enviados en el simulador, para poder mostrarlos de vuelta (tope chico) */
const sentMedia = new Map<string, Buffer>();
function rememberSent(id: string, data: Buffer): void {
  sentMedia.set(id, data);
  if (sentMedia.size > 50) sentMedia.delete(sentMedia.keys().next().value!);
}

function isExpired(raw: unknown): boolean {
  const m = (raw as { message?: Record<string, { expired?: boolean }> } | null)?.message ?? {};
  return Object.values(m).some((v) => v && typeof v === 'object' && v.expired === true);
}

/** media falsa: una imagen SVG, un tono WAV o un PDF mínimo */
function fakeMedia(raw: unknown): Buffer {
  const sent = sentMedia.get((raw as { key?: { id?: string } } | null)?.key?.id ?? '');
  if (sent) return sent;
  const m = (raw as { message?: Record<string, { caption?: string }> } | null)?.message ?? {};
  if (m.imageMessage) {
    const label = (m.imageMessage.caption ?? 'Foto').slice(0, 24).replace(/[<&>]/g, '');
    return Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="320" viewBox="0 0 480 320">` +
        `<defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stop-color="#450693"/>` +
        `<stop offset="1" stop-color="#08c8a7"/></linearGradient></defs>` +
        `<rect width="480" height="320" fill="url(#g)"/><text x="240" y="170" font-family="sans-serif" ` +
        `font-size="28" fill="#fff" text-anchor="middle">${label}</text></svg>`,
    );
  }
  if (m.audioMessage) return wavTone(1.2, 440);
  if (m.documentMessage)
    return Buffer.from(
      '%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj ' +
        '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 144]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF',
    );
  throw new Error('sin media');
}

function wavTone(seconds: number, hz: number): Buffer {
  const rate = 8000;
  const n = Math.floor(rate * seconds);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++)
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * 8000), 44 + i * 2);
  return buf;
}

// ---------------------------------------------------------------------------
// Historial falso, determinístico

const FIRST = [
  'Camila',
  'Benjamín',
  'Valentina',
  'Matías',
  'Isidora',
  'Tomás',
  'Florencia',
  'Joaquín',
  'Antonia',
  'Vicente',
  'Josefa',
  'Agustín',
  'Martina',
  'Diego',
  'Catalina',
  'Felipe',
  'Sofía',
  'Cristóbal',
  'Fernanda',
  'Ignacio',
];
const LAST = [
  'González',
  'Muñoz',
  'Rojas',
  'Díaz',
  'Pérez',
  'Soto',
  'Contreras',
  'Silva',
  'Martínez',
  'Sepúlveda',
  'Morales',
  'Rodríguez',
  'López',
  'Fuentes',
  'Hernández',
];
const PHRASES = [
  'Hola! ¿Tienes hora para mañana?',
  'Perfecto, nos vemos a las 18:00 👍',
  '¿Cuánto sale el corte + barba?',
  'Te transfiero ahora',
  'Listo, quedó agendado',
  'jajaja sí',
  'Voy un poco atrasado, 10 min',
  'Gracias!! quedó increíble 🔥',
  '¿Abren el domingo?',
  'Dale, confirmo',
  'Te mando la dirección',
  '¿Me reservas para el viernes?',
  'Ok 👌',
  'Buenísimo, gracias',
];

const GROUPS = [
  'Equipo Barbería 💈',
  'Proveedores insumos',
  'Turnos fin de semana',
  'Clientes VIP',
  'Familia',
  'Socios',
];

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

export function buildFakeHistory(seed = 42): HistoryBatch[] {
  const rand = rng(seed);
  const now = Date.now();
  const twoYears = 2 * 365 * 24 * 3600 * 1000;
  const people = Array.from({ length: 48 }, (_, i) => {
    const phone = `569${String(40000000 + Math.floor(rand() * 59999999)).padStart(8, '0')}`;
    return {
      name: `${FIRST[i % FIRST.length]} ${LAST[Math.floor(rand() * LAST.length)]}`,
      pn: `${phone}@s.whatsapp.net`,
      lid: `${200000000000000 + i * 7919}@lid`,
      // a un tercio solo lo conocemos por LID en los chats
      lidChat: i % 3 === 0,
      weight: rand() ** 3,
    };
  });
  const groups = GROUPS.map((name, i) => ({
    name,
    jid: `1203630${2500000 + i * 37}@g.us`,
    weight: rand() ** 2,
  }));

  const chats = [
    ...people
      .slice(0, 38)
      .map((p) => ({ id: p.lidChat ? p.lid : p.pn, name: null as string | null, p })),
    ...groups.map((g) => ({ id: g.jid, name: g.name, p: null })),
  ];
  const totalWeight = chats.reduce(
    (s, c) => s + (c.p ? c.p.weight : groups.find((g) => g.jid === c.id)!.weight),
    0,
  );

  const messages: HistoryBatch['messages'] = [];
  let n = 0;
  const month = 30 * 24 * 3600 * 1000;
  chats.forEach((c, ci) => {
    const w = c.p ? c.p.weight : groups.find((g) => g.jid === c.id)!.weight;
    const count = Math.max(1, Math.round((w / totalWeight) * 2600));
    for (let k = 0; k < count; k++) {
      const fromMe = rand() < 0.45;
      // los primeros chats tienen actividad reciente (para "Mi vista")
      const recent = ci % 3 !== 2 && k < 14;
      const ts = recent ? now - rand() * 0.7 * month : now - month - rand() ** 0.6 * twoYears;
      const r = rand();
      const message =
        r < 0.08
          ? {
              imageMessage: {
                mimetype: 'image/svg+xml',
                caption: rand() < 0.5 ? 'Así quedó' : '',
                // como en WhatsApp: el archivo de las fotos viejas ya no está en el CDN
                ...(recent ? {} : { expired: true }),
              },
            }
          : r < 0.12
            ? { audioMessage: { mimetype: 'audio/wav', seconds: 1, ptt: true } }
            : r < 0.14
              ? {
                  documentMessage: {
                    mimetype: 'application/pdf',
                    fileName: 'Cotización.pdf',
                    fileLength: 412,
                  },
                }
              : { conversation: PHRASES[Math.floor(rand() * PHRASES.length)]! };
      messages.push({
        key: {
          id: `SIM${(n++).toString(16).toUpperCase()}`,
          remoteJid: c.id,
          ...(c.p?.lidChat ? { remoteJidAlt: c.p.pn } : {}),
          ...(c.id.endsWith('@g.us')
            ? { participant: people[Math.floor(rand() * people.length)]!.pn }
            : {}),
          fromMe,
        } as never,
        message,
        messageTimestamp: Math.floor(ts / 1000),
        pushName: c.p && !fromMe ? c.p.name.split(' ')[0]! : null,
      });
    }
  });
  messages.sort((a, b) => Number(b.messageTimestamp) - Number(a.messageTimestamp));

  const contacts = people.map((p, i) => ({
    id: p.pn,
    lid: p.lid,
    phoneNumber: p.pn,
    // a algunos no los tienes guardados: solo sabemos el nombre que se pusieron en WhatsApp
    name: i % 7 === 6 ? null : p.name,
    notify: p.name.split(' ')[0]!,
    ...(i % 11 === 5 ? { verifiedName: `${p.name.split(' ')[1]} Spa` } : {}),
  }));
  const chatObjs = chats.map((c) => ({
    id: c.id,
    name: c.name,
    conversationTimestamp: Math.floor(now / 1000),
  }));

  // 5 lotes: el primero (bootstrap) con chats y contactos, luego mensajes por partes
  const parts = 5;
  const size = Math.ceil(messages.length / parts);
  return Array.from({ length: parts }, (_, i) => ({
    chats: i === 0 ? chatObjs : [],
    contacts: i === 0 ? contacts : [],
    messages: messages.slice(i * size, (i + 1) * size),
    lidPnMappings:
      i === 0
        ? people.filter((p) => p.lidChat && p.weight > 0.2).map((p) => ({ lid: p.lid, pn: p.pn }))
        : [],
    progress: Math.round(((i + 1) / parts) * 100),
    syncType: i === 0 ? 0 : 2,
    isLatest: i === 0,
  }));
}
