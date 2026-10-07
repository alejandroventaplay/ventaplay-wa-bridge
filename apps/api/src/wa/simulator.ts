import { EventEmitter } from 'node:events';
import type { BaileysEventMap, WABusinessProfile } from 'baileys';
import type { HistoryBatch } from '../session/stats.js';
import type { SocketFactory, SocketFactoryOptions, WaSocketLike } from './types.js';

/**
 * Simulador de WhatsApp para desarrollar la UI sin un teléfono (WA_DRIVER=simulator).
 * Emite QRs que rotan, permite "escanear" vía POST /sessions/:id/simulate-scan
 * y luego entrega un historial falso en lotes, como lo haría WhatsApp.
 * Jamás se usa en producción (config.ts lo impide).
 */

const DEMO_JID = '56912345678@s.whatsapp.net';
const DEMO_LID = '118477331234567@lid';

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
  };
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
  for (const c of chats) {
    const w = c.p ? c.p.weight : groups.find((g) => g.jid === c.id)!.weight;
    const count = Math.max(1, Math.round((w / totalWeight) * 2600));
    for (let k = 0; k < count; k++) {
      const fromMe = rand() < 0.45;
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
        message: { conversation: 'hola' },
        messageTimestamp: Math.floor((now - rand() ** 0.6 * twoYears) / 1000),
        pushName: c.p && !fromMe ? c.p.name.split(' ')[0]! : null,
      });
    }
  }
  messages.sort((a, b) => Number(b.messageTimestamp) - Number(a.messageTimestamp));

  const contacts = people.map((p) => ({ id: p.pn, lid: p.lid, phoneNumber: p.pn, name: p.name }));
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
