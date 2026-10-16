# VentaPlay WA Bridge

Herramienta interna de VentaPlay: vincula un WhatsApp **por QR** como dispositivo
y **lee** sus contactos, chats e historial para migrarlos a VentaPlay.

> **Solo lectura, por diseño.** No envía mensajes, no marca chats como leídos y no
> aparece "en línea". Los métodos de escritura de Baileys quedan bloqueados en el
> socket (`apps/api/src/wa/read-only.ts`), un test revisa que sigan bloqueados y una
> regla de ESLint impide llamarlos.

## Mi vista (solo tu número)

Si el WhatsApp vinculado es el del dueño (`OWNER_PHONE` en `apps/api/.env`), la
sesión muestra dos pestañas: **Mi vista** y **General** (la de siempre).

- Mi vista separa **Conversaciones** y **Grupos** y los muestra como WhatsApp: los
  chats con actividad en los **últimos 30 días** y sus **últimos 10 mensajes**, con
  fotos, audios, videos, stickers y documentos (si WhatsApp ya no tiene el archivo,
  se ve la miniatura).
- Es la única excepción a "no guardar contenido": esos mensajes se guardan
  **cifrados** junto a las credenciales y se **borran al desconectar**. Con cualquier
  otro número no se guarda nada y la pestaña no aparece.
- Sigue siendo **solo lectura**: no envía, no marca como leído, no pide al teléfono
  re-subir archivos vencidos.
- El contenido llega por el History Sync al vincular y luego en vivo. Si el número
  se vinculó antes de activar `OWNER_PHONE`, hay que volver a vincularlo una vez.

## Claude como asistente de tu WhatsApp

`apps/mcp` es un conector MCP (extensión `.mcpb` para la app de Claude) que llama al
Bridge de tu Mac. Herramientas: `whatsapp_estado`, `whatsapp_listar_chats`,
`whatsapp_leer_chat`, `whatsapp_buscar`, `whatsapp_pendientes`, `whatsapp_enviar` y
`whatsapp_enviar_archivo` (fotos o archivos del Mac por su ruta).

- Se instala una vez con doble clic en `WhatsApp-Alejandro.mcpb`. Lee el token y el
  puerto de `apps/api/.env`, así que no hay que pegar nada.
- Para el asistente se guardan hasta **300 mensajes por chat de los últimos 90 días**
  (cifrados). Mi vista sigue mostrando 30 días y 10 mensajes.
- **Enviar** solo funciona con `ALLOW_SEND=true` y `OWNER_PHONE`. Texto, fotos, videos,
  audios y documentos (máx. 16 MB; JPG/PNG/MP4 van en línea, lo demás como documento),
  solo a chats que ya existen y con frenos: 8 por minuto, 40 por hora, 150 al día y unos
  segundos entre mensajes al mismo chat. El log no guarda el texto ni el archivo. Claude siempre
  muestra el destinatario y el texto y espera tu confirmación. El resto del candado
  sigue cerrado: no marca leído, no cambia presencia, no toca grupos.
- **Mi vista** tiene caja para escribir: Enter envía, Shift+Enter salto de línea, clip
  para adjuntar, pegar o arrastrar un archivo, y opción de mandar una foto como documento.
- Regenerar el conector: `pnpm --filter @wa-bridge/mcp pack` → `apps/mcp/dist/whatsapp-alejandro.mcpb`.

## Sprint 1 — qué hay

- QR con la marca de VentaPlay (logo al centro, corrección de errores alta) que se
  renueva solo, con cuenta regresiva.
- Conectar y desconectar. El botón "Desconectar" desvincula el dispositivo en el
  teléfono y borra las credenciales.
- Información general al conectar: perfil (nombre, número, foto, Business,
  categoría), contactos, chats, grupos, mensajes, rango de fechas del historial,
  progreso del History Sync en vivo y los 10 chats con más mensajes.
- Varias sesiones a la vez, con reconexión automática si se reinicia el servidor.
- Credenciales y datos de cada sesión **cifrados** (AES-256-GCM) en disco o en
  Postgres (Supabase).
- Login: token compartido (`API_TOKEN`) o Supabase Auth, solo con correos `@ventaplay.com`.
- Modo **simulador** para desarrollar la UI sin teléfono.

## Estructura

```
apps/api         Fastify + Baileys v7 · sesiones, QR, SSE, cifrado
apps/web         Vite + React + Tailwind · UI con la marca VentaPlay
packages/shared  tipos compartidos (SessionSummary, SyncStats…)
```

## Correr en local

Requisitos: Node 22 o más. pnpm se instala solo si falta.

**En Mac, con doble clic:** abre `Iniciar-WA-Bridge.command` (la primera vez:
clic derecho → Abrir). Instala dependencias, levanta API y web y abre
http://localhost:5190.

**A mano:**

```bash
pnpm install
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env
pnpm dev            # API en :4010 y web en :5190
```

Abre http://localhost:5190 y entra con el `API_TOKEN` del `.env`.

- **Con el simulador** (`WA_DRIVER=simulator`, viene así en `.env.example`): aparece un
  botón "Simular escaneo" que trae un historial falso.
- **Con WhatsApp real**: cambia a `WA_DRIVER=baileys` en `apps/api/.env`, reinicia y
  escanea con el teléfono (WhatsApp → Dispositivos vinculados → Vincular un dispositivo).
  Deja el teléfono encendido mientras se copia el historial.

Notas:

- La web llama a la API por `/wa-api` (proxy de Vite al puerto 4010). Así comparten
  origen y ningún navegador bloquea las llamadas.
- Nos presentamos ante WhatsApp como **WhatsApp Web en Chrome** (`WA_BROWSER=chrome`).
  Como "WhatsApp Desktop" el teléfono daría más historial, pero hoy WhatsApp corta la
  conexión al registrar (código 428).
- Para diagnosticar, `LOG_FILE=./data/api.log` deja los logs también en un archivo.
- El servidor tiene que poder abrir un **WebSocket** a `web.whatsapp.com`. Algunos
  proxies o sandboxes lo bloquean (también da 428 antes del QR).

## Repositorio

`Subir-a-GitHub.command` (doble clic en Mac) crea el repo privado
`alejandroventaplay/ventaplay-wa-bridge` con GitHub CLI y sube el código; si ya
existe, solo hace `git push`. El login en GitHub lo hace la persona, en el navegador.

## Comandos

| Comando          | Qué hace                                  |
| ---------------- | ----------------------------------------- |
| `pnpm dev`       | API + web con recarga                     |
| `pnpm test`      | tests de API (vitest) y web               |
| `pnpm typecheck` | TypeScript estricto en todo el monorepo   |
| `pnpm lint`      | ESLint (incluye la regla de solo lectura) |
| `pnpm build`     | build de producción (`apps/*/dist`)       |

## API

Todas las rutas, salvo `/health`, piden `Authorization: Bearer <token>` (o
`?access_token=` en los streams SSE).

| Método y ruta                                        | Para qué                                                             |
| ---------------------------------------------------- | -------------------------------------------------------------------- |
| `GET /health`                                        | estado, driver, tipo de auth                                         |
| `GET /sessions`                                      | lista de sesiones                                                    |
| `POST /sessions` `{label}`                           | crea una sesión y arranca el QR                                      |
| `GET /sessions/:id`                                  | resumen (estado, QR, perfil, estadísticas)                           |
| `GET /sessions/:id/events`                           | SSE: QR que rota, estado y sync en vivo                              |
| `GET /events`                                        | SSE de todas las sesiones                                            |
| `GET /sessions/:id/export/contacts.xlsx`             | Excel de contactos y grupos (sin mensajes)                           |
| `GET /sessions/:id/personal/chats`                   | Mi vista: chats y grupos de los últimos 30 días (solo `OWNER_PHONE`) |
| `GET /sessions/:id/personal/chats/:jid/messages`     | Mi vista: últimos 10 mensajes del chat                               |
| `GET /sessions/:id/personal/chats/:jid/media/:msgId` | Mi vista: foto, audio, video o documento                             |
| `POST /sessions/:id/connect`                         | QR nuevo / reintentar                                                |
| `POST /sessions/:id/logout`                          | desvincula el teléfono, conserva estadísticas                        |
| `DELETE /sessions/:id`                               | desvincula y borra todo                                              |

## Producción

- **API**: necesita un proceso siempre encendido (no serverless). `apps/api/Dockerfile`
  sirve para Railway, Fly.io o un VPS. Variables obligatorias: `NODE_ENV=production`,
  `ENCRYPTION_KEY`, y `SUPABASE_URL` o `API_TOKEN`. Con `STORAGE=file` monta un
  volumen en `/app/data`; con `STORAGE=postgres` define `DATABASE_URL` (las tablas
  `wa_bridge_*` se crean solas, con RLS activado).
- **Web**: build estático (`apps/web/dist`), listo para Vercel. Variables:
  `VITE_API_URL` y, si se usa Supabase, `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY`.

## Riesgos conocidos

- Baileys no es oficial. Leer baja mucho el riesgo de bloqueo, pero cada número
  conectado es un número que podríamos perder. Desvincula apenas termine la migración.
- El teléfono decide cuánto historial entrega; la UI muestra el rango real recibido.
- Pide consentimiento por escrito al cliente antes de conectar su WhatsApp
  (incluye datos personales de terceros).
