import { useState } from 'react';
import { Bot, Lock, Mic, Send, ShieldCheck } from 'lucide-react';
import type { AssistantRequest, SessionSummary } from '@wa-bridge/shared';
import { Dialog, Spinner } from './ui';

type Toggles = Required<Pick<AssistantRequest, 'send' | 'transcribe' | 'autoTranscribe'>>;

function Toggle({
  checked,
  onChange,
  label,
  hint,
  icon,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint: string;
  icon: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <label
      className={`flex cursor-pointer items-start gap-3 rounded-xl border border-line p-3 ${
        disabled ? 'opacity-50' : 'hover:bg-canvas'
      }`}
    >
      <input
        type="checkbox"
        className="mt-1 size-4 accent-violeta"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 font-bold text-ink">
          {icon} {label}
        </span>
        <span className="block text-xs text-ink-soft">{hint}</span>
      </span>
    </label>
  );
}

function ToggleList({ value, onChange }: { value: Toggles; onChange: (v: Toggles) => void }) {
  return (
    <div className="space-y-2">
      <Toggle
        checked={value.transcribe}
        onChange={(transcribe) => onChange({ ...value, transcribe })}
        icon={<Mic className="size-4 text-turquesa-140" />}
        label="Transcribir notas de voz"
        hint="Whisper corre en este equipo; el audio no sale a ningún servicio."
      />
      <Toggle
        checked={value.autoTranscribe}
        disabled={!value.transcribe}
        onChange={(autoTranscribe) => onChange({ ...value, autoTranscribe })}
        icon={<Mic className="size-4 text-turquesa-140" />}
        label="Transcribir solas las que lleguen"
        hint="Si no, se transcriben con el botón cuando las abras."
      />
      <Toggle
        checked={value.send}
        onChange={(send) => onChange({ ...value, send })}
        icon={<Send className="size-4 text-violeta" />}
        label="Permitir enviar mensajes"
        hint="Solo texto y archivos a chats que ya existen, siempre con tu confirmación y con límites."
      />
    </div>
  );
}

/** tarjeta para pasar de respaldo a asistente */
export function AssistantOffer({
  session,
  onEnable,
}: {
  session: SessionSummary;
  onEnable: (req: AssistantRequest) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toggles, setToggles] = useState<Toggles>({
    send: false,
    transcribe: true,
    autoTranscribe: true,
  });
  const linked = ['connected', 'reconnecting', 'connecting'].includes(session.status);

  async function enable() {
    setBusy(true);
    setError(null);
    try {
      await onEnable({ enabled: true, ...toggles });
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo activar');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="card mb-6 flex flex-wrap items-center gap-4 border-violeta/20 bg-gradient-to-r from-violeta/5 to-turquesa/5 p-5">
        <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-violeta text-white">
          <Bot className="size-6" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-black text-ink">Usa este WhatsApp como tu asistente personal</p>
          <p className="text-sm text-ink-soft">
            Lee y busca tus chats, transcribe notas de voz, sigue grupos de cerca y (si quieres)
            responde con tu confirmación. Hoy está en <b>respaldo</b>: solo estadísticas, sin
            contenido.
          </p>
        </div>
        <button className="btn-primary" onClick={() => setOpen(true)}>
          <Bot className="size-4" /> Activar asistente
        </button>
      </div>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Activar modo asistente"
        footer={
          <>
            <button className="btn-secondary" onClick={() => setOpen(false)} data-autofocus>
              Cancelar
            </button>
            <button
              className="btn-primary"
              disabled={!consent || busy}
              onClick={() => void enable()}
            >
              {busy ? <Spinner className="size-4" /> : <ShieldCheck className="size-4" />}
              Activar y escanear QR
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <p>
            Desde ahora se guardan <b>tus mensajes cifrados en este equipo</b> (últimos 90 días, 300
            por chat) para que el asistente los lea. Nada se sube a otro servidor.
          </p>
          {linked && (
            <p className="rounded-xl bg-amber-50 px-3 py-2 text-amber-900">
              WhatsApp solo entrega el historial al vincular: vamos a{' '}
              <b>desvincular y pedirte un QR nuevo</b> para traer tus últimos 90 días.
            </p>
          )}
          <ToggleList value={toggles} onChange={setToggles} />
          <label className="flex cursor-pointer items-start gap-2 text-ink">
            <input
              type="checkbox"
              className="mt-1 size-4 accent-violeta"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
            />
            <span>
              Este WhatsApp es <b>mío</b> y acepto que se guarden mis mensajes en este equipo.
            </span>
          </label>
          {error && <p className="text-sm text-danger">{error}</p>}
          <p className="flex items-center gap-1.5 text-xs">
            <Lock className="size-3.5" /> Puede haber un solo asistente por instalación. Lo
            desactivas cuando quieras y se borra todo lo guardado.
          </p>
        </div>
      </Dialog>
    </>
  );
}

/** ajustes del asistente activo */
export function AssistantSettingsDialog({
  open,
  onClose,
  session,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  session: SessionSummary;
  onSave: (req: AssistantRequest) => Promise<void>;
}) {
  const a = session.assistant;
  const [toggles, setToggles] = useState<Toggles>({
    send: a?.send ?? false,
    transcribe: a?.transcribe ?? true,
    autoTranscribe: a?.autoTranscribe ?? true,
  });
  const [confirmOff, setConfirmOff] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(req: AssistantRequest) {
    setBusy(true);
    setError(null);
    try {
      await onSave(req);
      setConfirmOff(false);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo guardar');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Ajustes del asistente"
      footer={
        confirmOff ? (
          <>
            <button className="btn-secondary" onClick={() => setConfirmOff(false)} data-autofocus>
              No, volver
            </button>
            <button
              className="btn-danger-solid"
              disabled={busy}
              onClick={() => void save({ enabled: false })}
            >
              {busy && <Spinner className="size-4" />} Sí, desactivar y borrar
            </button>
          </>
        ) : (
          <>
            <button className="btn-secondary mr-auto" onClick={() => setConfirmOff(true)}>
              Desactivar asistente
            </button>
            <button
              className="btn-primary"
              disabled={busy}
              onClick={() => void save({ enabled: true, ...toggles })}
              data-autofocus
            >
              {busy && <Spinner className="size-4" />} Guardar
            </button>
          </>
        )
      }
    >
      {confirmOff ? (
        <p>
          Vuelve a <b>respaldo</b> y se <b>borran</b> los mensajes, transcripciones y pestañas
          guardadas en este equipo. Las estadísticas de General se mantienen.
        </p>
      ) : (
        <div className="space-y-3">
          <ToggleList value={toggles} onChange={setToggles} />
          {error && <p className="text-sm text-danger">{error}</p>}
        </div>
      )}
    </Dialog>
  );
}
