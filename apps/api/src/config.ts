import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0', ''])
  .optional()
  .transform((v) => v === 'true' || v === '1');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(4010),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  /** archivo donde además se escriben los logs (opcional, útil para diagnosticar) */
  LOG_FILE: z.string().optional(),

  /** orígenes permitidos para CORS, separados por coma */
  WEB_ORIGIN: z.string().default('http://localhost:5190'),

  /** 'baileys' = WhatsApp real · 'simulator' = QR y datos falsos para desarrollar la UI */
  WA_DRIVER: z.enum(['baileys', 'simulator']).default('baileys'),
  /** proxy HTTP(S) para el WebSocket de WhatsApp (opcional) */
  WA_PROXY_URL: z.string().url().optional(),
  /**
   * Cómo nos presentamos ante WhatsApp. 'chrome' = WhatsApp Web (funciona).
   * 'desktop' = WhatsApp Desktop: pediría más historial, pero WhatsApp corta la
   * conexión al registrar (428 Connection Terminated, visto en oct-2026).
   */
  WA_BROWSER: z.enum(['chrome', 'desktop']).default('chrome'),
  /** 'latest' = consulta la versión vigente de WA Web · 'bundled' = la que trae Baileys */
  WA_VERSION: z.enum(['latest', 'bundled']).default('latest'),

  /** 'file' = carpeta local cifrada · 'postgres' = DATABASE_URL (Supabase) */
  STORAGE: z.enum(['file', 'postgres']).default('file'),
  DATA_DIR: z.string().default('./data'),
  DATABASE_URL: z.string().optional(),
  /** clave AES-256 (64 caracteres hex) para cifrar credenciales y datos de sesión */
  ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'ENCRYPTION_KEY debe ser 64 caracteres hex (32 bytes)')
    .optional(),

  /** Auth modo simple: token compartido del equipo */
  API_TOKEN: z.string().min(16, 'API_TOKEN debe tener al menos 16 caracteres').optional(),
  /** Auth modo Supabase: valida el JWT del usuario logueado */
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_JWT_SECRET: z.string().optional(),
  /** dominio(s) de correo permitidos con Supabase, separados por coma */
  ALLOWED_EMAIL_DOMAINS: z.string().default('ventaplay.com'),

  /** límite de sesiones simultáneas */
  MAX_SESSIONS: z.coerce.number().int().positive().default(20),
  /** borra las credenciales locales si WhatsApp desvincula el dispositivo */
  WIPE_ON_LOGOUT: bool.default(true),

  /** solo desarrollo local: acciones de una lista cerrada pedidas por archivo (ver src/dev) */
  DEV_RUNNER: bool.default(false),
});

export type Config = z.infer<typeof EnvSchema> & {
  webOrigins: string[];
  allowedEmailDomains: string[];
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // trata las variables vacías como no definidas
  const clean = Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== undefined && v !== ''),
  );
  const parsed = EnvSchema.safeParse(clean);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Configuración inválida:\n${issues}`);
  }
  const c = parsed.data;

  if (c.STORAGE === 'postgres' && !c.DATABASE_URL) {
    throw new Error('STORAGE=postgres requiere DATABASE_URL');
  }
  if (c.NODE_ENV === 'production') {
    if (!c.ENCRYPTION_KEY) throw new Error('En producción ENCRYPTION_KEY es obligatoria');
    if (!c.API_TOKEN && !c.SUPABASE_URL) {
      throw new Error('En producción configura SUPABASE_URL o API_TOKEN para proteger la API');
    }
    if (c.WA_DRIVER === 'simulator')
      throw new Error('WA_DRIVER=simulator no se permite en producción');
    if (c.DEV_RUNNER) throw new Error('DEV_RUNNER no se permite en producción');
  }

  return {
    ...c,
    webOrigins: c.WEB_ORIGIN.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    allowedEmailDomains: c.ALLOWED_EMAIL_DOMAINS.split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  };
}
