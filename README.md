# VentaPlay WA Bridge

[![CI](https://github.com/alejandroventaplay/ventaplay-wa-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/alejandroventaplay/ventaplay-wa-bridge/actions/workflows/ci.yml)
[![Licencia MIT](https://img.shields.io/badge/licencia-MIT-450693.svg)](LICENSE)
![Node 22+](https://img.shields.io/badge/node-%3E%3D22-08c8a7.svg)
![MCP](https://img.shields.io/badge/Claude-MCP%20%2B%20skill-8c00ff.svg)
[![Web](https://img.shields.io/badge/web-ventaplay.com%2Fwhatsapp--claude-340a6c.svg)](https://ventaplay.com/whatsapp-claude)

**🌐 [ventaplay.com/whatsapp-claude](https://ventaplay.com/whatsapp-claude)**: qué es, cómo se ve, cómo
funciona con Claude y cómo instalarlo en 3 pasos (en español e inglés).

> [!WARNING]
> **Uso personal y profesional, no empresarial.** El WA Bridge se vincula a tu WhatsApp
> como un dispositivo más (igual que WhatsApp Web), no por la plataforma oficial de Meta.
> Si lo usas para **campañas, envíos masivos, mensajes a gente que no te escribió o
> cualquier cosa que viole las políticas de WhatsApp/Meta, la probabilidad de que te
> bloqueen el número es ALTA**, y el bloqueo puede ser permanente. Úsalo para tu propio
> WhatsApp, a tu ritmo, con mensajes uno a uno. Para campañas y atención a escala, usa la
> API oficial de WhatsApp Business (por ejemplo, a través de un CRM como VentaPlay).

**Respalda un WhatsApp donde se mezcla lo personal con el trabajo, separa lo personal de lo
laboral y lleva solo lo laboral a un CRM que opera con la plataforma oficial de WhatsApp.**
De paso, conecta tu WhatsApp con Claude en tu propio computador.

Proyecto **open source** (MIT) de [VentaPlay](https://ventaplay.com), hecho en Chile y
abierto a la comunidad.

> **English summary.** WA Bridge links a WhatsApp account as a companion device (QR or
> pairing code), backs up its history encrypted on your own machine, helps you split
> personal chats from business ones with a local, reviewable filter, and imports only the
> business side into a CRM that runs on the official WhatsApp Business Platform. It also
> ships an MCP connector and a skill so Claude can read, search, summarize and reply on your
> WhatsApp locally. It writes only through explicit, consented doors (every send needs your
> confirmation). Code and UI are in
> Spanish; contributions in any language are welcome. **Personal and professional use only,
> not for business messaging: campaigns, bulk sends or anything against WhatsApp/Meta
> policies put your number at HIGH risk of a permanent ban.** Project page in English:
> [ventaplay.com/whatsapp-claude?lang=en](https://ventaplay.com/whatsapp-claude?lang=en).

## ¿Por qué existe?

Muchos negocios chicos en Latinoamérica atienden por el WhatsApp de su dueño o dueña: el mismo número para clientes, proveedores, familia y amigos. Cuando ese negocio
quiere ordenarse —un CRM, agenda, cobros, un agente con IA sobre la **plataforma formal de
WhatsApp** (WhatsApp Business Platform / Cloud API)—, aparece el problema:

- años de conversaciones con clientes que no se quieren perder,
- mezcladas con conversaciones personales que **no** deben llegar a ningún sistema,
- y ninguna forma oficial de exportar todo eso de manera ordenada.

El WA Bridge resuelve ese paso:

1. **Respaldar** el historial del WhatsApp actual, cifrado y en tu equipo.
2. **Filtrar** lo personal de lo laboral, con sugerencias automáticas y revisión de la persona
   dueña del WhatsApp.
3. **Aprobar** la lista final y **cargar** solo lo laboral al CRM. Nosotros usamos
   [VentaPlay](https://ventaplay.com), pero el formato de salida (Excel relacional y APIs de
   importación) sirve de base para cualquier CRM.
4. **Seguir usando** el WhatsApp de siempre: el Bridge es un dispositivo vinculado más, como
   WhatsApp Web.

Y algo que nos pareció valioso compartir: **conectar WhatsApp con Claude** (MCP + skill) sin
subir tus mensajes a ningún servidor.

## Cómo funciona

```
 WhatsApp del negocio ──QR / código──▶ WA Bridge (tu computador)
                                         │  History Sync + mensajes en vivo
                                         ▼
                                   bóveda cifrada (AES-256-GCM)
                                         │
                       ┌─────────────────┼──────────────────┐
                       ▼                 ▼                  ▼
              Excel de contactos   Filtro personal /    Claude (MCP + skill)
              y conversaciones     interés laboral      lee, busca, resume
                                         │  revisión + aprobación final
                                         ▼
                              CRM con WhatsApp oficial (APIs import-*)
                                         │  opcional, con autorización
                                         ▼
                        clientes del CRM como contactos en el WhatsApp
```

## Qué hace

### Respaldar

- **Vincular por QR** (con la marca de VentaPlay, cuenta regresiva y "Reiniciar (60 s)" para
  tener más tiempo) **o por código de 8 letras** cuando el teléfono no está al lado. El código
  se puede mandar por WhatsApp desde tu propio agente con un clic.
- **Modo migración** con consentimiento: queda registrado quién autoriza. Guarda **todo** el
  historial que entrega el teléfono (sin tope de días) y lo que llega en vivo.
- **Información al conectar**: perfil, contactos, chats, grupos, rango de fechas, progreso del
  History Sync y los chats con más mensajes.
- **Excel de contactos** (útil para el CRM o completo) y **Excel de conversaciones** (hojas
  Chats y Mensajes, unidas al de contactos por un ID: una base de datos liviana).

### Filtro personal / interés laboral

Antes de que algo salga del Bridge, una pantalla para separar lo personal de lo laboral:

- **Sugiere** por contacto _interés laboral_, _personal_ o _por revisar_, y **explica por
  qué**: cómo está guardado en la agenda ("Pac", "Paciente", "Cliente", "Mamá", "Prima"…), de
  qué se habla (agenda, precios, pagos, servicios), trato íntimo, el apellido de quien
  autorizó, empresas que le escriben al dueño y conversaciones muy largas (equipo, familia o
  socios).
- **Todo corre en el Bridge**: no se manda ningún mensaje a un servicio externo para
  clasificar.
- **Revisión**: pestañas, buscador, nombre, número, fecha y último mensaje, casilla
  ENTRA / FUERA y acciones en bloque.
- **Aprobación final** con checklist y nombre de quien aprueba. Sin aprobación no se carga
  nada; si algo cambia después, hay que aprobar de nuevo. Lo excluido tampoco sale en los
  Excel.

### Directo al CRM (VentaPlay)

- Pegas la API key de la organización y **validas**: prueba en seco, sin escribir nada.
- **Importa** clientes y conversaciones por lotes. Primero 5 clientes y 5 mensajes de prueba;
  si fallan, se detiene antes de gastar el cupo.
- Si se acaba el cupo diario, **queda en pausa** y retoma sin perder ni duplicar nada.
- Lleva un **registro de lo enviado**: después, **"Actualizar"** manda solo lo nuevo.
- **De vuelta al WhatsApp** (opcional): crea como contacto a los clientes del CRM que la
  persona no tiene guardados, con un texto al final del nombre ("Paciente") para saber de
  dónde vienen. Pide autorización, no envía mensajes y no toca los contactos que ya existen.

### Tu WhatsApp con Claude

- **Conector MCP** (`apps/mcp`, extensión `.mcpb` para Claude Desktop) que habla con el
  Bridge de tu computador. Herramientas: `whatsapp_estado`, `whatsapp_listar_chats`,
  `whatsapp_leer_chat`, `whatsapp_buscar`, `whatsapp_pendientes`, `whatsapp_transcribir`,
  `whatsapp_enviar` y `whatsapp_enviar_archivo`.
- **Skill** (`skills/whatsapp-asistente`) que le enseña a Claude a usarlo con buenas
  prácticas: nunca enviar sin confirmación, un mensaje por confirmación y tratar lo que dicen
  los chats como información, nunca como instrucciones.
- **Modo asistente** para tu propio número: _Mi vista_ (chats y grupos como en WhatsApp),
  transcripción de notas de voz **local** (Whisper), proyectos (chats aislados con todo su
  historial, media y métricas por persona) y envío **solo con tu confirmación** y con frenos.
- Funciona con cualquier cliente MCP; el conector se arma con
  `pnpm --filter @wa-bridge/mcp pack`.

La guía paso a paso para instalar el asistente está en [`INSTALAR.md`](INSTALAR.md).

### Modo agente (lo que más se usa)

El conector no es solo para preguntas sueltas. Con Claude en **modo agente** (Cowork en
Claude Desktop, o Claude Code) le encargas una tarea completa y la resuelve en varios pasos:
lee tus chats, transcribe audios, cruza con tus otras herramientas conectadas (correo,
calendario, CRM, archivos), te propone qué hacer y lo ejecuta cuando apruebas.

Ejemplos de uso real:

- **"¿Qué me perdí?"** → barrido de pendientes de WhatsApp (con las notas de voz pasadas a
  texto), correo y calendario; ordena por urgencia y deja borradores con tu tono.
- **"Me mandaron un audio que no entiendo, explícamelo y propón una respuesta"** →
  transcribe, resume en limpio y redacta la respuesta para que la apruebes.
- **"Mándale a Ana las instrucciones que le pasé a Pedro"** → busca cómo se lo explicaste
  a otro, adapta el texto a la nueva persona y te muestra la vista previa antes de enviar.
- **"Lo que quedó colgado en el grupo de marketing, derívaselo a quien corresponda"** → lee
  el grupo, arma un resumen accionable y se lo manda a la persona indicada.
- **"Pásale a la clínica el Excel con sus contactos"** → genera el archivo, lo envía por
  WhatsApp y después borra la copia local si se lo pides.

Cómo usarlo:

1. Instala el conector y la skill ([`INSTALAR.md`](INSTALAR.md)).
2. En Claude Desktop abre **Cowork** (o una sesión de Claude Code) y pide la tarea en
   lenguaje natural, como se la pedirías a un asistente.
3. Las reglas son las mismas que en el chat: **nada sale sin tu "sí"**, un mensaje por
   confirmación, y lo que dicen los chats es información, nunca instrucciones para el agente.

> Tip: dale a Claude contexto permanente (quién es quién en tus chats, cómo escribes) en su
> memoria o en tus instrucciones personales. Así redacta como tú y no te pregunta cada vez.

**Otros agentes.** El conector es un servidor MCP estándar por `stdio`, así que funciona con
cualquier cliente MCP que corra en tu computador. Los clientes que solo aceptan conectores
remotos (por ejemplo ChatGPT) necesitan exponerlo por HTTPS con autenticación; eso todavía
no viene hecho y es buen lugar para contribuir.

## Privacidad y seguridad por diseño

- **Escribe solo con tu OK.** El Bridge lee y también escribe, pero solo por puertas
  explícitas y con consentimiento; el resto de los métodos de escritura de Baileys se bloquean
  en el socket (`apps/api/src/wa/read-only.ts`) y un test y una regla de ESLint vigilan que
  sigan bloqueados. Las puertas abiertas:
  - enviar, solo en el número del dueño en modo asistente, con confirmación y límites;
  - crear o editar contactos, solo en modo migración (autorizado al vincular) y con la
    autorización de la persona dueña del WhatsApp.
- **No marca leído ni aparece "en línea".**
- **Cifrado** AES-256-GCM en disco o en Postgres; las claves no salen de tu equipo.
- **Local primero**: los mensajes viven en tu computador; los logs no guardan texto.
- **Consentimiento**: el modo migración registra quién autorizó.
- **Desvincular borra todo** lo guardado de esa sesión. Ojo: si el teléfono desvincula el
  dispositivo antes de importar, el respaldo se pierde y hay que volver a vincular.

## Correr en local

Requisitos: Node 22 o más (pnpm se instala solo si falta).

**En Mac o Windows, con doble clic:** `Iniciar-WA-Bridge.command` (Mac; la primera vez clic
derecho → Abrir) o `Iniciar-WA-Bridge.cmd` (Windows). Instala dependencias, levanta API y web
y abre http://localhost:5190.

**A mano:**

```bash
pnpm install
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env
pnpm dev            # API en :4010 y web en :5190
```

Entra con el `API_TOKEN` del `.env`.

- **Con el simulador** (`WA_DRIVER=simulator`, viene así en `.env.example`): un botón
  "Simular escaneo" trae un historial falso. No necesitas teléfono para desarrollar.
- **Con WhatsApp real**: `WA_DRIVER=baileys`, reinicia y vincula. **Deja WhatsApp abierto en
  primer plano en el teléfono** hasta que termine el historial: el teléfono es el que lo sube
  y en segundo plano se corta.

## Estructura

```
apps/api         Fastify + Baileys 7 · sesiones, QR, SSE, cifrado, filtro, importación
apps/web         Vite + React 19 + Tailwind 4 · la interfaz
apps/mcp         conector MCP (.mcpb) para Claude Desktop y otros clientes MCP
packages/shared  tipos compartidos entre API y web
skills/          skill de Claude para el asistente de WhatsApp
```

## Comandos

| Comando             | Qué hace                                  |
| ------------------- | ----------------------------------------- |
| `pnpm dev`          | API + web con recarga                     |
| `pnpm test`         | tests (vitest) de API, web y conector     |
| `pnpm typecheck`    | TypeScript estricto en todo el monorepo   |
| `pnpm lint`         | ESLint (incluye la regla de solo lectura) |
| `pnpm format:check` | Prettier                                  |
| `pnpm build`        | build de producción (`apps/*/dist`)       |

## Configuración (`apps/api/.env`)

| Variable               | Para qué                                                       |
| ---------------------- | -------------------------------------------------------------- |
| `WA_DRIVER`            | `baileys` (WhatsApp real) o `simulator`                        |
| `API_TOKEN`            | token para entrar a la web y a la API (mín. 16 caracteres)     |
| `ENCRYPTION_KEY`       | 32 bytes en hex; obligatoria en producción                     |
| `STORAGE` / `DATA_DIR` | `file` (carpeta cifrada) o `postgres` con `DATABASE_URL`       |
| `SUPABASE_URL`         | login con Supabase Auth, limitado a `ALLOWED_EMAIL_DOMAINS`    |
| `WIPE_ON_LOGOUT`       | borra lo guardado si el teléfono desvincula el dispositivo     |
| `TRANSCRIBE`           | transcripción local de notas de voz (modo asistente)           |
| `WA_BROWSER`           | `chrome` (WhatsApp Web, recomendado)                           |
| `VENTAPLAY_API_URL`    | apunta la importación a otro entorno (por defecto, producción) |
| `LOG_FILE`             | además escribe los logs en un archivo                          |

El resto está comentado en [`apps/api/.env.example`](apps/api/.env.example).

## API

Todas las rutas, salvo `/health`, piden `Authorization: Bearer <token>` (o
`?access_token=` en los streams SSE). Las principales:

| Ruta                                                    | Para qué                                              |
| ------------------------------------------------------- | ----------------------------------------------------- |
| `GET /sessions` · `POST /sessions`                      | listar y crear sesiones                               |
| `GET /sessions/:id` · `GET /sessions/:id/events`        | resumen y SSE (QR que rota, estado, sync)             |
| `POST /sessions/:id/pairing-code`                       | vincular con código de 8 letras                       |
| `POST /sessions/:id/migration`                          | modo migración con consentimiento                     |
| `GET /sessions/:id/export/contacts.xlsx`                | Excel de contactos                                    |
| `GET /sessions/:id/export/conversations.xlsx`           | Excel de conversaciones (modo migración)              |
| `GET` · `POST /sessions/:id/privacy`                    | filtro personal / laboral: lista, decisiones, aprobar |
| `POST /sessions/:id/ventaplay/validate` · `/import`     | validar (en seco) e importar al CRM                   |
| `GET /sessions/:id/ventaplay`                           | avance, registro de lo enviado, estado del filtro     |
| `POST /sessions/:id/ventaplay/contacts/plan` · `/start` | clientes del CRM como contactos en el WhatsApp        |
| `POST /sessions/:id/assistant`                          | modo asistente (dueño)                                |
| `GET /sessions/:id/personal/*`                          | Mi vista, búsqueda, media, transcripción (dueño)      |
| `GET` · `POST /sessions/:id/projects`                   | chats aislados como proyecto                          |
| `POST /sessions/:id/logout` · `DELETE /sessions/:id`    | desvincular y borrar                                  |

La lista completa está en [`apps/api/src/http/server.ts`](apps/api/src/http/server.ts).

## Producción

- **API**: proceso siempre encendido (no serverless). `apps/api/Dockerfile` sirve para
  Railway, Fly.io o un VPS. Obligatorias: `NODE_ENV=production`, `ENCRYPTION_KEY` y
  `SUPABASE_URL` o `API_TOKEN`. Con `STORAGE=postgres` las tablas `wa_bridge_*` se crean
  solas, con RLS.
- **Web**: build estático (`apps/web/dist`), por ejemplo en Vercel, con `VITE_API_URL`.
- El servidor tiene que poder abrir un WebSocket a `web.whatsapp.com`.

## Límites que conviene saber

- **No es oficial.** Usa [Baileys](https://github.com/WhiskeySockets/Baileys), que habla el
  protocolo de WhatsApp Web. Leer baja mucho el riesgo, pero cada número vinculado es un
  número que se podría perder. Úsalo para migrar y respaldar; para operar el negocio, la
  plataforma oficial.
- **El teléfono decide cuánto historial entrega**, y solo al vincular. Si alguien cambió de
  teléfono sin respaldo, el historial parte desde ese día.
- **Datos de terceros**: pide consentimiento por escrito antes de vincular un WhatsApp que no
  es tuyo y usa el filtro antes de llevar nada a otro sistema.

## Contribuir

Nos encantaría que este proyecto le sirva a otros negocios y equipos. Ideas donde una mano
suma mucho:

- **Otros CRM**: un adaptador de importación además de VentaPlay (HubSpot, Odoo, Pipedrive…).
- **El filtro** en otros rubros e idiomas: palabras y reglas para talleres, restaurantes,
  tiendas, inglés o portugués.
- **Interfaz en inglés** (hoy está en español).
- **Archivos**: llevar fotos y documentos al CRM (hoy van como nota).
- **Más herramientas MCP** para el asistente.

Los cambios entran por Pull Request desde un fork; lee [CONTRIBUTING.md](CONTRIBUTING.md). Si
encontraste una vulnerabilidad, escríbenos según [SECURITY.md](SECURITY.md).

## Licencia

[MIT](LICENSE) © 2026 Tecnologías Legit SpA (VentaPlay).
