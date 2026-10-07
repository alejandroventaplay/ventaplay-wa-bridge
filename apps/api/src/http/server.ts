import cors from '@fastify/cors';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { SessionStreamEvent, SessionSummary } from '@wa-bridge/shared';
import type { Config } from '../config.js';
import { HttpError, type SessionManager } from '../session/manager.js';
import type { Simulator } from '../wa/simulator.js';
import type { Authenticator, Principal } from './auth.js';

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }
}

export interface ServerDeps {
  config: Config;
  manager: SessionManager;
  auth: Authenticator;
  logger: Logger;
  storageKind: 'file' | 'postgres';
  simulator?: Simulator | null;
}

const IdParams = z.object({ id: z.string().uuid() });
const CreateBody = z.object({ label: z.string().trim().max(80).nullish() }).nullish();
const HEARTBEAT_MS = 20_000;

export async function buildServer(deps: ServerDeps) {
  const { config, manager, auth } = deps;
  const app = Fastify({
    loggerInstance: deps.logger,
  });
  /** streams SSE abiertos: se cierran al apagar, si no app.close() queda esperando */
  const streams = new Set<import('node:http').ServerResponse>();
  app.addHook('preClose', async () => {
    for (const res of streams) res.end();
    streams.clear();
  });

  await app.register(cors, {
    origin: config.webOrigins.includes('*') ? true : config.webOrigins,
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type'],
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.statusCode).send({ error: err.code, message: err.message });
    }
    if (err instanceof z.ZodError) {
      return reply
        .status(400)
        .send({ error: 'bad_request', message: err.issues.map((i) => i.message).join('; ') });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) req.log.error({ err }, 'error no controlado');
    return reply.status(status).send({
      error: status >= 500 ? 'internal' : 'bad_request',
      message: status >= 500 ? 'Error interno' : (err as Error).message,
    });
  });

  // ----------------------------------------------------------- públicas

  app.get('/health', async () => ({
    ok: true,
    service: 'ventaplay-wa-bridge',
    driver: config.WA_DRIVER,
    storage: deps.storageKind,
    auth: auth.mode,
    readOnly: true,
  }));

  // ----------------------------------------------------------- protegidas

  app.register(async (api) => {
    api.addHook('onRequest', async (req, reply) => {
      if (req.method === 'OPTIONS') return;
      const principal = await auth.authenticate(req);
      if (!principal) {
        return reply
          .status(401)
          .send({ error: 'unauthorized', message: 'Inicia sesión para continuar' });
      }
      req.principal = principal;
    });

    api.get('/me', async (req) => ({ principal: req.principal }));

    api.get('/sessions', async () => ({ sessions: manager.list() }));

    api.post('/sessions', async (req, reply) => {
      const body = CreateBody.parse(req.body ?? null);
      const session = await manager.create(body?.label ?? null);
      req.log.info(
        { session: session.id, by: req.principal?.email ?? req.principal?.sub },
        'sesión creada',
      );
      return reply.status(201).send({ session });
    });

    api.get('/sessions/:id', async (req) => {
      const { id } = IdParams.parse(req.params);
      return { session: manager.get(id).summary() };
    });

    api.post('/sessions/:id/connect', async (req) => {
      const { id } = IdParams.parse(req.params);
      return { session: await manager.connect(id) };
    });

    api.post('/sessions/:id/logout', async (req) => {
      const { id } = IdParams.parse(req.params);
      req.log.info(
        { session: id, by: req.principal?.email ?? req.principal?.sub },
        'desvinculando',
      );
      return { session: await manager.logout(id) };
    });

    api.delete('/sessions/:id', async (req, reply) => {
      const { id } = IdParams.parse(req.params);
      req.log.info(
        { session: id, by: req.principal?.email ?? req.principal?.sub },
        'eliminando sesión',
      );
      await manager.remove(id);
      return reply.status(204).send();
    });

    /** Stream en vivo de UNA sesión: QR que rota, estado, progreso del sync. */
    api.get('/sessions/:id/events', async (req, reply) => {
      const { id } = IdParams.parse(req.params);
      const session = manager.get(id);
      const send = openSse(req, reply, streams);
      send({ type: 'snapshot', session: session.summary() });
      const onUpdate = (s: SessionSummary) => s.id === id && send({ type: 'snapshot', session: s });
      const onDeleted = (deletedId: string) => deletedId === id && send({ type: 'deleted', id });
      manager.on('update', onUpdate);
      manager.on('deleted', onDeleted);
      req.raw.on('close', () => {
        manager.off('update', onUpdate);
        manager.off('deleted', onDeleted);
      });
    });

    /** Stream en vivo de TODAS las sesiones (pantalla de inicio). */
    api.get('/events', async (req, reply) => {
      const send = openSse(req, reply, streams);
      for (const s of manager.list()) send({ type: 'snapshot', session: s });
      const onUpdate = (s: SessionSummary) => send({ type: 'snapshot', session: s });
      const onDeleted = (id: string) => send({ type: 'deleted', id });
      manager.on('update', onUpdate);
      manager.on('deleted', onDeleted);
      req.raw.on('close', () => {
        manager.off('update', onUpdate);
        manager.off('deleted', onDeleted);
      });
    });

    if (deps.simulator) {
      const sim = deps.simulator;
      api.post('/sessions/:id/simulate-scan', async (req) => {
        const { id } = IdParams.parse(req.params);
        manager.get(id);
        if (!sim.scan(id))
          throw new HttpError(409, 'not_showing_qr', 'La sesión no está mostrando un QR');
        return { ok: true };
      });
    }
  });

  return app;
}

/** Abre un stream SSE y devuelve una función para enviar eventos. */
function openSse(
  req: FastifyRequest,
  reply: FastifyReply,
  streams: Set<import('node:http').ServerResponse>,
): (ev: SessionStreamEvent) => void {
  const corsHeaders = reply.getHeaders();
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    ...(corsHeaders as Record<string, string>),
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
  heartbeat.unref?.();
  streams.add(res);
  req.raw.on('close', () => {
    clearInterval(heartbeat);
    streams.delete(res);
  });
  return (ev) => {
    if (res.writableEnded || res.destroyed) return;
    res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
  };
}
