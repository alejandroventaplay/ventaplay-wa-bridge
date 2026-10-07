import { timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { Config } from '../config.js';

export interface Principal {
  via: 'token' | 'supabase' | 'none';
  sub: string;
  email: string | null;
}

export type AuthMode = 'supabase' | 'token' | 'supabase+token' | 'none';

export interface Authenticator {
  mode: AuthMode;
  authenticate(req: FastifyRequest): Promise<Principal | null>;
}

/** las únicas rutas que aceptan el token por query: EventSource no permite headers */
export const isStreamRoute = (url: string) => /\/events(\?|$)/.test(url);

/** Bearer del header, o `?access_token=` solo en los streams SSE. */
export function extractToken(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (h?.startsWith('Bearer ')) return h.slice(7).trim() || null;
  if (!isStreamRoute(req.url)) return null;
  const q = (req.query as Record<string, unknown> | undefined)?.access_token;
  return typeof q === 'string' && q ? q : null;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Dos formas de entrar:
 *  - Supabase Auth: JWT del usuario, solo correos de ALLOWED_EMAIL_DOMAINS (p.ej. @ventaplay.com)
 *  - API_TOKEN: token compartido (útil en local o para scripts internos)
 * Sin ninguna configurada (solo fuera de producción) la API queda abierta.
 */
export function createAuthenticator(config: Config): Authenticator {
  const supabaseUrl = config.SUPABASE_URL?.replace(/\/$/, '');
  const jwks = supabaseUrl
    ? createRemoteJWKSet(new URL(`${supabaseUrl}/auth/v1/.well-known/jwks.json`))
    : null;
  const hsSecret = config.SUPABASE_JWT_SECRET
    ? new TextEncoder().encode(config.SUPABASE_JWT_SECRET)
    : null;
  const apiToken = config.API_TOKEN ?? null;

  const mode: AuthMode =
    supabaseUrl && apiToken
      ? 'supabase+token'
      : supabaseUrl
        ? 'supabase'
        : apiToken
          ? 'token'
          : 'none';

  async function verifySupabase(token: string): Promise<Principal | null> {
    if (!supabaseUrl) return null;
    let payload: JWTPayload;
    try {
      const opts = { issuer: `${supabaseUrl}/auth/v1` };
      payload = hsSecret
        ? (await jwtVerify(token, hsSecret, opts)).payload
        : (await jwtVerify(token, jwks!, opts)).payload;
    } catch {
      return null;
    }
    if (payload.role !== 'authenticated') return null;
    // usuarios anónimos o con correo sin verificar no entran aunque digan @ventaplay.com
    if (payload.is_anonymous === true) return null;
    const meta = payload.user_metadata as { email_verified?: boolean } | undefined;
    if (meta?.email_verified === false) return null;
    const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : null;
    const domain = email?.split('@')[1];
    if (!email || !domain || !config.allowedEmailDomains.includes(domain)) return null;
    return { via: 'supabase', sub: String(payload.sub ?? email), email };
  }

  return {
    mode,
    async authenticate(req) {
      if (mode === 'none') return { via: 'none', sub: 'dev', email: null };
      const token = extractToken(req);
      if (!token) return null;
      if (apiToken && safeEqual(token, apiToken))
        return { via: 'token', sub: 'api-token', email: null };
      // los JWT tienen 3 partes separadas por punto
      if (token.split('.').length === 3) return verifySupabase(token);
      return null;
    },
  };
}
