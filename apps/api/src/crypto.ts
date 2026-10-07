import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;
/** versión del formato, por si algún día rotamos el esquema */
const VERSION = 1;

/**
 * Cifrado simétrico AES-256-GCM. Todo lo que guardamos de una sesión
 * (credenciales de WhatsApp, perfil, estadísticas) pasa por aquí.
 * Formato: [version(1) | iv(12) | tag(16) | ciphertext]
 */
export class Cipher {
  private readonly key: Buffer;

  constructor(keyHex: string) {
    const key = Buffer.from(keyHex, 'hex');
    if (key.length !== 32) throw new Error('La clave de cifrado debe tener 32 bytes');
    this.key = key;
  }

  encrypt(plain: string | Buffer): Buffer {
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv(ALGO, this.key, iv);
    const data = Buffer.concat([cipher.update(plain), cipher.final()]);
    return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), data]);
  }

  decrypt(blob: Buffer): Buffer {
    if (blob.length < 1 + IV_LEN + TAG_LEN || blob[0] !== VERSION) {
      throw new Error('Blob cifrado inválido o de versión desconocida');
    }
    const iv = blob.subarray(1, 1 + IV_LEN);
    const tag = blob.subarray(1 + IV_LEN, 1 + IV_LEN + TAG_LEN);
    const data = blob.subarray(1 + IV_LEN + TAG_LEN);
    const decipher = createDecipheriv(ALGO, this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]);
  }

  encryptString(plain: string): Buffer {
    return this.encrypt(Buffer.from(plain, 'utf8'));
  }

  decryptString(blob: Buffer): string {
    return this.decrypt(blob).toString('utf8');
  }
}

/**
 * En desarrollo, si no hay ENCRYPTION_KEY, generamos una y la dejamos en DATA_DIR
 * para que las sesiones sobrevivan reinicios. En producción la clave es obligatoria.
 */
export async function resolveDevKey(path: string): Promise<{ key: string; generated: boolean }> {
  try {
    const key = (await readFile(path, 'utf8')).trim();
    if (/^[0-9a-f]{64}$/i.test(key)) return { key, generated: false };
  } catch {
    /* no existe todavía */
  }
  const key = randomBytes(32).toString('hex');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, key + '\n', { mode: 0o600 });
  return { key, generated: true };
}
