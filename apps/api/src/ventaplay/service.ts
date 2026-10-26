import type { Logger } from 'pino';
import type {
  VentaPlayCounts,
  VentaPlayOrg,
  VentaPlayPrevious,
  VentaPlaySaved,
  VentaPlayState,
  VentaPlayValidateRequest,
} from '@wa-bridge/shared';
import { HttpError } from '../session/errors.js';
import type { StoredMessage } from '../session/message-vault.js';
import type { Directory } from '../session/stats.js';
import {
  buildItems,
  importIdFor,
  type ClientItem,
  type MessageItem,
  type MigrationItems,
} from './plan.js';

/** APIs de VentaPlay (Supabase Edge Functions) */
export const VENTAPLAY_API_URL = 'https://uklfdugabopbuqmpoiao.supabase.co/functions/v1';
/** máximo de items por llamada que aceptan las APIs import-* */
export const BATCH = 500;
/** primeros clientes reales: si alguno falla, se detiene todo antes de cargar el resto */
export const CANARY = 5;

/** lo que el servicio necesita de una sesión de WhatsApp */
export interface MigrationSessionLike {
  summary(): {
    profile: { phone?: string | null; name?: string | null } | null;
    label: string | null;
    stats: { state: string };
  };
  directory(): Promise<Directory>;
  readonly isMigrating: boolean;
  migrationChats(): { jid: string; messages: StoredMessage[] }[];
  /** token y registro, cifrados junto a las credenciales de la sesión */
  readVentaPlay(key: string): Promise<string | null>;
  writeVentaPlay(entries: Record<string, string | null>): Promise<void>;
  listVentaPlay(prefix: string): Promise<string[]>;
}

/** claves en el almacén cifrado de la sesión */
export const LINK_KEY = 'ventaplay:link';
export const SENT_KEY = (org: string) => `ventaplay:sent:${org}`;
/** cada cuántos lotes se guarda el registro de lo enviado (y siempre al terminar o cortarse) */
const SAVE_EVERY = 5;

/** org conectada: el token queda guardado para "Actualizar" sin pegarlo de nuevo */
interface Link {
  token: string;
  phoneNumberId: string | null;
  org: VentaPlayOrg;
  savedAt: number;
}

/** registro de lo que VentaPlay ya aceptó para una org (external_id sin el prefijo común) */
interface Registry {
  org: string;
  /** nombre de la org, para mostrarlo aunque no haya token guardado */
  orgName: string | null;
  prefix: string;
  clients: Set<string>;
  messages: Set<string>;
  lastSyncAt: number | null;
  dirty: boolean;
}

const orgKey = (org: VentaPlayOrg) => org.id ?? org.subdominio ?? org.nombre;

export interface VentaPlayDeps {
  getSession: (id: string) => MigrationSessionLike;
  logger: Logger;
  fetch?: typeof fetch;
  baseUrl?: string;
  /** espera entre reintentos (tests: 0) */
  retryDelayMs?: number;
}

interface ApiResult {
  external_id?: string;
  status?: string;
  code?: string | null;
  detalle?: string | null;
  motivo?: string | null;
}

interface ApiResponse {
  success?: boolean;
  code?: string;
  error?: string;
  resultados?: ApiResult[];
  organizacion?: { id?: string; nombre?: string; subdominio?: string | null };
}

class VpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface Job {
  token: string;
  /** registro de la org (se completa con lo que VentaPlay acepta) */
  registry: Registry | null;
  batchesSinceSave: number;
  state: VentaPlayState;
  items: MigrationItems;
  /** estado que anticipó la prueba en seco, por external_id */
  predicted: Map<string, string>;
  /** clientes que VentaPlay aceptó (sus mensajes se pueden importar) */
  okClients: Set<string>;
  cursor: { clients: number; messages: number };
  running: boolean;
  /** fallaron los 5 de prueba: no se puede retomar, hay que revisar y validar de nuevo */
  blocked: boolean;
  /** los primeros mensajes ya entraron bien */
  messagesProven: boolean;
}

const zero = (): VentaPlayCounts => ({ created: 0, updated: 0, skipped: 0, errors: 0 });

const idle = (): VentaPlayState => ({
  phase: 'idle',
  org: null,
  phoneNumberId: null,
  importId: null,
  plan: null,
  step: null,
  progress: { clientes: { done: 0, total: 0 }, mensajes: { done: 0, total: 0 } },
  result: { clientes: zero(), mensajes: zero(), codes: [] },
  error: null,
  pausedReason: null,
  canResume: false,
  saved: null,
  previous: [],
  validatedAt: null,
  startedAt: null,
  finishedAt: null,
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * "Directo a VentaPlay": valida la API key de la org, hace una prueba en seco y después
 * importa clientes y mensajes por lotes. El token se guarda cifrado junto a la sesión
 * (para "Actualizar" con un clic) y nunca se loguea. Un registro de lo que VentaPlay ya
 * aceptó permite mandar después solo lo nuevo.
 */
export class VentaPlayService {
  private jobs = new Map<string, Job>();
  private links = new Map<string, Link | null>();
  private registries = new Map<string, Registry>();
  private readonly fetchFn: typeof fetch;
  private readonly baseUrl: string;
  private readonly retryDelayMs: number;

  constructor(private readonly deps: VentaPlayDeps) {
    this.fetchFn = deps.fetch ?? fetch;
    this.baseUrl = (deps.baseUrl ?? VENTAPLAY_API_URL).replace(/\/$/, '');
    this.retryDelayMs = deps.retryDelayMs ?? 4000;
  }

  async state(id: string): Promise<VentaPlayState> {
    const job = this.jobs.get(id);
    const st = job ? structuredClone(job.state) : idle();
    if (job)
      st.canResume =
        !job.running &&
        !job.blocked &&
        Boolean(st.plan?.filas) &&
        (st.phase === 'validated' || st.phase === 'paused' || st.phase === 'error');
    st.saved = await this.savedInfo(id);
    st.previous = st.saved ? [] : await this.previousInfo(id);
    return st;
  }

  /**
   * Cierra la importación mostrada. Con `token: true` además borra el token guardado
   * (el registro de lo enviado se conserva: sirve si después se conecta de nuevo).
   */
  async forget(id: string, opts: { token?: boolean } = {}): Promise<VentaPlayState> {
    const job = this.jobs.get(id);
    if (job?.running) throw new HttpError(409, 'importing', 'Hay una importación en curso');
    this.jobs.delete(id);
    if (opts.token) {
      await this.deps.getSession(id).writeVentaPlay({ [LINK_KEY]: null });
      this.links.set(id, null);
      this.deps.logger.info({ session: id }, 'VentaPlay: token olvidado');
    }
    return this.state(id);
  }

  /**
   * Marca como ya enviado lo importado antes de existir el registro: clientes cuyo primer
   * mensaje es anterior a `until` (o sin mensajes) y sus mensajes hasta `until`.
   */
  async seed(
    id: string,
    org: string,
    until: number,
    orgName: string | null = null,
  ): Promise<{ clientes: number; mensajes: number }> {
    const session = this.deps.getSession(id);
    const summary = session.summary();
    const sessionPhone = (summary.profile?.phone ?? '').replace(/\D/g, '');
    if (!sessionPhone || !session.isMigrating)
      throw new HttpError(409, 'not_ready', 'La sesión no está vinculada en modo migración');
    const items = buildItems(
      {
        sessionPhone,
        sessionName: summary.profile?.name ?? summary.label,
        directory: await session.directory(),
        chats: session.migrationChats(),
      },
      null,
    );
    const reg = await this.registry(id, org, sessionPhone);
    let clientes = 0;
    let mensajes = 0;
    const ok = new Set<string>();
    for (const c of items.clients)
      if (!c.created_at || Date.parse(c.created_at) <= until) {
        ok.add(c.external_id);
        if (this.mark(reg, 'clients', c.external_id)) clientes += 1;
      }
    for (const m of items.messages)
      if (ok.has(m.cliente_external_id) && Date.parse(m.created_at) <= until)
        if (this.mark(reg, 'messages', m.external_id)) mensajes += 1;
    reg.lastSyncAt ??= until;
    if (orgName && reg.orgName !== orgName) {
      reg.orgName = orgName;
      reg.dirty = true;
    }
    await this.saveRegistry(id, reg);
    this.deps.logger.info({ session: id, clientes, mensajes }, 'VentaPlay: registro inicial');
    return { clientes, mensajes };
  }

  async validate(id: string, req: VentaPlayValidateRequest): Promise<VentaPlayState> {
    const prev = this.jobs.get(id);
    if (prev?.running) throw new HttpError(409, 'importing', 'Hay una importación en curso');
    const session = this.deps.getSession(id);
    const summary = session.summary();
    const sessionPhone = (summary.profile?.phone ?? '').replace(/\D/g, '');
    if (!sessionPhone)
      throw new HttpError(409, 'not_linked', 'Primero vincula el WhatsApp: no sé de qué número es');
    const saved = await this.link(id);
    const typed = req.token?.trim() || null;
    const token = typed ?? saved?.token ?? null;
    if (!token) throw new HttpError(400, 'no_token', 'Pega la API key de la organización');
    // el phone_number_id guardado vale solo si se usa el token guardado
    const phoneNumberId =
      req.phoneNumberId?.trim() || (typed ? null : (saved?.phoneNumberId ?? null)) || null;

    const state = idle();
    state.phase = 'validating';
    const job: Job = {
      token,
      registry: null,
      batchesSinceSave: 0,
      state,
      items: {
        clients: [],
        messages: [],
        sinNumero: 0,
        grupos: 0,
        chatsConMensajes: 0,
        mensajesFuera: 0,
      },
      predicted: new Map(),
      okClients: new Set(),
      cursor: { clients: 0, messages: 0 },
      running: false,
      blocked: false,
      messagesProven: false,
    };
    this.jobs.set(id, job);
    try {
      const org = await this.organization(token);
      // la key es válida: queda guardada (cifrada) para "Actualizar"
      const link: Link = { token, phoneNumberId, org, savedAt: Date.now() };
      await session.writeVentaPlay({ [LINK_KEY]: JSON.stringify(link) });
      this.links.set(id, link);
      const reg = await this.registryFor(id, org, sessionPhone);
      if (reg.orgName !== org.nombre) {
        reg.orgName = org.nombre;
        reg.dirty = true;
      }
      job.registry = reg;
      const mode = req.mode ?? (reg.clients.size || reg.messages.size ? 'actualizar' : 'completo');
      const chats = session.isMigrating ? session.migrationChats() : null;
      job.items = buildItems(
        {
          sessionPhone,
          sessionName: summary.profile?.name ?? summary.label,
          directory: await session.directory(),
          chats,
        },
        phoneNumberId,
      );
      if (mode === 'actualizar') {
        // solo lo que VentaPlay no ha aceptado antes; los clientes ya enviados sirven
        // para que entren sus mensajes nuevos
        job.items.clients = job.items.clients.filter(
          (c) => !reg.clients.has(this.short(reg, c.external_id)),
        );
        job.items.messages = job.items.messages.filter(
          (m) => !reg.messages.has(this.short(reg, m.external_id)),
        );
        for (const c of reg.clients) job.okClients.add(reg.prefix + c);
      }
      state.org = org;
      state.phoneNumberId = phoneNumberId;
      state.importId = importIdFor(sessionPhone);

      // prueba en seco de los clientes: cuántos se crean y cuántos ya existen
      let nuevos = 0;
      let existentes = 0;
      const codes = new Map<string, { code: string; detalle: string; n: number }>();
      for (let k = 0; k < job.items.clients.length; k += BATCH) {
        const batch = job.items.clients.slice(k, k + BATCH);
        const res = await this.importBatch(token, 'import-clients', state.importId, true, batch);
        for (const r of res.resultados ?? []) {
          if (r.external_id && r.status) job.predicted.set(r.external_id, r.status);
          if (r.status === 'created') nuevos += 1;
          else if (r.status === 'updated' || r.status === 'skipped' || r.status === 'linked')
            existentes += 1;
          else if (r.status === 'error') addCode(codes, r);
        }
      }
      state.result.codes = [...codes.values()];
      state.plan = {
        clientes: job.items.clients.length,
        nuevos,
        existentes,
        sinNumero: job.items.sinNumero,
        grupos: job.items.grupos,
        mensajes: job.items.messages.length,
        chatsConMensajes: job.items.chatsConMensajes,
        mensajesFuera: job.items.mensajesFuera,
        soloContactos: chats === null,
        historialCompleto: summary.stats.state === 'complete',
        filas: job.items.clients.length + job.items.messages.length,
        modo: mode,
        yaEnviados: { clientes: reg.clients.size, mensajes: reg.messages.size },
      };
      state.progress = {
        clientes: { done: 0, total: job.items.clients.length },
        mensajes: { done: 0, total: job.items.messages.length },
      };
      state.phase = state.plan.filas ? 'validated' : 'done';
      state.validatedAt = Date.now();
      if (!state.plan.filas) state.finishedAt = state.validatedAt;
      this.deps.logger.info(
        { session: id, org: org.subdominio, plan: state.plan },
        'VentaPlay: validado (prueba en seco)',
      );
    } catch (err) {
      state.phase = 'error';
      state.error = (err as Error).message;
      this.deps.logger.warn(
        { session: id, code: (err as VpError).code },
        'VentaPlay: validación falló',
      );
    }
    return this.state(id);
  }

  // ------------------------------------------------------------ token y registro

  private async link(id: string): Promise<Link | null> {
    if (this.links.has(id)) return this.links.get(id) ?? null;
    let link: Link | null;
    try {
      const raw = await this.deps.getSession(id).readVentaPlay(LINK_KEY);
      link = raw ? (JSON.parse(raw) as Link) : null;
    } catch {
      link = null;
    }
    this.links.set(id, link);
    return link;
  }

  private async registry(id: string, org: string, sessionPhone: string): Promise<Registry> {
    const key = `${id}|${org}`;
    const cached = this.registries.get(key);
    if (cached) return cached;
    const prefix = `wabridge:${sessionPhone}:`;
    const reg: Registry = {
      org,
      orgName: null,
      prefix,
      clients: new Set(),
      messages: new Set(),
      lastSyncAt: null,
      dirty: false,
    };
    try {
      const raw = await this.deps.getSession(id).readVentaPlay(SENT_KEY(org));
      if (raw) {
        const d = JSON.parse(raw) as {
          prefix?: string;
          clients?: string[];
          messages?: string[];
          lastSyncAt?: number | null;
          orgName?: string | null;
        };
        if (d.prefix === prefix) {
          for (const c of d.clients ?? []) reg.clients.add(c);
          for (const m of d.messages ?? []) reg.messages.add(m);
          reg.lastSyncAt = d.lastSyncAt ?? null;
          reg.orgName = d.orgName ?? null;
        }
      }
    } catch {
      /* registro dañado: se parte de cero (repetir no duplica en VentaPlay) */
    }
    this.registries.set(key, reg);
    return reg;
  }

  /**
   * Registro de una org: se busca por id y, por si acaso, por subdominio o nombre (p. ej.
   * un registro inicial hecho con otra llave). Lo encontrado queda bajo la llave principal.
   */
  private async registryFor(id: string, org: VentaPlayOrg, phone: string): Promise<Registry> {
    const main = await this.registry(id, orgKey(org), phone);
    if (main.clients.size || main.messages.size) return main;
    for (const alt of [org.id, org.subdominio, org.nombre]) {
      if (!alt || alt === main.org) continue;
      const other = await this.registry(id, alt, phone);
      if (!other.clients.size && !other.messages.size) continue;
      for (const c of other.clients) main.clients.add(c);
      for (const m of other.messages) main.messages.add(m);
      main.lastSyncAt = other.lastSyncAt;
      main.dirty = true;
      await this.saveRegistry(id, main);
      break;
    }
    return main;
  }

  private short(reg: Registry, externalId: string): string {
    return externalId.startsWith(reg.prefix) ? externalId.slice(reg.prefix.length) : externalId;
  }

  private mark(reg: Registry, kind: 'clients' | 'messages', externalId: string): boolean {
    const k = this.short(reg, externalId);
    if (reg[kind].has(k)) return false;
    reg[kind].add(k);
    reg.dirty = true;
    return true;
  }

  private async saveRegistry(id: string, reg: Registry): Promise<void> {
    if (!reg.dirty) return;
    reg.dirty = false;
    try {
      await this.deps.getSession(id).writeVentaPlay({
        [SENT_KEY(reg.org)]: JSON.stringify({
          prefix: reg.prefix,
          clients: [...reg.clients],
          messages: [...reg.messages],
          lastSyncAt: reg.lastSyncAt,
          orgName: reg.orgName,
        }),
      });
    } catch (err) {
      reg.dirty = true;
      this.deps.logger.warn(
        { session: id, err: (err as Error).message },
        'VentaPlay: no se guardó el registro',
      );
    }
  }

  /**
   * Lo ya enviado a cada org aunque no haya token guardado (p. ej. importado antes de que
   * existiera "Actualizar"): así la pantalla no parece vacía y se sabe que validar con la
   * key de esa org va a mandar solo lo nuevo.
   */
  private async previousInfo(id: string): Promise<VentaPlayPrevious[]> {
    const session = this.deps.getSession(id);
    const phone = (session.summary().profile?.phone ?? '').replace(/\D/g, '');
    if (!phone) return [];
    let keys: string[];
    try {
      keys = await session.listVentaPlay(SENT_KEY(''));
    } catch {
      return [];
    }
    const out: VentaPlayPrevious[] = [];
    for (const k of keys) {
      const reg = await this.registry(id, k.slice(SENT_KEY('').length), phone);
      if (!reg.clients.size && !reg.messages.size) continue;
      out.push({
        org: reg.org,
        orgName: reg.orgName,
        clientes: reg.clients.size,
        mensajes: reg.messages.size,
        lastSyncAt: reg.lastSyncAt,
      });
    }
    return out;
  }

  private async savedInfo(id: string): Promise<VentaPlaySaved | null> {
    let link: Link | null;
    try {
      link = await this.link(id);
    } catch {
      return null;
    }
    if (!link) return null;
    const phone = (this.deps.getSession(id).summary().profile?.phone ?? '').replace(/\D/g, '');
    const reg = phone ? await this.registryFor(id, link.org, phone) : null;
    return {
      org: link.org,
      phoneNumberId: link.phoneNumberId,
      savedAt: link.savedAt,
      enviados: { clientes: reg?.clients.size ?? 0, mensajes: reg?.messages.size ?? 0 },
      lastSyncAt: reg?.lastSyncAt ?? null,
    };
  }

  /** arranca (o retoma) la importación en segundo plano */
  async start(id: string): Promise<VentaPlayState> {
    const job = this.jobs.get(id);
    if (!job || !job.state.plan || !job.state.importId)
      throw new HttpError(409, 'not_validated', 'Primero valida el token de la organización');
    if (job.running) return this.state(id);
    if (job.state.phase === 'done') return this.state(id);
    if (job.blocked)
      throw new HttpError(
        409,
        'canary_failed',
        'Fallaron los clientes de prueba: revisa los errores y vuelve a validar',
      );
    job.running = true;
    job.state.phase = 'importing';
    job.state.error = null;
    job.state.pausedReason = null;
    if (!job.state.startedAt) job.state.result.codes = [];
    job.state.startedAt ??= Date.now();
    void this.run(id, job).finally(() => {
      job.running = false;
    });
    return this.state(id);
  }

  // -------------------------------------------------------------------- interno

  private async run(id: string, job: Job): Promise<void> {
    const { state, items, token } = job;
    const importId = state.importId!;
    try {
      // 1) canario + clientes
      while (job.cursor.clients < items.clients.length) {
        const canary = job.cursor.clients < CANARY;
        state.step = canary ? 'canario' : 'clientes';
        const end = canary ? CANARY : job.cursor.clients + BATCH;
        const batch = items.clients
          .slice(job.cursor.clients, end)
          .map((c) =>
            job.predicted.get(c.external_id) === 'created'
              ? { ...c, valores_especiales: [] as [] }
              : c,
          );
        let res = await this.importBatch(token, 'import-clients', importId, false, batch);
        res = await this.retryValoresEspeciales(token, importId, batch, res);
        const failed = this.tally(state.result.clientes, state, res, (r) => {
          if (r.external_id && r.status !== 'error') {
            job.okClients.add(r.external_id);
            if (job.registry) this.mark(job.registry, 'clients', r.external_id);
          }
        });
        await this.maybeSave(id, job);
        job.cursor.clients += batch.length;
        state.progress.clientes.done = job.cursor.clients;
        if (canary && failed) {
          job.blocked = true;
          state.phase = 'error';
          state.error =
            'Fallaron clientes de prueba: no se cargó el resto. Revisa los errores antes de seguir.';
          return;
        }
      }
      // 2) mensajes de los clientes que quedaron en VentaPlay
      state.step = 'mensajes';
      const msgs = items.messages;
      while (job.cursor.messages < msgs.length) {
        // el cursor avanza recién cuando VentaPlay aceptó el lote: si se corta o se
        // agota el cupo, al retomar se vuelve a mandar el mismo lote (no se pierde nada)
        // los primeros mensajes también van de prueba: si fallan todos, se detiene
        // antes de gastar el cupo en miles de mensajes que no entrarían
        const canary = !job.messagesProven;
        state.step = canary ? 'canario' : 'mensajes';
        const size = canary ? CANARY : BATCH;
        const batch: MessageItem[] = [];
        let skipped = 0;
        let next = job.cursor.messages;
        while (next < msgs.length && batch.length < size) {
          const m = msgs[next]!;
          next += 1;
          if (job.okClients.has(m.cliente_external_id)) batch.push(m);
          else skipped += 1;
        }
        let failed = 0;
        if (batch.length) {
          const res = await this.importBatch(token, 'import-messages', importId, false, batch);
          failed = this.tally(state.result.mensajes, state, res, (r) => {
            if (r.external_id && r.status !== 'error' && job.registry)
              this.mark(job.registry, 'messages', r.external_id);
          });
          await this.maybeSave(id, job);
        }
        state.result.mensajes.skipped += skipped;
        job.cursor.messages = next;
        state.progress.mensajes.done = next;
        if (canary && batch.length) {
          if (failed === batch.length) {
            job.blocked = true;
            state.phase = 'error';
            state.error =
              'Fallaron los mensajes de prueba: no se cargó el resto. Revisa los errores antes de seguir.';
            return;
          }
          job.messagesProven = true;
        }
      }
      state.step = null;
      state.phase = 'done';
      state.finishedAt = Date.now();
      if (job.registry) {
        job.registry.lastSyncAt = state.finishedAt;
        job.registry.dirty = true;
      }
      this.deps.logger.info(
        { session: id, importId, clientes: state.result.clientes, mensajes: state.result.mensajes },
        'VentaPlay: importación terminada',
      );
    } catch (err) {
      const e = err as VpError;
      if (e.code === 'IMPORT_RATE_LIMITED' || e.status === 429) {
        state.phase = 'paused';
        state.pausedReason =
          'Se agotó el cupo diario de VentaPlay. Lo cargado quedó guardado: vuelve a apretar Importar mañana o pide una excepción de cupo.';
      } else {
        state.phase = 'error';
        state.error = e.message;
      }
      this.deps.logger.warn(
        { session: id, importId, code: e.code, step: state.step },
        'VentaPlay: importación detenida',
      );
    } finally {
      // se libera antes de guardar: "Retomar" no debe esperar a que termine de escribir
      job.running = false;
      // lo aceptado queda registrado aunque se corte: al retomar o actualizar no se repite
      if (job.registry) await this.saveRegistry(id, job.registry);
    }
  }

  private async maybeSave(id: string, job: Job): Promise<void> {
    job.batchesSinceSave += 1;
    if (job.registry && job.batchesSinceSave >= SAVE_EVERY) {
      job.batchesSinceSave = 0;
      await this.saveRegistry(id, job.registry);
    }
  }

  /** import-clients v14: si un cliente nuevo falló por valores_especiales NULL, se reintenta con [] */
  private async retryValoresEspeciales(
    token: string,
    importId: string,
    batch: ClientItem[],
    res: ApiResponse,
  ): Promise<ApiResponse> {
    const bad = new Set(
      (res.resultados ?? [])
        .filter((r) => r.status === 'error' && /valores_especiales/.test(r.detalle ?? ''))
        .map((r) => r.external_id),
    );
    if (!bad.size) return res;
    const again = batch
      .filter((c) => bad.has(c.external_id))
      .map((c) => ({ ...c, valores_especiales: [] as [] }));
    const res2 = await this.importBatch(token, 'import-clients', importId, false, again);
    const fixed = new Map((res2.resultados ?? []).map((r) => [r.external_id, r]));
    return {
      ...res,
      resultados: (res.resultados ?? []).map((r) => fixed.get(r.external_id) ?? r),
    };
  }

  /** suma resultados; devuelve cuántos fallaron */
  private tally(
    counts: VentaPlayCounts,
    state: VentaPlayState,
    res: ApiResponse,
    each?: (r: ApiResult) => void,
  ): number {
    let failed = 0;
    const codes = new Map(state.result.codes.map((c) => [`${c.code}|${c.detalle}`, c]));
    for (const r of res.resultados ?? []) {
      if (r.status === 'created') counts.created += 1;
      else if (r.status === 'updated' || r.status === 'linked') counts.updated += 1;
      else if (r.status === 'skipped') counts.skipped += 1;
      else {
        counts.errors += 1;
        failed += 1;
        addCode(codes, r);
      }
      each?.(r);
    }
    state.result.codes = [...codes.values()].sort((a, b) => b.n - a.n).slice(0, 20);
    return failed;
  }

  private async organization(token: string): Promise<VentaPlayOrg> {
    const res = await this.post(token, 'get-organizations', {});
    const o = res.organizacion;
    if (!o?.nombre) throw new VpError(502, 'bad_response', 'VentaPlay no devolvió la organización');
    return { id: o.id ?? null, nombre: o.nombre, subdominio: o.subdominio ?? null };
  }

  private importBatch(
    token: string,
    endpoint: 'import-clients' | 'import-messages',
    importId: string,
    dryRun: boolean,
    items: (ClientItem | MessageItem)[],
  ): Promise<ApiResponse> {
    return this.post(token, endpoint, {
      import_id: importId,
      dry_run: dryRun,
      preservar_fechas: true,
      ...(endpoint === 'import-clients'
        ? { on_conflict: 'enrich', llave_dedup: 'auto' }
        : { on_conflict: 'skip' }),
      items,
    });
  }

  /** POST con reintentos para caídas de red y 5xx; nunca loguea el token */
  private async post(token: string, endpoint: string, body: unknown): Promise<ApiResponse> {
    let last: VpError | null = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt) await sleep(this.retryDelayMs * attempt);
      let status: number;
      let data: ApiResponse;
      try {
        const r = await this.fetchFn(`${this.baseUrl}/${endpoint}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(170_000),
        });
        status = r.status;
        data = (await r.json().catch(() => ({}))) as ApiResponse;
      } catch {
        last = new VpError(0, 'network', 'No pude conectar con VentaPlay');
        continue;
      }
      if (status === 401 || status === 403 || (status === 404 && endpoint === 'get-organizations'))
        throw new VpError(
          status,
          'UNAUTHORIZED',
          'La API key no es válida para ninguna organización',
        );
      if (data.code === 'IMPORT_RATE_LIMITED' || status === 429)
        throw new VpError(429, 'IMPORT_RATE_LIMITED', 'Cupo diario de VentaPlay agotado');
      if (status >= 500) {
        last = new VpError(status, data.code ?? 'server', `VentaPlay respondió ${status}`);
        continue;
      }
      if (status >= 400 || data.success === false)
        throw new VpError(
          status,
          data.code ?? 'bad_request',
          `VentaPlay rechazó ${endpoint}: ${(data.error ?? `error ${status}`).slice(0, 200)}`,
        );
      return data;
    }
    throw last ?? new VpError(0, 'network', 'No pude conectar con VentaPlay');
  }
}

function addCode(codes: Map<string, { code: string; detalle: string; n: number }>, r: ApiResult) {
  const code = r.code ?? r.status ?? 'error';
  const detalle = (r.detalle ?? r.motivo ?? '').slice(0, 90);
  const key = `${code}|${detalle}`;
  const cur = codes.get(key);
  if (cur) cur.n += 1;
  else codes.set(key, { code, detalle, n: 1 });
}
