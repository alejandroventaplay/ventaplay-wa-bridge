## Qué cambia

<!-- Qué hace este PR y por qué. Si cierra un issue: "Cierra #123". -->

## Checklist

- [ ] `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test && pnpm build` en verde
- [ ] No agrega escrituras al socket de WhatsApp para números que no son el dueño
- [ ] Sin `.env`, credenciales ni contenido real de mensajes (números falsos en tests)
- [ ] Probado en local (simulador o WhatsApp real)
