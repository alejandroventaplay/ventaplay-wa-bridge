import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  clean: true,
  // el paquete compartido se consume como fuente TS: lo incrustamos en el bundle
  noExternal: ['@wa-bridge/shared'],
});
