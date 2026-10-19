import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { PersonalChat } from '@wa-bridge/shared';
import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import {
  BridgeClient,
  BridgeError,
  loadConfig,
  mimeFor,
  resolveChat,
  resolveLocalPath,
} from './bridge.js';
import { author, body, chatLine, chatTitle, phone, transcript, when } from './format.js';

/**
 * Conector del WA Bridge: deja que Claude lea, busque y resuma el WhatsApp de la
 * persona que activó el modo asistente, a través del Bridge que corre en su equipo. Enviar exige confirmación.
 */
const client = new BridgeClient(await loadConfig());
const server = new McpServer({ name: 'whatsapp-alejandro', version: '0.4.0' });

type Text = { content: { type: 'text'; text: string }[]; isError?: boolean };
const text = (t: string): Text => ({ content: [{ type: 'text', text: t }] });
const fail = (t: string): Text => ({ content: [{ type: 'text', text: t }], isError: true });

async function run(fn: () => Promise<string>): Promise<Text> {
  try {
    return text(await fn());
  } catch (err) {
    return fail(err instanceof BridgeError ? err.message : `Error: ${(err as Error).message}`);
  }
}

/** busca el chat por nombre/número/jid; si es ambiguo, devuelve las opciones */
async function findChat(query: string, days = 90): Promise<PersonalChat> {
  const list = await client.chats(days);
  const r = resolveChat(list.items, query);
  if (r.ok) return r.chat;
  if (r.reason === 'many')
    throw new BridgeError(
      `Hay varios chats que coinciden con "${query}". Usa el jid del que corresponda:\n${r.candidates
        .map((c) => `- ${chatTitle(c)}`)
        .join('\n')}`,
    );
  throw new BridgeError(
    `No encontré un chat "${query}" con actividad en los últimos ${days} días. Prueba con whatsapp_listar_chats o whatsapp_buscar.`,
  );
}

const READ = { readOnlyHint: true, openWorldHint: false } as const;

server.registerTool(
  'whatsapp_estado',
  {
    title: 'Estado del WhatsApp',
    description:
      'Estado de la conexión del WhatsApp del usuario (modo asistente) en el WA Bridge: número, si está conectado, avance de la sincronización y cuántos chats y mensajes hay guardados. Úsala primero si algo falla.',
    inputSchema: {},
    annotations: READ,
  },
  () =>
    run(async () => {
      const s = await client.session();
      const p = s.personal!;
      return [
        `WhatsApp: ${s.profile?.name ?? s.label ?? '—'} ${phone(s.profile?.phone)}`,
        `Conexión: ${s.status}${s.lastError ? ` (${s.lastError})` : ''}`,
        `Historial: ${s.stats.state}${s.stats.progress !== null ? ` ${s.stats.progress}%` : ''}`,
        `Guardado: ${p.messages} mensajes · ${p.chats} chats con actividad en ${p.windowDays} días · hasta ${p.storePerChat ?? 300} mensajes por chat de los últimos ${p.storeDays ?? 90} días`,
        `Envío: ${p.sendEnabled ? 'habilitado (con confirmación y límites)' : 'deshabilitado'}`,
      ].join('\n');
    }),
);

server.registerTool(
  'whatsapp_listar_chats',
  {
    title: 'Listar chats',
    description:
      'Lista los chats de WhatsApp del usuario con actividad reciente, del más reciente al más antiguo, con el último mensaje y si quedó sin responder. Sirve como "bandeja de entrada". Devuelve el jid de cada chat para usarlo en las otras herramientas.',
    inputSchema: {
      dias: z.number().int().min(1).max(90).default(7).describe('ventana en días (máx. 90)'),
      tipo: z.enum(['todos', 'personas', 'grupos']).default('todos'),
      buscar: z.string().optional().describe('filtra por nombre o número'),
      limite: z.number().int().min(1).max(200).default(40),
    },
    annotations: READ,
  },
  ({ dias, tipo, buscar, limite }) =>
    run(async () => {
      const list = await client.chats(dias);
      let items = list.items.filter((c) =>
        tipo === 'personas' ? !c.isGroup : tipo === 'grupos' ? c.isGroup : true,
      );
      if (buscar) {
        const r = resolveChat(items, buscar);
        items = r.ok ? [r.chat] : r.candidates;
      }
      const shown = items.slice(0, limite);
      if (!shown.length) return `No hay chats que coincidan en los últimos ${dias} días.`;
      return [
        `${items.length} chats en los últimos ${dias} días (${list.individual} personas, ${list.groups} grupos en total)${items.length > shown.length ? `; muestro ${shown.length}` : ''}:`,
        ...shown.map(chatLine),
      ].join('\n');
    }),
);

server.registerTool(
  'whatsapp_leer_chat',
  {
    title: 'Leer un chat',
    description:
      'Lee los mensajes de un chat (persona o grupo) en orden, con fecha y hora de Chile y quién escribió. Acepta nombre, número o jid. Hay hasta 300 mensajes guardados por chat de los últimos 90 días; usa "antes_de" para paginar hacia atrás.',
    inputSchema: {
      chat: z.string().min(1).describe('nombre del contacto o grupo, número o jid'),
      cantidad: z.number().int().min(1).max(300).default(40),
      antes_de: z
        .string()
        .optional()
        .describe('fecha/hora ISO; trae mensajes anteriores a ese momento'),
    },
    annotations: READ,
  },
  ({ chat, cantidad, antes_de }) =>
    run(async () => {
      const c = await findChat(chat);
      const before = antes_de ? Date.parse(antes_de) : undefined;
      const r = await client.messages(
        c.jid,
        cantidad,
        Number.isFinite(before) ? before : undefined,
      );
      if (!r.messages.length) return `${chatTitle(r.chat)}\n(sin mensajes en ese rango)`;
      return [
        chatTitle(r.chat),
        `${r.messages.length} mensajes${r.hasMore ? ` (hay más antiguos: usa antes_de=${new Date(r.messages[0]!.timestamp).toISOString()})` : ''}:`,
        transcript(r.chat, r.messages),
      ].join('\n');
    }),
);

server.registerTool(
  'whatsapp_transcribir',
  {
    title: 'Transcribir notas de voz',
    description:
      'Pasa a texto las últimas notas de voz de un chat (Whisper corriendo en el equipo del usuario; el audio no sale de ahí). Devuelve fecha, quién habló y el texto. Las ya transcritas vienen guardadas. La primera vez baja el modelo (~500 MB) y puede tardar unos minutos.',
    inputSchema: {
      chat: z.string().min(1).describe('nombre del contacto o grupo, número o jid'),
      cantidad: z
        .number()
        .int()
        .min(1)
        .max(20)
        .default(3)
        .describe('cuántas notas de voz, de la más nueva hacia atrás'),
      forzar: z.boolean().default(false).describe('volver a transcribir aunque ya exista'),
    },
    annotations: READ,
  },
  ({ chat, cantidad, forzar }) =>
    run(async () => {
      const c = await findChat(chat);
      const r = await client.messages(c.jid, 300);
      const voices = r.messages
        .filter((m) => m.kind === 'voice' || m.kind === 'audio')
        .slice(-cantidad);
      if (!voices.length)
        return `${chatTitle(r.chat)}\nNo hay notas de voz guardadas en este chat.`;
      const out: string[] = [chatTitle(r.chat)];
      for (const m of voices) {
        const head = `[${when(m.timestamp)}] ${author(m, r.chat.isGroup, r.chat.name)} · ${body({ ...m, text: null, transcript: undefined })}`;
        try {
          const t = await client.transcribe(r.chat.jid, m.id, forzar);
          out.push(`${head}\n“${t.text || '(sin voz reconocible)'}”`);
        } catch (err) {
          out.push(
            `${head}\n(no se pudo transcribir: ${err instanceof Error ? err.message : String(err)})`,
          );
        }
      }
      return out.join('\n\n');
    }),
);

server.registerTool(
  'whatsapp_buscar',
  {
    title: 'Buscar mensajes',
    description:
      'Busca texto en todos los chats guardados de WhatsApp (últimos 90 días), sin distinguir mayúsculas ni tildes; deben aparecer todas las palabras. Opcionalmente dentro de un solo chat.',
    inputSchema: {
      texto: z.string().min(1),
      chat: z.string().optional().describe('limitar a un chat (nombre, número o jid)'),
      dias: z.number().int().min(1).max(90).default(90),
      limite: z.number().int().min(1).max(200).default(30),
    },
    annotations: READ,
  },
  ({ texto, chat, dias, limite }) =>
    run(async () => {
      const jid = chat ? (await findChat(chat)).jid : null;
      const r = await client.search(texto, { days: dias, jid, limit: limite });
      if (!r.total) return `Sin resultados para "${texto}" en los últimos ${dias} días.`;
      return [
        `${r.total} mensajes con "${texto}"${r.total > r.hits.length ? ` (muestro ${r.hits.length})` : ''}:`,
        ...r.hits.map(
          (h) =>
            `- [${when(h.message.timestamp)}] ${h.chat.name}${h.chat.isGroup ? ' (grupo)' : ''} — ${author(h.message, h.chat.isGroup, h.chat.name)}: ${body(h.message)}\n  jid: ${h.chat.jid}`,
        ),
      ].join('\n');
    }),
);

server.registerTool(
  'whatsapp_pendientes',
  {
    title: 'Pendientes por responder',
    description:
      'Chats donde el último mensaje es de la otra persona (el usuario no ha respondido), con lo que le escribieron desde su última respuesta. Ideal para "¿a quién le debo respuesta?".',
    inputSchema: {
      dias: z.number().int().min(1).max(30).default(3),
      incluir_grupos: z.boolean().default(false),
      limite: z.number().int().min(1).max(40).default(20),
    },
    annotations: READ,
  },
  ({ dias, incluir_grupos, limite }) =>
    run(async () => {
      const list = await client.chats(dias);
      const pend = list.items
        .filter((c) => !c.previewFromMe && !c.isSelf && (incluir_grupos || !c.isGroup))
        .slice(0, limite);
      if (!pend.length) return `Nada pendiente en los últimos ${dias} días. 🎉`;
      const blocks: string[] = [];
      for (const c of pend) {
        const r = await client.messages(c.jid, 15);
        const lastMine = r.messages.map((m) => m.fromMe).lastIndexOf(true);
        const waiting = r.messages.slice(lastMine + 1);
        blocks.push(
          `## ${chatTitle(c)}\nesperando desde ${when(waiting[0]?.timestamp ?? c.lastMessageAt)}\n${transcript(c, waiting.slice(-6))}`,
        );
      }
      return [`${pend.length} chats esperan tu respuesta (últimos ${dias} días):`, ...blocks].join(
        '\n\n',
      );
    }),
);

server.registerTool(
  'whatsapp_enviar',
  {
    title: 'Enviar un mensaje',
    description:
      'Envía un mensaje de texto desde el WhatsApp del usuario a un chat que ya existe. OBLIGATORIO: antes de llamar con confirmado=true, muéstrale al usuario el destinatario y el texto EXACTO y espera su "sí" explícito en el chat. Con confirmado=false solo devuelve la vista previa. Nunca envíes en masa ni a varios chats sin una confirmación por cada uno. Hay límites (8/min, 40/hora, 150/día).',
    inputSchema: {
      chat: z.string().min(1).describe('nombre, número o jid del chat'),
      texto: z.string().min(1).max(4096),
      confirmado: z
        .boolean()
        .default(false)
        .describe('true solo después de que el usuario aprobó este texto y destinatario'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  ({ chat, texto, confirmado }) =>
    run(async () => {
      const c = await findChat(chat);
      if (!confirmado)
        return `Vista previa (NO enviado):\nPara: ${chatTitle(c)}\nTexto:\n${texto}\n\nPide confirmación al usuario y vuelve a llamar con confirmado=true y jid ${c.jid}.`;
      const r = await client.send(c.jid, texto);
      return `✅ Enviado a ${chatTitle(r.chat)} a las ${when(r.message.timestamp)}.\nQuedan ${r.remaining.hour} envíos esta hora y ${r.remaining.day} hoy.`;
    }),
);

const MAX_FILE = 16 * 1024 * 1024;

server.registerTool(
  'whatsapp_enviar_archivo',
  {
    title: 'Enviar una foto o archivo',
    description:
      'Envía una foto, video, audio o documento que está en el equipo del usuario (ruta absoluta o con ~) a un chat que ya existe, con un comentario opcional. Máx. 16 MB. JPG/PNG/MP4 van como foto/video; lo demás (PDF, Excel, HEIC, MOV…) como documento. OBLIGATORIO: antes de llamar con confirmado=true, muéstrale al usuario el destinatario, el archivo y el comentario y espera su "sí" explícito. Con confirmado=false solo devuelve la vista previa. Mismos límites que los textos.',
    inputSchema: {
      chat: z.string().min(1).describe('nombre, número o jid del chat'),
      ruta: z
        .string()
        .min(1)
        .describe('ruta del archivo en el Mac, p. ej. ~/Desktop/propuesta.pdf'),
      comentario: z.string().max(1024).optional().describe('texto que acompaña al archivo'),
      como_documento: z
        .boolean()
        .default(false)
        .describe('true para mandar una foto o video sin comprimir, como documento'),
      confirmado: z
        .boolean()
        .default(false)
        .describe('true solo después de que el usuario aprobó archivo y destinatario'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  ({ chat, ruta, comentario, como_documento, confirmado }) =>
    run(async () => {
      const path = resolveLocalPath(ruta);
      const info = await stat(path).catch(() => null);
      if (!info?.isFile()) throw new BridgeError(`No encuentro el archivo ${path}`);
      if (info.size > MAX_FILE)
        throw new BridgeError(
          `El archivo pesa ${(info.size / 1024 / 1024).toFixed(1)} MB; el máximo es 16 MB`,
        );
      const c = await findChat(chat);
      const fileName = basename(path);
      const mimetype = mimeFor(path);
      const size = `${(info.size / 1024).toFixed(0)} KB`;
      if (!confirmado)
        return `Vista previa (NO enviado):\nPara: ${chatTitle(c)}\nArchivo: ${fileName} (${size}, ${mimetype}${como_documento ? ', como documento' : ''})\nComentario: ${comentario?.trim() || '(ninguno)'}\n\nPide confirmación al usuario y vuelve a llamar con confirmado=true y jid ${c.jid}.`;
      const data = await readFile(path);
      const r = await client.sendFile(
        c.jid,
        { data, mimetype, fileName },
        { caption: comentario ?? null, asDocument: como_documento },
      );
      return `✅ Enviado ${fileName} a ${chatTitle(r.chat)} a las ${when(r.message.timestamp)}.\nQuedan ${r.remaining.hour} envíos esta hora y ${r.remaining.day} hoy.`;
    }),
);

await server.connect(new StdioServerTransport());
