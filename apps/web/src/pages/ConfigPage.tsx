import { useEffect, useState, type FormEvent } from 'react';
import {
  CircleCheck,
  CircleX,
  ExternalLink,
  KeyRound,
  Pencil,
  PlugZap,
  ShieldCheck,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { api, type Integration } from '../lib/api';
import { fmtAgo } from '../lib/format';
import { AppShell, Spinner } from '../components/ui';

/**
 * Configuración: las APIs externas que usa el Bridge y sus claves. Se guardan cifradas en
 * este equipo (no en el .env) y el navegador solo ve una versión enmascarada.
 */
export function ConfigPage() {
  const [items, setItems] = useState<Integration[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .integrations()
      .then(setItems)
      .catch((e: Error) => setError(e.message));
  }, []);

  const replace = (i: Integration) =>
    setItems((cur) => cur?.map((x) => (x.id === i.id ? i : x)) ?? cur);

  return (
    <AppShell>
      <div className="mb-8">
        <h1 className="text-3xl font-black tracking-tight">Configuración</h1>
        <p className="mt-1 text-ink-soft">Las APIs externas que usa el Bridge y sus claves.</p>
      </div>

      <section>
        <div className="mb-3 flex items-center gap-2">
          <PlugZap className="size-5 text-violeta" />
          <h2 className="text-lg font-black">APIs externas</h2>
        </div>
        <p className="mb-4 flex items-start gap-2 rounded-xl bg-turquesa-10 px-4 py-3 text-sm text-turquesa-140">
          <ShieldCheck className="mt-0.5 size-4 shrink-0" />
          Se guardan cifradas en este computador, con la misma llave de tus mensajes. Acá solo se
          ven el inicio y el final de cada clave.
        </p>

        {error && (
          <p className="card mb-4 border-red-200 bg-red-50 p-4 text-sm text-red-800">{error}</p>
        )}
        {!items && !error ? (
          <div className="grid place-items-center py-16 text-violeta">
            <Spinner className="size-7" />
          </div>
        ) : (
          <ul className="grid gap-3">
            {items?.map((i) => (
              <IntegrationCard key={i.id} item={i} onChange={replace} />
            ))}
          </ul>
        )}
      </section>
    </AppShell>
  );
}

function IntegrationCard({
  item,
  onChange,
}: {
  item: Integration;
  onChange: (i: Integration) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState<'save' | 'test' | 'remove' | null>(null);
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  async function act(kind: 'save' | 'test' | 'remove', fn: () => Promise<void>) {
    setBusy(kind);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  function save(e: FormEvent) {
    e.preventDefault();
    void act('save', async () => {
      onChange(await api.saveIntegration(item.id, value));
      setValue('');
      setEditing(false);
      setTest(null);
    });
  }

  const configured = item.source !== null;

  return (
    <li className="card p-5">
      <div className="flex flex-wrap items-start gap-4">
        <span
          className={`grid size-11 shrink-0 place-items-center rounded-2xl ${
            configured ? 'bg-violeta-5 text-violeta' : 'bg-canvas text-ink-soft'
          }`}
        >
          <KeyRound className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-black">{item.name}</h3>
            {item.source === 'config' && (
              <span className="rounded-full bg-turquesa-10 px-2 py-0.5 text-xs font-bold text-turquesa-140">
                Configurada
              </span>
            )}
            {item.source === 'env' && (
              <span
                className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-bold text-amber-800"
                title="La está tomando de una variable de entorno. Guárdala acá para que quede en Configuración."
              >
                Desde variable de entorno
              </span>
            )}
            {!configured && (
              <span className="rounded-full bg-canvas px-2 py-0.5 text-xs font-bold text-ink-soft">
                Sin clave
              </span>
            )}
          </div>
          <p className="mt-0.5 text-sm text-ink-soft">{item.description}</p>
          {item.masked && (
            <p className="mt-2 flex flex-wrap items-center gap-2 text-sm">
              <code className="rounded-md bg-canvas px-2 py-0.5 font-mono">{item.masked}</code>
              {item.updatedAt && (
                <span className="text-xs text-ink-soft">guardada {fmtAgo(item.updatedAt)}</span>
              )}
            </p>
          )}
          {item.warning && (
            <p className="mt-2 flex items-center gap-1.5 text-sm font-semibold text-amber-700">
              <TriangleAlert className="size-4 shrink-0" /> {item.warning}
            </p>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          {item.testable && configured && (
            <button
              className="btn-secondary px-3 py-2"
              disabled={busy !== null}
              onClick={() =>
                void act('test', async () => setTest(await api.testIntegration(item.id)))
              }
            >
              {busy === 'test' ? <Spinner className="size-4" /> : <PlugZap className="size-4" />}
              Probar
            </button>
          )}
          {!editing && (
            <button className="btn-primary px-3 py-2" onClick={() => setEditing(true)}>
              <Pencil className="size-4" /> {configured ? 'Cambiar' : 'Agregar clave'}
            </button>
          )}
          {item.source === 'config' &&
            (confirmRemove ? (
              <button
                className="btn-danger-solid px-3 py-2"
                disabled={busy !== null}
                onClick={() =>
                  void act('remove', async () => {
                    onChange(await api.removeIntegration(item.id));
                    setConfirmRemove(false);
                    setTest(null);
                  })
                }
              >
                {busy === 'remove' ? <Spinner className="size-4" /> : <Trash2 className="size-4" />}
                Sí, borrar
              </button>
            ) : (
              <button
                className="btn-secondary px-3 py-2"
                onClick={() => setConfirmRemove(true)}
                title="Borrar la clave guardada"
                aria-label="Borrar la clave guardada"
              >
                <Trash2 className="size-4" />
              </button>
            ))}
        </div>
      </div>

      {editing && (
        <form
          onSubmit={save}
          className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-4"
        >
          <input
            className="input min-w-0 flex-1 font-mono"
            type="password"
            autoComplete="off"
            spellCheck={false}
            autoFocus
            placeholder={item.placeholder}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-label={`Clave de ${item.name}`}
          />
          <button className="btn-primary" disabled={!value.trim() || busy !== null}>
            {busy === 'save' && <Spinner className="size-4" />} Guardar
          </button>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => {
              setEditing(false);
              setValue('');
            }}
          >
            Cancelar
          </button>
          <a
            href={item.docsUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 px-2 text-sm font-semibold text-violeta hover:underline"
          >
            Dónde la saco <ExternalLink className="size-3.5" />
          </a>
        </form>
      )}

      {test && (
        <p
          className={`mt-3 flex items-center gap-1.5 text-sm font-semibold ${
            test.ok ? 'text-turquesa-140' : 'text-danger'
          }`}
        >
          {test.ok ? <CircleCheck className="size-4" /> : <CircleX className="size-4" />}
          {test.message}
        </p>
      )}
      {error && <p className="mt-3 text-sm font-semibold text-danger">{error}</p>}
    </li>
  );
}
