import { useState, type FormEvent } from 'react';
import { KeyRound, Mail } from 'lucide-react';
import { ALLOWED_DOMAIN, useAuth } from '../hooks/auth';
import { supabase } from '../lib/supabase';
import { Logo, Spinner } from '../components/ui';

export function LoginPage() {
  const { state, loginWithToken, sendMagicLink, loginWithGoogle } = useAuth();
  const health = state.phase === 'signed-out' ? state.health : null;
  const useSupabase = Boolean(supabase && health?.auth.includes('supabase'));
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(
    state.phase === 'signed-out' ? (state.error ?? null) : null,
  );

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (useSupabase) {
        await sendMagicLink(value);
        setSent(true);
      } else {
        await loginWithToken(value);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative grid min-h-screen place-items-center overflow-hidden bg-canvas p-6">
      <div className="pointer-events-none absolute -left-32 -top-32 size-[28rem] rounded-full bg-violeta/10 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-40 -right-24 size-[26rem] rounded-full bg-turquesa/15 blur-3xl" />
      <div className="card relative w-full max-w-md p-8">
        <Logo />
        <h1 className="mt-8 text-2xl font-black">WA Bridge</h1>
        <p className="mt-1 text-sm text-ink-soft">
          Vincula tu WhatsApp por QR: respaldo de contactos y chats, o tu asistente personal.
        </p>

        {sent ? (
          <div className="mt-8 rounded-xl bg-violeta-5 p-4 text-sm">
            Te enviamos un enlace a <b>{value}</b>. Ábrelo desde este navegador para entrar.
          </div>
        ) : (
          <form onSubmit={submit} className="mt-8 space-y-4">
            <div>
              <label className="label" htmlFor="cred">
                {useSupabase ? 'Tu correo de VentaPlay' : 'Token de acceso'}
              </label>
              <div className="relative">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-soft">
                  {useSupabase ? <Mail className="size-4" /> : <KeyRound className="size-4" />}
                </span>
                <input
                  id="cred"
                  className="input pl-9"
                  type={useSupabase ? 'email' : 'password'}
                  autoComplete={useSupabase ? 'email' : 'current-password'}
                  placeholder={useSupabase ? `nombre@${ALLOWED_DOMAIN}` : 'API_TOKEN del servidor'}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  required
                />
              </div>
            </div>
            {error && <p className="text-sm font-bold text-danger">{error}</p>}
            <button className="btn-primary w-full" disabled={busy || !value}>
              {busy && <Spinner className="size-4" />}
              {useSupabase ? 'Enviarme un enlace' : 'Entrar'}
            </button>
            {useSupabase && (
              <button
                type="button"
                className="btn-secondary w-full"
                onClick={() => void loginWithGoogle()}
              >
                Entrar con Google
              </button>
            )}
          </form>
        )}
        <p className="mt-8 text-center text-xs text-ink-soft">
          Herramienta interna · solo equipo VentaPlay
        </p>
      </div>
    </div>
  );
}
