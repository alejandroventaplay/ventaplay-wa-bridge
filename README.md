# VentaPlay WA Bridge

Herramienta interna de VentaPlay: vincula un WhatsApp **por QR** como dispositivo
y **lee** sus contactos, chats e historial para migrarlos a VentaPlay.

> **Solo lectura, por diseño.** No envía mensajes, no marca chats como leídos y no
> aparece "en línea". Los métodos de escritura de Baileys quedan bloqueados en el
> socket (`apps/api/src/wa/read-only.ts`), un test revisa que sigan bloqueados y una
> regla de ESLint impide llamarlos.

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

Requisitos: Node 22 y pnpm 10 (`corepack enable`).

```bash
pnpm install
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env
pnpm dev            # API en :4000 y web en :5173
```

Abre http://localhost:5173 y entra con el `API_TOKEN` del `.env`.

- **Con el simulador** (`WA_DRIVER=simulator`, viene así por defecto): aparece un
  botón "Simular escaneo" que trae un historial falso.
- **Con WhatsApp real**: cambia a `WA_DRIVER=baileys` en `apps/api/.env`, reinicia y
  escanea con el teléfono (WhatsApp → Dispositivos vinculados → Vincular un dispositivo).
  Deja el teléfono encendido mientras se copia el historial.

> El servidor tiene que poder abrir un **WebSocket** a `web.whatsapp.com`. Algunos
> proxies corporativos o sandboxes lo bloquean: en ese caso conecta, pero WhatsApp
> cierra la conexión antes de mostrar el QR (código 428).

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

| Método y ruta                | Para qué                                      |
| ---------------------------- | --------------------------------------------- |
| `GET /health`                | estado, driver, tipo de auth                  |
| `GET /sessions`              | lista de sesiones                             |
| `POST /sessions` `{label}`   | crea una sesión y arranca el QR               |
| `GET /sessions/:id`          | resumen (estado, QR, perfil, estadísticas)    |
| `GET /sessions/:id/events`   | SSE: QR que rota, estado y sync en vivo       |
| `GET /events`                | SSE de todas las sesiones                     |
| `POST /sessions/:id/connect` | QR nuevo / reintentar                         |
| `POST /sessions/:id/logout`  | desvincula el teléfono, conserva estadísticas |
| `DELETE /sessions/:id`       | desvincula y borra todo                       |

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
