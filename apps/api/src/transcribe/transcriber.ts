import type { Logger } from 'pino';

/**
 * Transcripción de notas de voz, 100% local (Whisper en ONNX vía transformers.js).
 * El audio nunca sale del equipo: el modelo se baja una vez de Hugging Face y queda
 * en `cacheDir`. Una transcripción a la vez (es CPU intensiva).
 */
export interface Transcription {
  text: string;
  model: string;
  /** segundos de audio */
  seconds: number;
  /** milisegundos que tomó */
  tookMs: number;
}

export interface Transcriber {
  readonly model: string;
  transcribe(audio: Buffer, mimetype: string): Promise<Transcription>;
}

export const DEFAULT_WHISPER_MODEL = 'onnx-community/whisper-small';
const TARGET_RATE = 16_000;

/** el audio de WhatsApp (notas de voz) viene en OGG/Opus */
export function isSupportedAudio(mimetype: string | null | undefined): boolean {
  const m = (mimetype ?? '').toLowerCase();
  return m.startsWith('audio/ogg') || m.includes('opus');
}

export class UnsupportedAudioError extends Error {}

/** baja a 16 kHz promediando (filtro caja): suficiente para voz */
export function resampleTo16k(input: Float32Array, rate: number): Float32Array {
  if (rate === TARGET_RATE) return input;
  const ratio = rate / TARGET_RATE;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j]!;
    out[i] = end > start ? sum / (end - start) : 0;
  }
  return out;
}

/** mezcla a mono */
export function toMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0]!;
  const len = Math.min(...channels.map((c) => c.length));
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    let s = 0;
    for (const c of channels) s += c[i]!;
    out[i] = s / channels.length;
  }
  return out;
}

async function decodeOggOpus(audio: Buffer): Promise<{ pcm: Float32Array; seconds: number }> {
  const { OggOpusDecoder } = await import('ogg-opus-decoder');
  const decoder = new OggOpusDecoder();
  await decoder.ready;
  try {
    const { channelData, sampleRate } = await decoder.decodeFile(new Uint8Array(audio));
    if (!channelData.length || !channelData[0]?.length)
      throw new UnsupportedAudioError('El audio está vacío o no se pudo decodificar');
    const mono = toMono(channelData);
    return { pcm: resampleTo16k(mono, sampleRate), seconds: mono.length / sampleRate };
  } finally {
    decoder.free();
  }
}

type AsrPipeline = (
  audio: Float32Array,
  opts: Record<string, unknown>,
) => Promise<{ text: string } | { text: string }[]>;

export function createWhisperTranscriber(opts: {
  model?: string;
  cacheDir: string;
  logger: Logger;
}): Transcriber {
  const model = opts.model ?? DEFAULT_WHISPER_MODEL;
  const log = opts.logger.child({ mod: 'transcriber' });
  let pipe: Promise<AsrPipeline> | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  const load = () => {
    pipe ??= (async () => {
      const t0 = Date.now();
      log.info({ model }, 'cargando modelo de transcripción (la primera vez se descarga)');
      const T = await import('@huggingface/transformers');
      T.env.cacheDir = opts.cacheDir;
      T.env.allowLocalModels = false;
      const p = (await T.pipeline('automatic-speech-recognition', model, {
        dtype: { encoder_model: 'fp32', decoder_model_merged: 'q8' },
        device: 'cpu',
      })) as unknown as AsrPipeline;
      log.info({ model, ms: Date.now() - t0 }, 'modelo de transcripción listo');
      return p;
    })().catch((err: unknown) => {
      pipe = null; // reintenta la próxima vez
      throw err;
    });
    return pipe;
  };

  const run = async (audio: Buffer, mimetype: string): Promise<Transcription> => {
    if (!isSupportedAudio(mimetype))
      throw new UnsupportedAudioError(`Formato de audio no soportado (${mimetype})`);
    const t0 = Date.now();
    const { pcm, seconds } = await decodeOggOpus(audio);
    const asr = await load();
    const out = await asr(pcm, {
      language: 'spanish',
      task: 'transcribe',
      chunk_length_s: 30,
      stride_length_s: 5,
    });
    const text = (Array.isArray(out) ? out.map((o) => o.text).join(' ') : out.text)
      .replace(/\s+/g, ' ')
      .trim();
    return { text, model, seconds, tookMs: Date.now() - t0 };
  };

  return {
    model,
    transcribe(audio, mimetype) {
      const next = queue.then(() => run(audio, mimetype));
      queue = next.catch(() => undefined);
      return next;
    },
  };
}

/** para tests y el simulador: no baja modelos */
export function createFakeTranscriber(text = 'Transcripción de prueba'): Transcriber {
  return {
    model: 'fake',
    async transcribe() {
      return { text, model: 'fake', seconds: 1, tookMs: 0 };
    },
  };
}
