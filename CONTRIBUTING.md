# Contribuir al VentaPlay WA Bridge

Gracias por el interés. El proyecto es open source (licencia MIT) y lo mantiene VentaPlay.
La idea es que le sirva a cualquier negocio que atiende por un WhatsApp mezclado y quiere
pasar a un CRM con la plataforma oficial, y a quien quiera conectar su WhatsApp con Claude.
**Los cambios entran por Pull Request y solo el mantenedor (@alejandroventaplay) hace merge**.
Nadie más tiene permiso de escritura sobre `main`.

## Dónde una mano suma mucho

- **Adaptadores para otros CRM** además de VentaPlay (`apps/api/src/ventaplay/` es el ejemplo:
  validar en seco, importar por lotes, registro de lo enviado).
- **Filtro personal / laboral** (`apps/api/src/ventaplay/privacy.ts`): palabras y reglas para
  otros rubros e idiomas, siempre locales y explicables.
- **Interfaz en inglés** y otros idiomas.
- **Herramientas MCP** nuevas en `apps/mcp` y mejoras a la skill en `skills/`.

## Cómo proponer un cambio

1. Haz un **fork** y crea una rama desde `main` (`fix/…`, `feat/…`).
2. Corre el proyecto en local: `pnpm install` · `cp apps/api/.env.example apps/api/.env` ·
   `cp apps/web/.env.example apps/web/.env` · `pnpm dev`. Con `WA_DRIVER=simulator` (el valor
   por defecto) no necesitas un teléfono.
3. Antes de abrir el PR, deja todo en verde:

   ```bash
   pnpm lint && pnpm format:check && pnpm typecheck && pnpm test && pnpm build
   ```

4. Abre el PR contra `main` explicando qué cambia y por qué. El CI corre solo; el mantenedor
   revisa y mergea.

Para cambios grandes (funciones nuevas, arquitectura, dependencias pesadas) abre primero un
**issue** para conversarlo.

## Reglas del proyecto

- **Solo lectura por defecto.** No abras métodos de escritura del socket de Baileys fuera de los
  que ya existen (`apps/api/src/wa/read-only.ts` los bloquea; hay un test y una regla de ESLint
  que lo vigilan). Un PR que lo haga no se mergea. Las excepciones actuales son explícitas:
  - enviar: solo el número del dueño en modo asistente, con confirmación y los frenos de
    `apps/api/src/session/send-limiter.ts`;
  - crear o editar contactos: solo en modo migración y con la autorización de la persona
    dueña del WhatsApp.
- **Nada sale del Bridge sin permiso**: el filtro personal / laboral corre local, y cargar a un
  CRM exige la aprobación final cuando el filtro está activo. No mandes contenido de mensajes a
  servicios externos para clasificar.
- Nunca subas `.env`, credenciales ni contenido real de mensajes (tampoco en tests ni fixtures).
  Usa números falsos como `56912345678`.
- Código y UI en español; teléfonos en E.164; fechas en hora de Chile (`America/Santiago`).
- Formato con el Prettier y el ESLint del repo; TypeScript estricto.

## Reportar errores

Abre un issue con pasos para reproducir, versión de Node y sistema operativo. Si es una
vulnerabilidad de seguridad, lee [SECURITY.md](SECURITY.md) y **no** abras un issue público.

## Licencia

Al contribuir aceptas que tu aporte se publique bajo la licencia [MIT](LICENSE) del proyecto.
