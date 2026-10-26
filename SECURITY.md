# Seguridad

Si encuentras una vulnerabilidad (fuga de credenciales, forma de saltarse el modo solo lectura,
acceso a la bóveda cifrada, etc.), **no abras un issue público**. Escribe a
**alejandro@ventaplay.com** con el detalle y los pasos para reproducirla. Respondemos a la
brevedad y coordinamos la corrección antes de publicarla.

El Bridge maneja conversaciones personales de terceros. Nos tomamos en serio cualquier forma de
que algo salga sin la aprobación de la persona dueña del WhatsApp (por ejemplo, saltarse el
filtro personal / laboral o la aprobación final antes de cargar a un CRM).

Si lo despliegas, ten en cuenta:

- Genera tu propia `ENCRYPTION_KEY` y un `API_TOKEN` largo; nunca uses los valores de ejemplo
  fuera de tu computador.
- `.env` y `apps/api/data/` nunca van al repo (ya están en `.gitignore`).
- `DEV_RUNNER=true` solo en tu equipo de desarrollo; la configuración lo bloquea en producción.
- Pide consentimiento por escrito antes de vincular un WhatsApp que no es tuyo; el modo
  migración registra quién autorizó.
- Desvincular (desde la web o desde el teléfono, con `WIPE_ON_LOGOUT=true`) borra lo guardado
  de esa sesión.
