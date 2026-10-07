import { BrowserRouter, Route, Routes, Link } from 'react-router';
import { RefreshCw, ServerCrash } from 'lucide-react';
import { AuthProvider, useAuth } from './hooks/auth';
import { API_URL } from './lib/api';
import { FullScreenMessage, Logo, Spinner } from './components/ui';
import { HomePage } from './pages/HomePage';
import { LoginPage } from './pages/LoginPage';
import { SessionPage } from './pages/SessionPage';

function Gate() {
  const { state, retry } = useAuth();
  if (state.phase === 'loading') {
    return (
      <FullScreenMessage>
        <Logo className="justify-center" />
        <Spinner className="mx-auto mt-6 size-6 text-violeta" />
      </FullScreenMessage>
    );
  }
  if (state.phase === 'api-down') {
    return (
      <FullScreenMessage>
        <ServerCrash className="mx-auto size-10 text-danger" />
        <h1 className="mt-4 text-lg font-black">La API no responde</h1>
        <p className="mt-2 text-sm text-ink-soft">{state.message}</p>
        <p className="mt-1 break-all font-mono text-xs text-ink-soft">{API_URL}</p>
        <button className="btn-primary mt-6" onClick={retry}>
          <RefreshCw className="size-4" /> Reintentar
        </button>
      </FullScreenMessage>
    );
  }
  if (state.phase === 'signed-out') return <LoginPage />;
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/s/:id" element={<SessionPage />} />
      <Route
        path="*"
        element={
          <FullScreenMessage>
            <p className="text-lg font-black">Página no encontrada</p>
            <Link className="btn-primary mt-6" to="/">
              Ir al inicio
            </Link>
          </FullScreenMessage>
        }
      />
    </Routes>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Gate />
      </AuthProvider>
    </BrowserRouter>
  );
}
