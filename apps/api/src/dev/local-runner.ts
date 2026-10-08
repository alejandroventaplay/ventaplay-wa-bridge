import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from 'pino';

/**
 * Ayudante de desarrollo local (DEV_RUNNER=true, nunca en producción).
 *
 * Permite que Claude, que solo puede escribir archivos en la carpeta del proyecto,
 * pida acciones de una lista cerrada en el Mac donde corre `pnpm dev`: escribe el
 * nombre de la acción en `.dev-runner/request` y el resultado queda en
 * `.dev-runner/last.log`. No ejecuta nada que no esté en ACTIONS.
 */
export const ACTIONS = {
  /** sube los commits a GitHub (usa el login de `gh` del Mac) */
  push: { cmd: 'git', args: ['push', '-u', 'origin', 'HEAD'] },
  /** instala dependencias nuevas */
  install: { cmd: 'pnpm', args: ['install'] },
  /** estado del repo */
  status: { cmd: 'git', args: ['status', '-sb'] },
} as const satisfies Record<string, { cmd: string; args: readonly string[] }>;

export type RunnerAction = keyof typeof ACTIONS | 'restart';

export function parseRequest(raw: string): RunnerAction | null {
  const a = raw.trim().toLowerCase();
  return a === 'restart' || a in ACTIONS ? (a as RunnerAction) : null;
}

export interface LocalRunnerOptions {
  /** raíz del repo */
  root: string;
  logger: Logger;
  /** archivo que, al tocarlo, hace que `tsx watch` reinicie la API */
  restartTouchFile: string;
  pollMs?: number;
  timeoutMs?: number;
}

export function startLocalRunner(opts: LocalRunnerOptions): () => void {
  const dir = join(opts.root, '.dev-runner');
  const request = join(dir, 'request');
  const log = join(dir, 'last.log');
  mkdirSync(dir, { recursive: true });
  let busy = false;

  const finish = (action: string, code: number | string, output: string) => {
    writeFileSync(
      log,
      `acción: ${action}\nfecha: ${new Date().toISOString()}\nresultado: ${code}\n\n${output}`,
    );
    opts.logger.info({ action, code }, 'dev-runner: acción terminada');
  };

  const tick = () => {
    if (busy || !existsSync(request)) return;
    const raw = readFileSync(request, 'utf8');
    rmSync(request, { force: true });
    const action = parseRequest(raw);
    if (!action) {
      finish(raw.trim().slice(0, 40), 'rechazada', 'Acción no permitida.');
      return;
    }
    opts.logger.info({ action }, 'dev-runner: ejecutando');
    if (action === 'restart') {
      finish(action, 0, 'Reiniciando la API…');
      const now = new Date();
      utimesSync(opts.restartTouchFile, now, now);
      return;
    }
    busy = true;
    const { cmd, args } = ACTIONS[action];
    execFile(
      cmd,
      [...args],
      { cwd: opts.root, timeout: opts.timeoutMs ?? 5 * 60_000, env: process.env },
      (err, stdout, stderr) => {
        busy = false;
        const code = err ? ((err as { code?: number | string }).code ?? 1) : 0;
        finish(action, code, `${stdout}${stderr}`.slice(-20_000));
      },
    );
  };

  const timer = setInterval(tick, opts.pollMs ?? 2000);
  timer.unref();
  opts.logger.warn({ dir }, 'dev-runner activo: acepta push, install, status y restart');
  return () => clearInterval(timer);
}
