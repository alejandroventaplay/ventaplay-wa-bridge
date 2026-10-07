import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { api, ApiError, tokenStore, type Health } from '../lib/api';
import { supabase } from '../lib/supabase';

type AuthState =
  | { phase: 'loading' }
  | { phase: 'api-down'; message: string }
  | { phase: 'signed-out'; health: Health; error?: string }
  | { phase: 'signed-in'; health: Health; email: string | null };

interface AuthApi {
  state: AuthState;
  /** login con API_TOKEN */
  loginWithToken: (token: string) => Promise<void>;
  /** login con Supabase (enlace mágico al correo) */
  sendMagicLink: (email: string) => Promise<void>;
  loginWithGoogle: () => Promise<void>;
  logout: () => Promise<void>;
  retry: () => void;
}

const Ctx = createContext<AuthApi | null>(null);
export const ALLOWED_DOMAIN = 'ventaplay.com';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ phase: 'loading' });
  const [attempt, setAttempt] = useState(0);

  const verify = useCallback(async (health: Health) => {
    if (health.auth === 'none') return setState({ phase: 'signed-in', health, email: null });
    try {
      const { principal } = await api.me();
      setState({ phase: 'signed-in', health, email: principal.email });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        tokenStore.clear();
        setState({ phase: 'signed-out', health });
      } else {
        setState({ phase: 'api-down', message: (err as Error).message });
      }
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unsub: (() => void) | undefined;
    (async () => {
      let health: Health;
      try {
        health = await api.health();
      } catch {
        if (!cancelled)
          setState({ phase: 'api-down', message: 'No pudimos conectar con la API del WA Bridge.' });
        return;
      }
      if (cancelled) return;
      await verify(health);
      if (supabase) {
        const { data } = supabase.auth.onAuthStateChange((event) => {
          if (event === 'SIGNED_IN' || event === 'SIGNED_OUT') void verify(health);
        });
        unsub = () => data.subscription.unsubscribe();
      }
    })();
    return () => {
      cancelled = true;
      unsub?.();
    };
  }, [attempt, verify]);

  const value = useMemo<AuthApi>(
    () => ({
      state,
      async loginWithToken(token) {
        if (state.phase !== 'signed-out') return;
        tokenStore.set(token.trim());
        try {
          const { principal } = await api.me();
          setState({ phase: 'signed-in', health: state.health, email: principal.email });
        } catch (err) {
          tokenStore.clear();
          if (err instanceof ApiError && err.status === 401)
            throw new Error('Token inválido', { cause: err });
          throw err;
        }
      },
      async sendMagicLink(email) {
        if (!supabase) throw new Error('Supabase no está configurado');
        const clean = email.trim().toLowerCase();
        if (!clean.endsWith(`@${ALLOWED_DOMAIN}`))
          throw new Error(`Usa tu correo @${ALLOWED_DOMAIN}`);
        const { error } = await supabase.auth.signInWithOtp({
          email: clean,
          options: { emailRedirectTo: window.location.origin, shouldCreateUser: true },
        });
        if (error) throw error;
      },
      async loginWithGoogle() {
        if (!supabase) throw new Error('Supabase no está configurado');
        const { error } = await supabase.auth.signInWithOAuth({
          provider: 'google',
          options: { redirectTo: window.location.origin, queryParams: { hd: ALLOWED_DOMAIN } },
        });
        if (error) throw error;
      },
      async logout() {
        tokenStore.clear();
        await supabase?.auth.signOut();
        setAttempt((a) => a + 1);
      },
      retry: () => setAttempt((a) => a + 1),
    }),
    [state],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthApi {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth fuera de AuthProvider');
  return v;
}
