import type { PersonalChatList, PersonalChatMessages, SessionSummary } from '@wa-bridge/shared';
import { storage } from './storage';
import { supabase } from './supabase';

export const API_URL = ((import.meta.env.VITE_API_URL as string | undefined) || '/wa-api').replace(
  /\/$/,
  '',
);
const TOKEN_KEY = 'wa-bridge-token';

export interface Health {
  ok: boolean;
  driver: 'baileys' | 'simulator';
  storage: 'file' | 'postgres';
  auth: 'supabase' | 'token' | 'supabase+token' | 'none';
  readOnly: true;
}

export interface ExportPreview {
  /** con nombre y celular */
  useful: number;
  total: number;
  /** sin número: solo ID interno de WhatsApp */
  noPhone: number;
  /** con número pero sin nombre */
  noName: number;
  groups: number;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** token manual (modo API_TOKEN) */
export const tokenStore = {
  get: () => storage.get(TOKEN_KEY),
  set: (t: string) => storage.set(TOKEN_KEY, t),
  clear: () => storage.remove(TOKEN_KEY),
};

/** token vigente: el JWT de Supabase si hay sesión, si no el API_TOKEN guardado */
export async function currentToken(): Promise<string | null> {
  if (supabase) {
    const { data } = await supabase.auth.getSession();
    if (data.session?.access_token) return data.session.access_token;
  }
  return tokenStore.get();
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await currentToken();
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });
  if (res.status === 204) return undefined as T;
  const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
  if (!res.ok)
    throw new ApiError(res.status, body.error ?? 'error', body.message ?? `Error ${res.status}`);
  return body as T;
}

export const api = {
  health: () => request<Health>('/health'),
  me: () => request<{ principal: { via: string; email: string | null } }>('/me'),
  list: () => request<{ sessions: SessionSummary[] }>('/sessions').then((r) => r.sessions),
  get: (id: string) =>
    request<{ session: SessionSummary }>(`/sessions/${id}`).then((r) => r.session),
  create: (label: string | null) =>
    request<{ session: SessionSummary }>('/sessions', {
      method: 'POST',
      body: JSON.stringify({ label }),
    }).then((r) => r.session),
  connect: (id: string) =>
    request<{ session: SessionSummary }>(`/sessions/${id}/connect`, { method: 'POST' }).then(
      (r) => r.session,
    ),
  logout: (id: string) =>
    request<{ session: SessionSummary }>(`/sessions/${id}/logout`, { method: 'POST' }).then(
      (r) => r.session,
    ),
  remove: (id: string) => request<void>(`/sessions/${id}`, { method: 'DELETE' }),
  simulateScan: (id: string) =>
    request<{ ok: true }>(`/sessions/${id}/simulate-scan`, { method: 'POST' }),
  /** cuántos contactos sirven para el CRM y cuántos quedan fuera */
  exportPreview: (id: string) => request<ExportPreview>(`/sessions/${id}/export/preview`),
  /** baja el Excel de contactos y lo guarda con el nombre que propone la API */
  downloadContactsXlsx: (id: string, modo: 'util' | 'completo') =>
    download(`/sessions/${id}/export/contacts.xlsx?modo=${modo}`),
  /** Mi vista: chats con actividad en los últimos 30 días */
  personalChats: (id: string) => request<PersonalChatList>(`/sessions/${id}/personal/chats`),
  /** Mi vista: últimos mensajes guardados de un chat */
  personalMessages: (id: string, jid: string) =>
    request<PersonalChatMessages>(
      `/sessions/${id}/personal/chats/${encodeURIComponent(jid)}/messages`,
    ),
};

export interface MediaBlob {
  url: string;
  /** WhatsApp ya no tenía el archivo: es la miniatura */
  thumbnail: boolean;
}

const mediaCache = new Map<string, Promise<MediaBlob>>();

/** Media de un mensaje como blob URL (el token va en el header; <img> no puede mandarlo). */
export function mediaBlob(id: string, jid: string, msgId: string): Promise<MediaBlob> {
  const key = `${id}|${jid}|${msgId}`;
  let p = mediaCache.get(key);
  if (!p) {
    p = (async () => {
      const token = await currentToken();
      const res = await fetch(
        `${API_URL}/sessions/${id}/personal/chats/${encodeURIComponent(jid)}/media/${encodeURIComponent(msgId)}`,
        { headers: token ? { authorization: `Bearer ${token}` } : {} },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
        throw new ApiError(
          res.status,
          body.error ?? 'error',
          body.message ?? `Error ${res.status}`,
        );
      }
      return {
        url: URL.createObjectURL(await res.blob()),
        thumbnail: res.headers.get('x-media-thumbnail') === '1',
      };
    })();
    p.catch(() => mediaCache.delete(key));
    mediaCache.set(key, p);
  }
  return p;
}

/** Descarga un archivo protegido (con el token en el header) y lo guarda en el equipo. */
async function download(path: string): Promise<string> {
  const token = await currentToken();
  const res = await fetch(`${API_URL}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    throw new ApiError(res.status, body.error ?? 'error', body.message ?? `Error ${res.status}`);
  }
  const name =
    /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'export.xlsx';
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return name;
}

/** URL del stream SSE (EventSource no permite headers: el token va en la query) */
export async function streamUrl(path: string): Promise<string> {
  const token = await currentToken();
  const u = new URL(`${API_URL}${path}`, window.location.origin);
  if (token) u.searchParams.set('access_token', token);
  return u.toString();
}
