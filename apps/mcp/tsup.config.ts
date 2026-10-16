import { defineConfig } from 'tsup';

// Un solo archivo con todas las dependencias adentro: la extensión .mcpb no trae node_modules
export default defineConfig({
  entry: { index: 'src/index.ts' },
  outDir: 'bundle/server',
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  bundle: true,
  noExternal: [/.*/],
  splitting: false,
  sourcemap: false,
  clean: true,
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
});
