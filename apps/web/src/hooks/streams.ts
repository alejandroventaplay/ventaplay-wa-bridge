import { useEffect, useRef, useState } from 'react';
import type { SessionStreamEvent, SessionSummary } from '@wa-bridge/shared';
import { api, ApiError, streamUrl } from '../lib/api';

type StreamStatus = 'connecting' | 'live' | 'retrying';

/**
 * Se suscribe a un stream SSE de la API. EventSource reintenta solo los cortes de red;
 * si el servidor responde error (p.ej. token vencido) lo cerramos y volvemos a abrir
 * con un token fresco.
 */
function useSse(
  path: string | null,
  onEvent: (ev: SessionStreamEvent) => void,
  onFatal?: (err: unknown) => void,
) {
  const [status, setStatus] = useState<StreamStatus>('connecting');
  const handler = useRef(onEvent);
  const fatal = useRef(onFatal);
  // mantener los callbacks al día sin reabrir el stream
  useEffect(() => {
    handler.current = onEvent;
    fatal.current = onFatal;
  });

  useEffect(() => {
    if (!path) return;
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const open = async () => {
      const url = await streamUrl(path);
      if (closed) return;
      es = new EventSource(url);
      es.onopen = () => setStatus('live');
      const onMsg = (e: MessageEvent<string>) => {
        try {
          handler.current(JSON.parse(e.data) as SessionStreamEvent);
        } catch {
          /* evento malformado */
        }
      };
      es.addEventListener('snapshot', onMsg as EventListener);
      es.addEventListener('deleted', onMsg as EventListener);
      es.onerror = () => {
        setStatus('retrying');
        if (es?.readyState === EventSource.CLOSED) {
          es.close();
          retry = setTimeout(() => void open(), 3000);
          fatal.current?.(new Error('stream cerrado'));
        }
      };
    };
    void open();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      es?.close();
    };
  }, [path]);

  return status;
}

export function useSessionStream(id: string | undefined) {
  const [session, setSession] = useState<SessionSummary | null>(null);
  const [gone, setGone] = useState(false);
  const status = useSse(
    id ? `/sessions/${id}/events` : null,
    (ev) => {
      if (ev.type === 'snapshot') setSession(ev.session);
      if (ev.type === 'deleted') setGone(true);
    },
    () => {
      // ¿el stream murió porque la sesión ya no existe?
      if (!id) return;
      api.get(id).catch((err) => {
        if (err instanceof ApiError && err.status === 404) setGone(true);
      });
    },
  );
  return { session, setSession, gone, stream: status };
}

export function useSessionsStream() {
  const [map, setMap] = useState<Map<string, SessionSummary>>(new Map());
  const [loaded, setLoaded] = useState(false);
  const status = useSse('/events', (ev) => {
    setLoaded(true);
    setMap((prev) => {
      const next = new Map(prev);
      if (ev.type === 'snapshot') next.set(ev.session.id, ev.session);
      else next.delete(ev.id);
      return next;
    });
  });
  // la lista puede estar vacía: el stream no manda nada en ese caso
  useEffect(() => {
    if (status === 'live') {
      const t = setTimeout(() => setLoaded(true), 400);
      return () => clearTimeout(t);
    }
  }, [status]);
  const sessions = [...map.values()].sort((a, b) => b.createdAt - a.createdAt);
  return { sessions, loaded, stream: status };
}

/** re-render cada `ms` (para cuentas regresivas y "hace X min") */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
