import type { Logger } from 'pino';
import type {
  VentaPlayCounts,
  VentaPlayOrg,
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
}

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
  validatedAt: null,
  startedAt: null,
  finishedAt: null,
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * "Directo a VentaPlay": valida la API key de la org, hace una prueba en seco y después
 * importa clientes y mensajes por lotes. El token vive solo en memoria y nunca se loguea.
 */
export class VentaPlayService {
  private jobs = new Map<string, Job>();
  private readonly fetchFn: typeof fetch;
  private readonly baseUrl: string;
  private readonly retryDelayMs: number;

  constructor(private readonly deps: VentaPlayDeps) {
    this.fetchFn = deps.fetch ?? fetch;
    this.baseUrl = (deps.baseUrl ?? VENTAPLAY_API_URL).replace(/\/$/, '');
    this.retryDelayMs = deps.retryDelayMs ?? 4000;
  }

  state(id: string): VentaPlayState {
    const job = this.jobs.get(id);
    if (!job) return idle();
    const st = structuredClone(job.state);
    st.canResume =
      !job.running &&
      !job.blocked &&
      Boolean(st.plan) &&
      (st.phase === 'validated' || st.phase === 'paused' || st.phase === 'error');
    return st;
  }

  /** olvida el token y el estado de la importación */
  forget(id: string): VentaPlayState {
    const job = this.jobs.get(id);
    if (job?.running) throw new HttpError(409, 'importing', 'Hay una importación en curso');
    this.jobs.delete(id);
    return idle();
  }

  async validate(id: string, req: VentaPlayValidateRequest): Promise<VentaPlayState> {
    const prev = this.jobs.get(id);
    if (prev?.running) throw new HttpError(409, 'importing', 'Hay una importación en curso');
    const token = req.token.trim();
    const session = this.deps.getSession(id);
    const summary = session.summary();
    const sessionPhone = (summary.profile?.phone ?? '').replace(/\D/g, '');
    if (!sessionPhone)
      throw new HttpError(409, 'not_linked', 'Primero vincula el WhatsApp: no sé de qué número es');

    const state = idle();
    state.phase = 'validating';
    const job: Job = {
      token,
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
    };
    this.jobs.set(id, job);
    try {
      const org = await this.organization(token);
      const phoneNumberId = req.phoneNumberId?.trim() || null;
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
      };
      state.progress = {
        clientes: { done: 0, total: job.items.clients.length },
        mensajes: { done: 0, total: job.items.messages.length },
      };
      state.phase = 'validated';
      state.validatedAt = Date.now();
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

  /** arranca (o retoma) la importación en segundo plano */
  start(id: string): VentaPlayState {
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
          if (r.external_id && r.status !== 'error') job.okClients.add(r.external_id);
        });
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
        const batch: MessageItem[] = [];
        let skipped = 0;
        let next = job.cursor.messages;
        while (next < msgs.length && batch.length < BATCH) {
          const m = msgs[next]!;
          next += 1;
          if (job.okClients.has(m.cliente_external_id)) batch.push(m);
          else skipped += 1;
        }
        if (batch.length) {
          const res = await this.importBatch(token, 'import-messages', importId, false, batch);
          this.tally(state.result.mensajes, state, res);
        }
        state.result.mensajes.skipped += skipped;
        job.cursor.messages = next;
        state.progress.mensajes.done = next;
      }
      state.step = null;
      state.phase = 'done';
      state.finishedAt = Date.now();
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
