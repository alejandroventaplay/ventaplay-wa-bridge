import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { zipSync, type Zippable } from 'fflate';

/**
 * Descargables para compartir el WA Bridge: el código para instalarlo, el conector
 * para Claude (.mcpb) y la skill. Todo se arma al vuelo desde la carpeta del
 * proyecto, así siempre va la versión que está corriendo.
 */

const run = promisify(execFile);

/** carpeta raíz del monorepo (donde está pnpm-workspace.yaml) */
export function findRepoRoot(start = process.cwd()): string | null {
  let dir = resolve(start);
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/** nunca van en el paquete: credenciales, mensajes, dependencias, builds */
const EXCLUDE_DIRS = new Set(['node_modules', '.git', 'dist', '.dev-runner', '.turbo', '.vite']);
const EXCLUDE_PATHS = ['apps/api/data'];
function excluded(rel: string): boolean {
  const parts = rel.split('/');
  if (parts.some((p) => EXCLUDE_DIRS.has(p))) return true;
  if (EXCLUDE_PATHS.some((p) => rel === p || rel.startsWith(`${p}/`))) return true;
  const base = parts.at(-1) ?? '';
  if (/^\.env(\..*)?$/.test(base) && base !== '.env.example') return true;
  if (base === '.DS_Store' || base.endsWith('.log') || base.endsWith('.mcpb')) return true;
  return false;
}

async function walk(root: string, dir = root, out: string[] = []): Promise<string[]> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const abs = join(dir, e.name);
    const rel = relative(root, abs).split(sep).join('/');
    if (excluded(rel)) continue;
    if (e.isDirectory()) await walk(root, abs, out);
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

/** archivos del proyecto: los de git si hay repo (sin basura sin versionar), si no, la carpeta */
export async function projectFiles(root: string): Promise<string[]> {
  if (existsSync(join(root, '.git'))) {
    try {
      const { stdout } = await run('git', ['ls-files', '-z'], {
        cwd: root,
        maxBuffer: 32 * 1024 * 1024,
      });
      const files = stdout.split('\0').filter((f) => f && !excluded(f));
      const present = await Promise.all(files.map(async (f) => existsSync(join(root, f))));
      return files.filter((_, i) => present[i]);
    } catch {
      /* sin git en el equipo: recorremos la carpeta */
    }
  }
  return walk(root);
}

/** ejecutables (lanzadores) quedan con permiso de ejecución al descomprimir en Mac */
const EXEC = /\.(command|sh)$/;

async function zipFiles(
  root: string,
  files: string[],
  prefix: string,
  extra: Record<string, string> = {},
): Promise<Buffer> {
  const entries: Zippable = {};
  for (const f of files) {
    const abs = join(root, f);
    const data = new Uint8Array(await readFile(abs));
    const mode = EXEC.test(f) ? 0o100755 : ((await stat(abs)).mode & 0o777) | 0o100000;
    entries[`${prefix}${f}`] = [data, { os: 3, attrs: (mode & 0xffff) << 16 }];
  }
  for (const [name, text] of Object.entries(extra)) {
    entries[`${prefix}${name}`] = [
      new TextEncoder().encode(text),
      { os: 3, attrs: 0o100644 << 16 },
    ];
  }
  return Buffer.from(zipSync(entries, { level: 6 }));
}

/** el proyecto completo para instalarlo en otro equipo (sin datos ni credenciales) */
export async function bridgeZip(root: string): Promise<Buffer> {
  const files = await projectFiles(root);
  return zipFiles(root, files, 'ventaplay-wa-bridge/');
}

/** el conector de Claude (.mcpb = zip de apps/mcp/bundle) */
export async function connectorMcpb(root: string): Promise<Buffer> {
  const bundle = join(root, 'apps/mcp/bundle');
  if (!existsSync(join(bundle, 'server/index.js')))
    throw new Error('El conector no está compilado (falta apps/mcp/bundle/server/index.js)');
  const files = await walk(bundle);
  return zipFiles(bundle, files, '');
}

/** la skill para Claude: carpeta con SKILL.md, lista para subir */
export async function skillZip(root: string): Promise<Buffer> {
  const dir = join(root, 'skills/whatsapp-asistente');
  if (!existsSync(join(dir, 'SKILL.md')))
    throw new Error('Falta skills/whatsapp-asistente/SKILL.md');
  const files = await walk(dir);
  return zipFiles(dir, files, 'whatsapp-asistente/');
}

/** versión del conector (para mostrarla en la web) */
export async function connectorVersion(root: string): Promise<string | null> {
  try {
    const m = JSON.parse(await readFile(join(root, 'apps/mcp/bundle/manifest.json'), 'utf8')) as {
      version?: string;
    };
    return m.version ?? null;
  } catch {
    return null;
  }
}

/** todo junto para mandárselo a alguien: las 3 piezas + la guía */
export async function kitZip(root: string): Promise<Buffer> {
  const [bridge, mcpb, skill] = await Promise.all([
    bridgeZip(root),
    connectorMcpb(root),
    skillZip(root),
  ]);
  const guide = existsSync(join(root, 'INSTALAR.md'))
    ? await readFile(join(root, 'INSTALAR.md'))
    : Buffer.from('Ver INSTALAR.md dentro de ventaplay-wa-bridge.zip\n');
  const file = (data: Uint8Array): [Uint8Array, { os: number; attrs: number }] => [
    data,
    { os: 3, attrs: 0o100644 << 16 },
  ];
  return Buffer.from(
    zipSync(
      {
        'WA-Bridge-kit/1-ventaplay-wa-bridge.zip': file(new Uint8Array(bridge)),
        'WA-Bridge-kit/2-WhatsApp-Asistente.mcpb': file(new Uint8Array(mcpb)),
        'WA-Bridge-kit/3-skill-whatsapp-asistente.zip': file(new Uint8Array(skill)),
        'WA-Bridge-kit/LEEME-INSTALAR.md': file(new Uint8Array(guide)),
      },
      { level: 0 },
    ),
  );
}

/** la guía de instalación (markdown) */
export async function installGuide(root: string): Promise<string | null> {
  try {
    return await readFile(join(root, 'INSTALAR.md'), 'utf8');
  } catch {
    return null;
  }
}
