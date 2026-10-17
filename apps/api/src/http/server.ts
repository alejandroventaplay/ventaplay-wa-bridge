import cors from '@fastify/cors';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { SessionStreamEvent, SessionSummary } from '@wa-bridge/shared';
import type { Config } from '../config.js';
import { buildContactsWorkbook, contactsFileName } from '../export/contacts-xlsx.js';
import { HttpError, type SessionManager } from '../session/manager.js';
import { StatsAggregator } from '../session/stats.js';
import { openFolder } from '../dev/open-folder.js';
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
  /** para tests: reemplaza la apertura real de carpetas */
  openFolder?: (dir: string) => void;
}

const IdParams = z.object({ id: z.string().uuid() });
const JID = z.string().regex(/^[\w.-]{3,64}@(s\.whatsapp\.net|lid|g\.us)$/, 'chat inválido');
const ChatParams = IdParams.extend({ jid: JID });
const MediaParams = ChatParams.extend({ msgId: z.string().regex(/^[\w-]{4,128}$/) });
const ChatsQuery = z.object({ days: z.coerce.number().int().min(1).max(90).optional() });
const MessagesQuery = z.object({
  limit: z.coerce.number().int().min(1).max(300).optional(),
  before: z.coerce.number().int().positive().optional(),
});
const SearchQuery = z.object({
  q: z.string().trim().min(1).max(200),
  days: z.coerce.number().int().min(1).max(90).optional(),
  jid: JID.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
const SendBody = z.object({ text: z.string().min(1).max(4096) });
/** archivo en base64 (16 MB → ~21,4 MB de texto) */
const SendMediaBody = z.object({
  data: z.string().min(1),
  mimetype: z.string().trim().max(120).default('application/octet-stream'),
  fileName: z.string().max(255).default('archivo'),
  caption: z.string().max(1024).nullish(),
  asDocument: z.boolean().default(false),
});
const MEDIA_BODY_LIMIT = 23 * 1024 * 1024;
const ProjectBody = z.object({ jid: z.string().min(3).max(120) });
const ProjectQuery = z.object({
  limit: z.coerce.number().int().min(1).max(5000).default(500),
  before: z.coerce.number().int().positive().nullish(),
  raw: z
    .enum(['0', '1', 'true', 'false'])
    .optional()
    .transform((v) => v === '1' || v === 'true'),
});
const ExportQuery = z.object({ modo: z.enum(['util', 'completo']).default('util') });
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
    // para que la web lea el nombre del archivo exportado
    exposedHeaders: ['Content-Disposition', 'X-Media-Thumbnail'],
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
    /** el dueño puede enviar texto desde su número (con límites); todo lo demás sigue bloqueado */
    sendEnabled: config.ALLOW_SEND && Boolean(config.OWNER_PHONE),
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

    /** Cuántos contactos sirven para el CRM y cuántos quedan fuera (y por qué). */
    api.get('/sessions/:id/export/preview', async (req) => {
      const { id } = IdParams.parse(req.params);
      const { useful, ...counts } = StatsAggregator.classify(await manager.get(id).directory());
      return { useful: useful.length, ...counts };
    });

    /**
     * Excel de contactos. `modo=util` (por defecto): solo con nombre y celular.
     * `modo=completo`: todo, más grupos e IDs. Nunca incluye mensajes.
     */
    api.get('/sessions/:id/export/contacts.xlsx', async (req, reply) => {
      const { id } = IdParams.parse(req.params);
      const { modo } = ExportQuery.parse(req.query);
      const session = manager.get(id);
      const directory = await session.directory();
      const summary = session.summary();
      const exportedAt = Date.now();
      const file = await buildContactsWorkbook({
        session: summary,
        directory,
        mode: modo,
        exportedAt,
      });
      const name = contactsFileName(summary, exportedAt, modo);
      req.log.info(
        { session: id, modo, by: req.principal?.email ?? req.principal?.sub, bytes: file.length },
        'exportación de contactos a Excel',
      );
      return reply
        .header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .header('content-disposition', `attachment; filename="${name}"`)
        .header('cache-control', 'no-store')
        .send(file);
    });

    // ------------------------------------------------ Mi vista (solo el número dueño)

    /** chats con actividad en los últimos 30 días (individuales y grupos) */
    api.get('/sessions/:id/personal/chats', async (req, reply) => {
      const { id } = IdParams.parse(req.params);
      const { days } = ChatsQuery.parse(req.query);
      reply.header('cache-control', 'no-store');
      return manager.get(id).personalChats({ days });
    });

    /** últimos mensajes guardados de un chat */
    api.get('/sessions/:id/personal/chats/:jid/messages', async (req, reply) => {
      const { id, jid } = ChatParams.parse(req.params);
      const q = MessagesQuery.parse(req.query);
      reply.header('cache-control', 'no-store');
      return manager.get(id).personalMessages(jid, q);
    });

    /** busca texto en todos los chats guardados (90 días) */
    api.get('/sessions/:id/personal/search', async (req, reply) => {
      const { id } = IdParams.parse(req.params);
      const { q, days, jid, limit } = SearchQuery.parse(req.query);
      reply.header('cache-control', 'no-store');
      return manager.get(id).searchPersonal(q, { days, chatJid: jid ?? null, limit });
    });

    /** envía un texto desde el número del dueño (ALLOW_SEND, con límites) */
    api.post('/sessions/:id/personal/chats/:jid/send', async (req) => {
      const { id, jid } = ChatParams.parse(req.params);
      const { text } = SendBody.parse(req.body ?? {});
      req.log.info(
        { session: id, chat: jid, by: req.principal?.email ?? req.principal?.sub },
        'envío pedido por el dueño',
      );
      return manager.get(id).sendPersonal(jid, text);
    });

    /** envía una foto, video, audio o documento (mismas reglas y frenos que el texto) */
    api.post(
      '/sessions/:id/personal/chats/:jid/send-media',
      { bodyLimit: MEDIA_BODY_LIMIT },
      async (req) => {
        const { id, jid } = ChatParams.parse(req.params);
        const b = SendMediaBody.parse(req.body ?? {});
        const data = Buffer.from(b.data, 'base64');
        req.log.info(
          {
            session: id,
            chat: jid,
            bytes: data.length,
            by: req.principal?.email ?? req.principal?.sub,
          },
          'envío de archivo pedido por el dueño',
        );
        return manager.get(id).sendPersonalMedia(jid, {
          data,
          mimetype: b.mimetype,
          fileName: b.fileName,
          caption: b.caption ?? null,
          asDocument: b.asDocument,
        });
      },
    );

    // ---------------------------------------------- proyectos (chats aislados del dueño)

    api.get('/sessions/:id/projects', async (req, reply) => {
      const { id } = IdParams.parse(req.params);
      reply.header('cache-control', 'no-store');
      return { projects: await manager.get(id).projects() };
    });

    /** aísla un chat: desde ahora se guarda todo, con metadatos y media */
    api.post('/sessions/:id/projects', async (req) => {
      const { id } = IdParams.parse(req.params);
      const { jid } = ProjectBody.parse(req.body ?? {});
      req.log.info({ session: id, chat: jid }, 'aislar chat como proyecto');
      return { project: await manager.get(id).isolate(jid) };
    });

    api.delete('/sessions/:id/projects/:jid', async (req, reply) => {
      const { id, jid } = ChatParams.parse(req.params);
      await manager.get(id).unisolate(jid);
      return reply.status(204).send();
    });

    api.get('/sessions/:id/projects/:jid/messages', async (req, reply) => {
      const { id, jid } = ChatParams.parse(req.params);
      const q = ProjectQuery.parse(req.query);
      reply.header('cache-control', 'no-store');
      return manager.get(id).projectMessages(jid, q);
    });

    api.get('/sessions/:id/projects/:jid/media/:msgId', async (req, reply) => {
      const { id, jid, msgId } = MediaParams.parse(req.params);
      const m = await manager.get(id).projectMedia(jid, msgId);
      reply.header('cache-control', 'private, max-age=3600');
      reply.header('content-type', m.mimetype);
      if (m.fileName)
        reply.header(
          'content-disposition',
          `inline; filename*=UTF-8''${encodeURIComponent(m.fileName)}`,
        );
      return reply.send(m.buffer);
    });

    /** abre la carpeta del proyecto en Finder / Explorador (solo con la API en tu equipo) */
    api.post('/sessions/:id/projects/:jid/open', async (req) => {
      const { id, jid } = ChatParams.parse(req.params);
      if (config.NODE_ENV === 'production')
        throw new HttpError(
          409,
          'not_local',
          'Abrir carpetas solo funciona con la API en tu equipo',
        );
      const dir = await manager.get(id).projectFolder(jid);
      (deps.openFolder ?? openFolder)(dir);
      return { ok: true, dir };
    });

    /** reescribe la carpeta del proyecto (JSONL, Excel y archivos) */
    api.post('/sessions/:id/projects/:jid/export', async (req) => {
      const { id, jid } = ChatParams.parse(req.params);
      return { project: await manager.get(id).exportProject(jid) };
    });

    /** foto, audio, video, sticker o documento de un mensaje guardado */
    api.get('/sessions/:id/personal/chats/:jid/media/:msgId', async (req, reply) => {
      const { id, jid, msgId } = MediaParams.parse(req.params);
      const media = await manager.get(id).personalMedia(jid, msgId);
      return reply
        .header('content-type', media.mimetype)
        .header('cache-control', 'private, max-age=3600')
        .header('x-media-thumbnail', media.thumbnail ? '1' : '0')
        .send(media.buffer);
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
