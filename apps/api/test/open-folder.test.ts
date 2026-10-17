import { describe, expect, it } from 'vitest';
import { openerFor, openFolder } from '../src/dev/open-folder.js';

describe('abrir carpeta', () => {
  it('usa Finder en Mac, el Explorador en Windows y xdg-open en Linux, sin shell', () => {
    expect(openerFor('darwin')).toBe('open');
    expect(openerFor('win32')).toBe('explorer');
    expect(openerFor('linux')).toBe('xdg-open');
    const calls: unknown[][] = [];
    const fake = ((cmd: string, args: string[], opts: unknown) => {
      calls.push([cmd, args, opts]);
      return { on: () => {}, unref: () => {} };
    }) as never;
    openFolder('/Users/a/carpeta con "comillas"', 'darwin', fake);
    expect(calls[0]?.[0]).toBe('open');
    expect(calls[0]?.[1]).toEqual(['/Users/a/carpeta con "comillas"']);
  });
});
