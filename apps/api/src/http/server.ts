import cors from '@fastify/cors';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { SessionStreamEvent, SessionSummary } from '@wa-bridge/shared';
import type { Config } from '../config.js';
import { buildContactsWorkbook, contactsFileName } from '../export/contacts-xlsx.js';
import { buildConversationsWorkbook, conversationsFileName } from '../export/conversations-xlsx.js';
import { VentaPlayService } from '../ventaplay/service.js';
import { HttpError, type SessionManager } from '../session/manager.js';
import { isGroupJid, phoneOf, StatsAggregator, type Directory } from '../session/stats.js';
import type { StoredMessage } from '../session/message-vault.js';
import { openFolder } from '../dev/open-folder.js';
import {
  bridgeZip,
  connectorMcpb,
  connectorVersion,
  findRepoRoot,
  installGuide,
  kitZip,
  skillZip,
} from '../downloads/packages.js';
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
  /** carpeta del proyecto (para los descargables); por defecto se busca desde el cwd */
  repoRoot?: string | null;
  /** para tests: importación a VentaPlay con fetch simulado */
  ventaplay?: VentaPlayService;
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
const GroupBody = z.object({
  subject: z.string().min(1).max(100),
  participants: z.array(z.string().min(1).max(30)).min(1).max(50),
  text: z.string().max(4096).nullish(),
});
const TranscriptBody = z.object({ force: z.boolean().optional() });
const MetricsQuery = z.object({ days: z.coerce.number().int().min(1).max(3650).optional() });
const AssistantBody = z.object({
  enabled: z.boolean(),
  send: z.boolean().optional(),
  transcribe: z.boolean().optional(),
  autoTranscribe: z.boolean().optional(),
  relink: z.boolean().optional(),
});
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
const PairingBody = z.object({ phone: z.string().trim().min(8).max(24) });
const MigrationBody = z.object({
  enabled: z.boolean(),
  consentBy: z.string().trim().max(120).nullish(),
  relink: z.boolean().optional(),
});
const ForgetBody = z.object({ token: z.boolean().optional() });
const ContactsPlanBody = z.object({ suffix: z.string().trim().max(30).optional() });
const ContactsStartBody = z.object({
  suffix: z.string().trim().max(30),
  consentBy: z.string().trim().min(2, 'Falta quién autoriza').max(120),
});
const PrivacyBody = z.object({
  active: z.boolean().optional(),
  reviewIncluded: z.boolean().optional(),
  decisions: z
    .record(
      z.string().regex(/^\d{6,16}$/, 'número inválido'),
      z.enum(['incluir', 'excluir']).nullable(),
    )
    .refine((d) => Object.keys(d).length <= 5000, 'demasiadas decisiones')
    .optional(),
  reset: z.boolean().optional(),
  approve: z.object({ by: z.string().trim().min(2).max(120) }).optional(),
});
const SeedBody = z.object({
  org: z.string().trim().min(3).max(80),
  orgName: z.string().trim().max(120).nullish(),
  until: z.number().int().positive(),
});
const VentaPlayBody = z.object({
  token: z
    .string()
    .trim()
    .max(500)
    .refine((t) => t === '' || t.length >= 16, 'Pega la API key completa de la organización')
    .nullish(),
  mode: z.enum(['completo', 'actualizar']).optional(),
  phoneNumberId: z
    .string()
    .trim()
    .regex(/^\d{0,30}$/, 'El phone_number_id son solo números')
    .nullish(),
});
const HEARTBEAT_MS = 20_000;

export async function buildServer(deps: ServerDeps) {
  const { config, manager, auth } = deps;
  const ventaplay =
    deps.ventaplay ??
    new VentaPlayService({
      getSession: (id) => manager.get(id),
      logger: deps.logger,
      // solo para probar contra un VentaPlay local; por defecto, producción
      baseUrl: process.env.VENTAPLAY_API_URL || undefined,
    });

  /** con el filtro de privacidad activo, saca de los Excel a los contactos excluidos */
  async function withPrivacy(
    id: string,
    directory: Directory,
    chats?: { jid: string; messages: StoredMessage[] }[],
  ) {
    const ex = await ventaplay.excluded(id, chats ? { directory, chats } : { directory });
    if (!ex) return { directory, chats };
    const keep = (phone: string | null) => !phone || !ex.has(phone);
    return {
      directory: { ...directory, people: directory.people.filter((p) => keep(p.phone)) },
      chats: chats?.filter((c) => isGroupJid(c.jid) || keep(phoneOf(c.jid))),
    };
  }
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
    /** el envío se habilita por sesión en el modo asistente (con límites) */
    assistantMode: true,
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
      const { directory } = await withPrivacy(id, await session.directory());
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

    /** crea un grupo nuevo desde el número del dueño (ALLOW_SEND, con frenos) */
    api.post('/sessions/:id/personal/groups', async (req) => {
      const { id } = IdParams.parse(req.params);
      const body = GroupBody.parse(req.body ?? {});
      req.log.info(
        {
          session: id,
          participants: body.participants.length,
          by: req.principal?.email ?? req.principal?.sub,
        },
        'grupo nuevo pedido por el dueño',
      );
      return manager.get(id).createPersonalGroup(body);
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

    /**
     * "Traer toda la conversación": le pide al teléfono del dueño el historial antiguo del
     * chat por tramos y lo guarda completo (el chat queda aislado como proyecto).
     */
    api.post('/sessions/:id/personal/chats/:jid/history', async (req) => {
      const { id, jid } = ChatParams.parse(req.params);
      req.log.info({ session: id, chat: jid }, 'traer toda la conversación');
      return { history: await manager.get(id).fetchFullHistory(jid) };
    });

    api.get('/sessions/:id/personal/chats/:jid/history', async (req, reply) => {
      const { id, jid } = ChatParams.parse(req.params);
      reply.header('cache-control', 'no-store');
      return { history: manager.get(id).historyStatus(jid) };
    });

    /** métricas por persona de un chat fijado (?days=30; sin days = todo) */
    api.get('/sessions/:id/projects/:jid/metrics', async (req, reply) => {
      const { id, jid } = ChatParams.parse(req.params);
      const { days } = MetricsQuery.parse(req.query);
      reply.header('cache-control', 'no-store');
      return { metrics: await manager.get(id).projectMetrics(jid, { days: days ?? null }) };
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

    /** pasa a texto una nota de voz (Whisper en el equipo; queda guardada cifrada) */
    api.post('/sessions/:id/personal/chats/:jid/messages/:msgId/transcript', async (req) => {
      const { id, jid, msgId } = MediaParams.parse(req.params);
      const { force } = TranscriptBody.parse(req.body ?? {});
      const t = await manager.get(id).transcribeMessage(jid, msgId, { force });
      return { transcript: t };
    });

    /** activa / ajusta / desactiva el modo asistente de la sesión */
    api.post('/sessions/:id/assistant', async (req) => {
      const { id } = IdParams.parse(req.params);
      const body = AssistantBody.parse(req.body ?? {});
      req.log.info(
        { session: id, enabled: body.enabled, by: req.principal?.email ?? req.principal?.sub },
        'cambio de modo asistente',
      );
      return { session: await manager.setAssistant(id, body) };
    });

    /** vincular con código (alternativa al QR para quien no tiene el teléfono a mano) */
    api.post('/sessions/:id/pairing-code', async (req) => {
      const { id } = IdParams.parse(req.params);
      const { phone } = PairingBody.parse(req.body ?? {});
      req.log.info(
        { session: id, by: req.principal?.email ?? req.principal?.sub },
        'pedir código de vinculación',
      );
      return { session: await manager.requestPairing(id, phone) };
    });

    /** manda el código de vinculación por WhatsApp desde el agente conectado */
    api.post('/sessions/:id/pairing-code/send', async (req) => {
      const { id } = IdParams.parse(req.params);
      req.log.info(
        { session: id, by: req.principal?.email ?? req.principal?.sub },
        'enviar código de vinculación por el agente',
      );
      return { session: await manager.sendPairingCode(id) };
    });

    // ------------------------------------------- migración a VentaPlay

    /** activa / apaga el modo migración (guardar las conversaciones de este número) */
    api.post('/sessions/:id/migration', async (req) => {
      const { id } = IdParams.parse(req.params);
      const body = MigrationBody.parse(req.body ?? {});
      req.log.info(
        { session: id, enabled: body.enabled, by: req.principal?.email ?? req.principal?.sub },
        'cambio de modo migración',
      );
      return { session: await manager.setMigration(id, body) };
    });

    /**
     * Excel de conversaciones (modo migración): hojas Chats y Mensajes unidas al Excel de
     * contactos por el ID de contacto.
     */
    api.get('/sessions/:id/export/conversations.xlsx', async (req, reply) => {
      const { id } = IdParams.parse(req.params);
      const session = manager.get(id);
      if (!session.isMigrating)
        throw new HttpError(
          409,
          'not_migrating',
          'Activa "Migrar a VentaPlay" y vuelve a escanear el QR para guardar las conversaciones',
        );
      const summary = session.summary();
      const exportedAt = Date.now();
      const filtered = await withPrivacy(id, await session.directory(), session.migrationChats());
      const file = await buildConversationsWorkbook({
        session: summary,
        directory: filtered.directory,
        chats: filtered.chats ?? [],
        exportedAt,
      });
      req.log.info(
        { session: id, by: req.principal?.email ?? req.principal?.sub, bytes: file.length },
        'exportación de conversaciones a Excel',
      );
      return reply
        .header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .header(
          'content-disposition',
          `attachment; filename="${conversationsFileName(summary, exportedAt)}"`,
        )
        .header('cache-control', 'no-store')
        .send(file);
    });

    /**
     * Filtro de privacidad (voluntario): lista de contactos con la sugerencia
     * comercial / privado / revisar, las decisiones a mano y si entran o no.
     */
    api.get('/sessions/:id/privacy', async (req) => {
      const { id } = IdParams.parse(req.params);
      const { resumen } = z.object({ resumen: z.string().optional() }).parse(req.query ?? {});
      manager.get(id);
      const privacy = await ventaplay.privacy(id);
      // resumen: solo contadores y aprobación (para la tarjeta del panel)
      return { privacy: resumen ? { ...privacy, rows: [] } : privacy };
    });

    /** activa/apaga el filtro y guarda decisiones a mano (incluir / excluir / null) */
    api.post('/sessions/:id/privacy', async (req) => {
      const { id } = IdParams.parse(req.params);
      manager.get(id);
      const body = PrivacyBody.parse(req.body ?? {});
      req.log.info(
        {
          session: id,
          active: body.active,
          decisiones: Object.keys(body.decisions ?? {}).length,
          aprueba: body.approve ? body.approve.by : undefined,
          by: req.principal?.email ?? req.principal?.sub,
        },
        'filtro de privacidad: cambio',
      );
      return { privacy: await ventaplay.setPrivacy(id, body) };
    });

    /** clientes de VentaPlay → contactos en su WhatsApp: estado */
    api.get('/sessions/:id/ventaplay/contacts', async (req) => {
      const { id } = IdParams.parse(req.params);
      manager.get(id);
      return { contacts: ventaplay.contactsState(id) };
    });

    /** cuenta cuántos se crearían (no escribe nada) */
    api.post('/sessions/:id/ventaplay/contacts/plan', async (req) => {
      const { id } = IdParams.parse(req.params);
      manager.get(id);
      const { suffix } = ContactsPlanBody.parse(req.body ?? {});
      return { contacts: await ventaplay.contactsPlan(id, suffix ?? 'Paciente') };
    });

    /** crea los contactos con la autorización de la persona dueña del WhatsApp */
    api.post('/sessions/:id/ventaplay/contacts/start', async (req) => {
      const { id } = IdParams.parse(req.params);
      manager.get(id);
      const body = ContactsStartBody.parse(req.body ?? {});
      req.log.info(
        { session: id, autoriza: body.consentBy, by: req.principal?.email ?? req.principal?.sub },
        'contactos de VentaPlay → WhatsApp: autorizado',
      );
      return { contacts: await ventaplay.contactsStart(id, body) };
    });

    api.get('/sessions/:id/ventaplay', async (req) => {
      const { id } = IdParams.parse(req.params);
      manager.get(id);
      return { state: await ventaplay.state(id) };
    });

    /** valida la API key de la org y hace la prueba en seco (no escribe nada) */
    api.post('/sessions/:id/ventaplay/validate', async (req) => {
      const { id } = IdParams.parse(req.params);
      const body = VentaPlayBody.parse(req.body ?? {});
      req.log.info(
        { session: id, by: req.principal?.email ?? req.principal?.sub },
        'VentaPlay: validar',
      );
      return { state: await ventaplay.validate(id, body) };
    });

    /** importa (o retoma) en segundo plano; el avance se lee en GET /ventaplay */
    api.post('/sessions/:id/ventaplay/import', async (req) => {
      const { id } = IdParams.parse(req.params);
      req.log.info(
        { session: id, by: req.principal?.email ?? req.principal?.sub },
        'VentaPlay: importar',
      );
      return { state: await ventaplay.start(id) };
    });

    /** cierra la importación mostrada; con { token: true } además olvida el token guardado */
    api.post('/sessions/:id/ventaplay/forget', async (req) => {
      const { id } = IdParams.parse(req.params);
      const { token } = ForgetBody.parse(req.body ?? {});
      return { state: await ventaplay.forget(id, { token }) };
    });

    /**
     * Marca como ya enviado lo que se importó antes de existir el registro (hasta `until`),
     * para que "Actualizar" mande solo lo nuevo. Uso puntual, no aparece en la web.
     */
    api.post('/sessions/:id/ventaplay/registry/seed', async (req) => {
      const { id } = IdParams.parse(req.params);
      const { org, until, orgName } = SeedBody.parse(req.body ?? {});
      req.log.info({ session: id, until }, 'VentaPlay: registro inicial pedido');
      return { marcados: await ventaplay.seed(id, org, until, orgName ?? null) };
    });

    // ---------------------------------------------- descargables para compartir

    const root = deps.repoRoot ?? findRepoRoot();
    const sendZip = (reply: FastifyReply, name: string, type: string, data: Buffer) =>
      reply
        .header('content-type', type)
        .header('content-disposition', `attachment; filename="${name}"`)
        .header('cache-control', 'no-store')
        .send(data);
    const needRoot = () => {
      if (!root)
        throw new HttpError(404, 'no_repo', 'No encuentro la carpeta del proyecto en este equipo');
      return root;
    };

    /** qué se puede descargar (y versión del conector) */
    api.get('/downloads', async () => ({
      available: Boolean(root),
      connectorVersion: root ? await connectorVersion(root) : null,
    }));
    /** el proyecto para instalarlo en otro equipo (sin mensajes, credenciales ni .env) */
    api.get('/downloads/wa-bridge.zip', async (_req, reply) =>
      sendZip(reply, 'ventaplay-wa-bridge.zip', 'application/zip', await bridgeZip(needRoot())),
    );
    /** el conector de Claude Desktop */
    api.get('/downloads/whatsapp-asistente.mcpb', async (_req, reply) =>
      sendZip(
        reply,
        'WhatsApp-Asistente.mcpb',
        'application/octet-stream',
        await connectorMcpb(needRoot()),
      ),
    );
    /** las 3 piezas + la guía en un solo zip, para mandárselo a alguien */
    api.get('/downloads/wa-bridge-kit.zip', async (_req, reply) =>
      sendZip(reply, 'WA-Bridge-kit.zip', 'application/zip', await kitZip(needRoot())),
    );
    /** la guía de instalación */
    api.get('/downloads/INSTALAR.md', async (_req, reply) => {
      const md = await installGuide(needRoot());
      if (!md) throw new HttpError(404, 'no_guide', 'Falta INSTALAR.md');
      return reply
        .header('content-type', 'text/markdown; charset=utf-8')
        .header('content-disposition', 'attachment; filename="INSTALAR.md"')
        .send(md);
    });
    /** la skill para subir a Claude */
    api.get('/downloads/skill-whatsapp-asistente.zip', async (_req, reply) =>
      sendZip(reply, 'skill-whatsapp-asistente.zip', 'application/zip', await skillZip(needRoot())),
    );

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
