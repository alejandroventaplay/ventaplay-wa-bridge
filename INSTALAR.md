# Instalar el WA Bridge y tu asistente de WhatsApp con Claude

> [!WARNING]
> **Uso personal y profesional, no empresarial.** Si lo usas para campañas, envíos
> masivos o cualquier cosa que viole las políticas de WhatsApp/Meta, **la probabilidad de
> que te bloqueen el número es ALTA**. Úsalo para tu propio WhatsApp, con mensajes uno a uno.

Con esto Claude puede leer, buscar y resumir tu WhatsApp, transcribir tus notas de voz y
(si lo permites) responder por ti, **siempre con tu confirmación**. Todo corre en **tu
computador**: tus mensajes no se suben a ningún servidor.

> ¿Buscas respaldar un WhatsApp donde se mezcla lo personal con el trabajo y pasar solo lo
> laboral a un CRM? Eso se hace desde la web del Bridge con **Migrar a VentaPlay**, el
> **filtro personal / interés laboral** y **Directo a VentaPlay**: ver el [README](README.md).
> Esta guía es para el asistente con Claude.

Son 3 piezas:

| Pieza          | Archivo                        | Qué es                                                         |
| -------------- | ------------------------------ | -------------------------------------------------------------- |
| 1. El Bridge   | `ventaplay-wa-bridge.zip`      | La app que se vincula a tu WhatsApp por QR (como WhatsApp Web) |
| 2. El conector | `WhatsApp-Asistente.mcpb`      | Une Claude Desktop con el Bridge                               |
| 3. La skill    | `skill-whatsapp-asistente.zip` | Le enseña a Claude cómo usarlo bien y con qué reglas           |

## Antes de empezar

- Mac o Windows, con unos 2 GB libres (el modelo de voz pesa ~500 MB).
- **Node.js 22 o más**: descárgalo de <https://nodejs.org> (botón "LTS") e instálalo.
- **Claude Desktop**: <https://claude.ai/download>.
- Tu teléfono con WhatsApp a mano.

## 1. Instalar el Bridge

1. Descomprime `ventaplay-wa-bridge.zip` y deja la carpeta **`ventaplay-wa-bridge`** en tu
   carpeta de usuario (en Mac: la casita con tu nombre en Finder; en Windows:
   `C:\Users\tu-nombre`).
2. Ábrela y haz doble clic en el lanzador:
   - **Mac:** `Iniciar-WA-Bridge.command`. La primera vez macOS lo bloquea: clic derecho →
     **Abrir** → **Abrir**.
   - **Windows:** `Iniciar-WA-Bridge.cmd`. Si aparece "Windows protegió su PC": **Más
     información** → **Ejecutar de todas formas**.
3. La primera vez instala lo necesario (unos minutos). Después se abre solo
   <http://localhost:5190>. **Deja esa ventana negra abierta**: es el Bridge funcionando.

## 2. Vincular tu WhatsApp y activar el asistente

1. En <http://localhost:5190> toca **Conectar WhatsApp** y ponle un nombre (el tuyo).
2. Toca **Activar asistente**, revisa las opciones (transcribir notas de voz, permitir
   enviar) y acepta.
3. En el teléfono: WhatsApp → **Dispositivos vinculados** → **Vincular un dispositivo** →
   escanea el QR.
4. Espera a que copie tus últimos 90 días (unos minutos, con el teléfono con internet).

> Solo puede haber **un asistente** por computador. Puedes desactivarlo cuando quieras
> (botón **Asistente** → Desactivar) y se borra todo lo guardado.

## 3. Instalar el conector en Claude Desktop

1. Haz doble clic en `WhatsApp-Asistente.mcpb` (o en Claude Desktop: **Configuración →
   Extensiones** → arrastra el archivo).
2. Cuando pida la **Carpeta del WA Bridge**, elige la carpeta `ventaplay-wa-bridge` del
   paso 1.
3. Actívalo.

## 4. Instalar la skill

En Claude (desktop o web): **Configuración → Capacidades → Skills → Subir skill** y elige
`skill-whatsapp-asistente.zip` (sin descomprimir).

## 5. Probar

Abre una conversación nueva en Claude Desktop y escribe:

- "¿Qué tengo pendiente en WhatsApp?"
- "Resume el grupo _Familia_ de esta semana."
- "¿Qué me dijo _Juan_ en su último audio?"
- "Dile a _Juan_ que llego en 10." → Claude te muestra el mensaje y espera tu "sí".

## 6. Modo agente

Lo que más se usa: en Claude Desktop abre **Cowork** y encárgale tareas completas, no solo
preguntas. Por ejemplo:

- "Revisa qué me perdí en WhatsApp y en el correo, y prepárame las respuestas."
- "Explícame el audio que me mandó _Juan_ y propón qué contestarle."
- "Mándale a _Ana_ las mismas instrucciones que le pasé a _Pedro_."

Claude hace los pasos solo (leer, transcribir, buscar, redactar) y se detiene a pedirte el
"sí" antes de cada envío. Más ejemplos en el [README](README.md#modo-agente-lo-que-más-se-usa).

## Uso diario

- El Bridge tiene que estar corriendo: doble clic en el lanzador cada vez que prendas el
  computador (o déjalo abierto).
- **Seguir de cerca** un grupo: en _Mi vista_ → _Grupos_, toca el pin 📌. Queda en su
  propia pestaña con todo el historial, archivos y métricas por persona.

## Privacidad y seguridad

- Los mensajes se guardan **cifrados** en `ventaplay-wa-bridge/apps/api/data` de tu equipo.
- El Bridge no marca chats como leídos ni te pone "en línea".
- Enviar está apagado por defecto. Si lo activas: solo a chats que ya existen, con
  límites (8 por minuto, 40 por hora, 150 al día) y Claude siempre pide tu OK.
- Las notas de voz se transcriben en tu computador (Whisper); el audio no sale de ahí.

## Problemas comunes

| Síntoma                                | Solución                                                                                  |
| -------------------------------------- | ----------------------------------------------------------------------------------------- |
| Claude dice "El WA Bridge no responde" | Abre el lanzador y espera a que cargue <http://localhost:5190>.                           |
| "No encuentro Node"                    | Instala Node.js 22+ desde nodejs.org y vuelve a abrir el lanzador.                        |
| El QR expiró                           | Toca **Pedir QR nuevo** y escanéalo dentro de un minuto.                                  |
| "No hay un WhatsApp en modo asistente" | En tu sesión, **Activar asistente** y escanear.                                           |
| El conector no aparece en Claude       | Revisa en Configuración → Extensiones que esté activado y que la carpeta sea la correcta. |
