import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Cipher } from '../crypto.js';
import { HttpError } from '../session/manager.js';

/**
 * Claves de las APIs externas, guardadas cifradas (AES-256-GCM, la misma clave de la
 * bóveda) en DATA_DIR/integraciones.enc. Se cargan y cambian desde Configuración en la
 * web, no desde el .env. Si una clave no está guardada acá pero sí en el entorno, se usa
 * la del entorno (compatibilidad); la de Configuración manda.
 */

export type IntegrationId = 'anthropic' | 'openai' | 'ventaplay_melting';

export interface IntegrationDef {
  id: IntegrationId;
  name: string;
  /** para qué la usa el Bridge */
  description: string;
  /** variable de entorno heredada que también sirve */
  env: string;
  /** dónde se saca la clave */
  docsUrl: string;
  /** cómo empieza una clave válida (solo para avisar, no bloquea) */
  prefix: string | null;
  placeholder: string;
  /** se puede probar contra el proveedor */
  testable: boolean;
}

export const INTEGRATIONS: readonly IntegrationDef[] = [
  {
    id: 'anthropic',
    name: 'Anthropic (Claude)',
    description: 'Modelos Claude para leer documentos y redactar. Disponible para extensiones.',
    env: 'ANTHROPIC_API_KEY',
    docsUrl: 'https://console.anthropic.com/settings/keys',
    prefix: 'sk-ant-',
    placeholder: 'sk-ant-…',
    testable: true,
  },
  {
    id: 'openai',
    name: 'OpenAI',
    description: 'Modelos GPT y Whisper en la nube. Disponible para extensiones.',
    env: 'OPENAI_API_KEY',
    docsUrl: 'https://platform.openai.com/api-keys',
    prefix: 'sk-',
    placeholder: 'sk-proj-…',
    testable: true,
  },
  {
    id: 'ventaplay_melting',
    name: 'VentaPlay · flujo Melting',
    description:
      'API key de la organización Melting en VentaPlay: lee el resultado del flujo de facturas (éxito/fracaso, folio, total).',
    env: 'VENTAPLAY_MELTING_API_KEY',
    docsUrl: 'https://crm.ventaplay.com',
    prefix: null,
    placeholder: 'API key de la organización',
    testable: false,
  },
];

export interface IntegrationView {
  id: IntegrationId;
  name: string;
  description: string;
  docsUrl: string;
  placeholder: string;
  testable: boolean;
  /** dónde está la clave en uso */
  source: 'config' | 'env' | null;
  /** primeros y últimos caracteres, nunca la clave completa */
  masked: string | null;
  updatedAt: number | null;
  /** la clave guardada no tiene el formato esperado */
  warning: string | null;
}

interface Stored {
  value: string;
  updatedAt: number;
}

const MAX_LEN = 500;

export function maskKey(v: string): string {
  if (v.length <= 12) return `${v.slice(0, 2)}…${v.slice(-2)}`;
  return `${v.slice(0, 7)}…${v.slice(-4)}`;
}

export class IntegrationStore {
  private data: Partial<Record<IntegrationId, Stored>> = {};
  private loaded = false;

  constructor(
    private readonly file: string,
    private readonly cipher: Cipher,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async init(): Promise<void> {
    try {
      const blob = await readFile(this.file);
      this.data = JSON.parse(this.cipher.decryptString(blob)) as typeof this.data;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      this.data = {};
    }
    this.loaded = true;
  }

  private def(id: string): IntegrationDef {
    const d = INTEGRATIONS.find((x) => x.id === id);
    if (!d) throw new HttpError(404, 'integration_not_found', 'Esa integración no existe');
    return d;
  }

  /** la clave en uso (Configuración primero, después el entorno) o null */
  get(id: IntegrationId): string | null {
    const d = this.def(id);
    return this.data[id]?.value ?? (this.env[d.env]?.trim() || null);
  }

  list(): IntegrationView[] {
    return INTEGRATIONS.map((d) => {
      const stored = this.data[d.id];
      const envVal = this.env[d.env]?.trim() || null;
      const value = stored?.value ?? envVal;
      return {
        id: d.id,
        name: d.name,
        description: d.description,
        docsUrl: d.docsUrl,
        placeholder: d.placeholder,
        testable: d.testable,
        source: stored ? 'config' : envVal ? 'env' : null,
        masked: value ? maskKey(value) : null,
        updatedAt: stored?.updatedAt ?? null,
        warning:
          value && d.prefix && !value.startsWith(d.prefix)
            ? `No parece una clave de ${d.name}: debería empezar con "${d.prefix}"`
            : null,
      };
    });
  }

  async set(id: string, raw: string, now = Date.now()): Promise<IntegrationView> {
    const d = this.def(id);
    const value = raw.trim();
    if (!value) throw new HttpError(400, 'empty', 'Pega la clave');
    if (value.length > MAX_LEN || /\s/.test(value))
      throw new HttpError(400, 'invalid', 'La clave no puede tener espacios ni ser tan larga');
    this.data[d.id] = { value, updatedAt: now };
    await this.persist();
    return this.list().find((x) => x.id === d.id)!;
  }

  async remove(id: string): Promise<IntegrationView> {
    const d = this.def(id);
    delete this.data[d.id];
    await this.persist();
    return this.list().find((x) => x.id === d.id)!;
  }

  /** prueba la clave contra el proveedor (lista de modelos: no gasta tokens) */
  async test(id: string): Promise<{ ok: boolean; message: string }> {
    const d = this.def(id);
    const key = this.get(d.id);
    if (!key) return { ok: false, message: 'No hay clave guardada' };
    if (!d.testable) return { ok: false, message: 'Esta integración no tiene prueba automática' };
    const req: { url: string; headers: Record<string, string> } =
      d.id === 'anthropic'
        ? {
            url: 'https://api.anthropic.com/v1/models?limit=1',
            headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
          }
        : {
            url: 'https://api.openai.com/v1/models',
            headers: { authorization: `Bearer ${key}` },
          };
    try {
      const res = await this.fetchFn(req.url, {
        headers: req.headers,
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return { ok: true, message: `${d.name} respondió: la clave funciona` };
      if (res.status === 401 || res.status === 403)
        return { ok: false, message: `${d.name} rechazó la clave (${res.status})` };
      return { ok: false, message: `${d.name} respondió ${res.status}` };
    } catch (err) {
      return { ok: false, message: `No pude conectar con ${d.name}: ${(err as Error).message}` };
    }
  }

  private async persist(): Promise<void> {
    if (!this.loaded) throw new Error('IntegrationStore sin init()');
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, this.cipher.encryptString(JSON.stringify(this.data)), { mode: 0o600 });
    await rename(tmp, this.file);
  }
}
