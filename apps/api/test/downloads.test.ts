import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  bridgeZip,
  connectorMcpb,
  findRepoRoot,
  kitZip,
  skillZip,
} from '../src/downloads/packages.js';

async function fakeRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'wa-dl-'));
  const put = async (rel: string, text = 'x') => {
    await mkdir(join(root, rel, '..'), { recursive: true });
    await writeFile(join(root, rel), text);
  };
  await put('pnpm-workspace.yaml', 'packages: []');
  await put('package.json', '{}');
  await put('INSTALAR.md', '# guía');
  await put('Iniciar-WA-Bridge.command', '#!/bin/zsh');
  await put('apps/api/.env', 'API_TOKEN=secreto');
  await put('apps/api/.env.example', 'API_TOKEN=');
  await put('apps/api/data/sessions/a.json', 'mensajes');
  await put('apps/api/src/index.ts', 'export {}');
  await put('node_modules/x/index.js', 'x');
  await put('apps/mcp/bundle/manifest.json', '{"version":"9.9.9"}');
  await put('apps/mcp/bundle/server/index.js', 'console.log(1)');
  await put('skills/whatsapp-asistente/SKILL.md', '---\nname: whatsapp-asistente\n---');
  return root;
}

describe('descargables', () => {
  it('el zip del Bridge no lleva credenciales, mensajes ni dependencias', async () => {
    const root = await fakeRepo();
    try {
      expect(findRepoRoot(join(root, 'apps/api'))).toBe(root);
      const files = Object.keys(unzipSync(new Uint8Array(await bridgeZip(root))));
      expect(files).toContain('ventaplay-wa-bridge/package.json');
      expect(files).toContain('ventaplay-wa-bridge/apps/api/.env.example');
      expect(files).toContain('ventaplay-wa-bridge/Iniciar-WA-Bridge.command');
      expect(files.some((f) => f.endsWith('/.env'))).toBe(false);
      expect(files.some((f) => f.includes('/data/'))).toBe(false);
      expect(files.some((f) => f.includes('node_modules'))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('arma el conector, la skill y el kit completo', async () => {
    const root = await fakeRepo();
    try {
      const mcpb = Object.keys(unzipSync(new Uint8Array(await connectorMcpb(root))));
      expect(mcpb.sort()).toEqual(['manifest.json', 'server/index.js']);
      const skill = Object.keys(unzipSync(new Uint8Array(await skillZip(root))));
      expect(skill).toEqual(['whatsapp-asistente/SKILL.md']);
      const kit = Object.keys(unzipSync(new Uint8Array(await kitZip(root))));
      expect(kit).toHaveLength(4);
      expect(kit).toContain('WA-Bridge-kit/LEEME-INSTALAR.md');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
