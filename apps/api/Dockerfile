# Imagen de la API (Railway / Fly.io / VPS). Construir desde la raíz del repo:
#   docker build -f apps/api/Dockerfile -t wa-bridge-api .
FROM node:22-slim AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --filter @wa-bridge/api...
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @wa-bridge/api build \
  && pnpm --filter @wa-bridge/api deploy --prod --legacy /out

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/package.json ./
COPY --from=build /repo/apps/api/dist ./dist
# STORAGE=file necesita un volumen persistente montado en /app/data
RUN mkdir -p /app/data && chown node:node /app/data
VOLUME ["/app/data"]
EXPOSE 4000
USER node
CMD ["node", "dist/index.js"]
