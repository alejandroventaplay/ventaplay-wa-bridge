import { useEffect, useState, type ReactNode } from 'react';
import {
  BookOpen,
  Check,
  Download,
  Package,
  PlugZap,
  Server,
  Sparkles,
  Smartphone,
  Terminal,
} from 'lucide-react';
import { api } from '../lib/api';
import { Spinner } from './ui';

type FileKey =
  | 'wa-bridge-kit.zip'
  | 'wa-bridge.zip'
  | 'whatsapp-asistente.mcpb'
  | 'skill-whatsapp-asistente.zip'
  | 'INSTALAR.md';

function DownloadButton({
  file,
  children,
  primary = false,
}: {
  file: FileKey;
  children: ReactNode;
  primary?: boolean;
}) {
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  async function go() {
    setState('busy');
    setError(null);
    try {
      await api.download(file);
      setState('done');
      setTimeout(() => setState('idle'), 2500);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo descargar');
      setState('error');
    }
  }
  return (
    <span className="inline-flex flex-col gap-1">
      <button
        className={primary ? 'btn-primary' : 'btn-secondary'}
        onClick={() => void go()}
        disabled={state === 'busy'}
      >
        {state === 'busy' ? (
          <Spinner className="size-4" />
        ) : state === 'done' ? (
          <Check className="size-4" />
        ) : (
          <Download className="size-4" />
        )}
        {children}
      </button>
      {error && <span className="text-xs text-danger">{error}</span>}
    </span>
  );
}

function Piece({
  n,
  icon,
  title,
  file,
  fileLabel,
  children,
}: {
  n: number;
  icon: ReactNode;
  title: string;
  file: FileKey;
  fileLabel: string;
  children: ReactNode;
}) {
  return (
    <div className="card flex flex-col gap-3 p-5">
      <div className="flex items-center gap-3">
        <span className="grid size-10 place-items-center rounded-xl bg-violeta-5 text-violeta">
          {icon}
        </span>
        <div className="min-w-0">
          <p className="text-xs font-bold text-ink-soft">Paso {n}</p>
          <p className="font-black text-ink">{title}</p>
        </div>
      </div>
      <div className="flex-1 space-y-2 text-sm text-ink-soft">{children}</div>
      <DownloadButton file={file}>{fileLabel}</DownloadButton>
    </div>
  );
}

function Step({ n, children }: { n: number; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="grid size-6 shrink-0 place-items-center rounded-full bg-violeta text-xs font-black text-white">
        {n}
      </span>
      <span className="min-w-0 pt-0.5">{children}</span>
    </li>
  );
}

/**
 * Descargables para que cualquiera tenga lo mismo: el Bridge, el conector para
 * Claude Desktop y la skill, con la guía paso a paso.
 */
export function ShareKit() {
  const [info, setInfo] = useState<{ available: boolean; connectorVersion: string | null } | null>(
    null,
  );
  useEffect(() => {
    let alive = true;
    api
      .downloadsInfo()
      .then((i) => alive && setInfo(i))
      .catch(() => alive && setInfo({ available: false, connectorVersion: null }));
    return () => {
      alive = false;
    };
  }, []);
  if (info && !info.available) return null;

  return (
    <section className="mt-12">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="flex items-center gap-2 text-2xl font-black tracking-tight">
            <Package className="size-6 text-violeta" /> Instala y comparte tu asistente
          </h2>
          <p className="mt-1 max-w-2xl text-ink-soft">
            Todo lo necesario para que otra persona tenga esta misma conexión en su computador: el
            Bridge, el conector para Claude y la skill. Sus mensajes quedan en su equipo, no en el
            tuyo.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <DownloadButton file="INSTALAR.md">
            <BookOpen className="size-4" /> Guía
          </DownloadButton>
          <DownloadButton file="wa-bridge-kit.zip" primary>
            Kit completo (.zip)
          </DownloadButton>
        </div>
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        <Piece
          n={1}
          icon={<Server className="size-5" />}
          title="El Bridge"
          file="wa-bridge.zip"
          fileLabel="ventaplay-wa-bridge.zip"
        >
          <p>
            La app que se vincula a WhatsApp por QR y guarda los mensajes cifrados en el equipo.
          </p>
          <p>
            Requiere <b>Node.js 22+</b> (
            <a
              className="font-bold text-violeta hover:underline"
              href="https://nodejs.org"
              target="_blank"
              rel="noreferrer"
            >
              nodejs.org
            </a>
            ). Se descomprime en la carpeta de usuario y se abre con <b>Iniciar-WA-Bridge</b>.
          </p>
        </Piece>
        <Piece
          n={2}
          icon={<PlugZap className="size-5" />}
          title="El conector para Claude"
          file="whatsapp-asistente.mcpb"
          fileLabel={`WhatsApp-Asistente.mcpb${info?.connectorVersion ? ` · v${info.connectorVersion}` : ''}`}
        >
          <p>
            Une <b>Claude Desktop</b> con el Bridge: leer, buscar, pendientes, transcribir y enviar
            (siempre con confirmación).
          </p>
          <p>Doble clic para instalarlo y elegir la carpeta del Bridge.</p>
        </Piece>
        <Piece
          n={3}
          icon={<Sparkles className="size-5" />}
          title="La skill"
          file="skill-whatsapp-asistente.zip"
          fileLabel="skill-whatsapp-asistente.zip"
        >
          <p>
            Le enseña a Claude cómo usar el conector: recetas, cómo encontrar el chat correcto y las
            reglas para enviar.
          </p>
          <p>
            Claude → <b>Configuración → Capacidades → Skills → Subir skill</b> (el zip tal cual).
          </p>
        </Piece>
      </div>

      <div className="card mt-4 grid gap-6 p-6 lg:grid-cols-2">
        <div>
          <p className="mb-3 flex items-center gap-2 font-black text-ink">
            <Terminal className="size-4 text-violeta" /> Instalar el Bridge
          </p>
          <ol className="space-y-3 text-sm text-ink-soft">
            <Step n={1}>
              Instalar <b>Node.js 22+</b> y <b>Claude Desktop</b>.
            </Step>
            <Step n={2}>
              Descomprimir el zip y dejar la carpeta{' '}
              <code className="text-ink">ventaplay-wa-bridge</code> en la carpeta de usuario.
            </Step>
            <Step n={3}>
              Doble clic en <b>Iniciar-WA-Bridge.command</b> (Mac: la primera vez, clic derecho →{' '}
              <b>Abrir</b>) o <b>Iniciar-WA-Bridge.cmd</b> (Windows). Se abre{' '}
              <code className="text-ink">localhost:5190</code>; dejar la ventana negra abierta.
            </Step>
          </ol>
        </div>
        <div>
          <p className="mb-3 flex items-center gap-2 font-black text-ink">
            <Smartphone className="size-4 text-violeta" /> Activar el asistente
          </p>
          <ol className="space-y-3 text-sm text-ink-soft">
            <Step n={4}>
              <b>Conectar WhatsApp</b> → <b>Activar asistente</b> → escanear el QR desde{' '}
              <i>WhatsApp → Dispositivos vinculados</i>.
            </Step>
            <Step n={5}>
              Instalar el <b>conector</b> (doble clic) y subir la <b>skill</b> en Claude.
            </Step>
            <Step n={6}>
              Probar en Claude: <i>“¿Qué tengo pendiente en WhatsApp?”</i>
            </Step>
          </ol>
        </div>
      </div>
    </section>
  );
}
