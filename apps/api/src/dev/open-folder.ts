import { spawn } from 'node:child_process';

/**
 * Abre una carpeta en el explorador de archivos del computador donde corre la API
 * (Finder en Mac, Explorador en Windows). Solo tiene sentido en local: la API corre
 * en el mismo equipo que tu navegador. No pasa por una shell: la ruta va como argumento.
 */
export function openerFor(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'darwin') return 'open';
  if (platform === 'win32') return 'explorer';
  return 'xdg-open';
}

export function openFolder(
  dir: string,
  platform: NodeJS.Platform = process.platform,
  run: typeof spawn = spawn,
): void {
  const child = run(openerFor(platform), [dir], { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}
