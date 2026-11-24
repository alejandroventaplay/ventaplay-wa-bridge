import { fileURLToPath } from 'node:url';
import type { IncomingMessage } from 'node:http';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

// En local la web no pide token: el proxy toma API_TOKEN de apps/api/.env y lo agrega
// solo a las llamadas que vienen de este mismo Mac. Desde otro equipo de la red se sigue pidiendo.
const apiEnvDir = fileURLToPath(new URL('../api', import.meta.url));
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const isLocal = (req: IncomingMessage) => LOOPBACK.has(req.socket.remoteAddress ?? '');

export default defineConfig(({ mode }) => {
  const apiToken = process.env.API_TOKEN ?? loadEnv(mode, apiEnvDir, '').API_TOKEN;
  return {
    plugins: [react(), tailwindcss()],
    // las extensiones locales (privado/web) usan las mismas copias de estas librerías
    resolve: { dedupe: ['react', 'react-dom', 'lucide-react'] },
    server: {
      port: 5190,
      strictPort: true,
      host: true,
      // la web habla con la API por el mismo origen (/wa-api) para evitar CORS y bloqueos del navegador
      proxy: {
        '/wa-api': {
          target: process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:4010',
          changeOrigin: true,
          rewrite: (p: string) => p.replace(/^\/wa-api/, ''),
          configure: (proxy: {
            on: (
              ev: 'proxyReq',
              fn: (
                proxyReq: { setHeader: (k: string, v: string) => void },
                req: IncomingMessage,
              ) => void,
            ) => void;
          }) => {
            if (!apiToken) return;
            proxy.on('proxyReq', (proxyReq, req) => {
              if (isLocal(req)) proxyReq.setHeader('authorization', `Bearer ${apiToken}`);
            });
          },
        },
      },
    },
    test: { environment: 'jsdom', include: ['src/**/*.test.{ts,tsx}'] },
  } as never;
});
