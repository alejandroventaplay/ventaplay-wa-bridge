import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
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
      },
    },
  },
  test: { environment: 'jsdom', include: ['src/**/*.test.{ts,tsx}'] },
} as never);
