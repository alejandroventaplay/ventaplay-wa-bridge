import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataSet,
  type SignalDataTypeMap,
} from 'baileys';
import type { SessionStore } from '../store/types.js';

const CREDS_KEY = 'creds';

export interface StoredAuthState {
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
  /** true si hay un teléfono vinculado a estas credenciales */
  isLinked: () => boolean;
}

/**
 * Estado de autenticación de Baileys respaldado por nuestro SessionStore cifrado
 * (reemplaza a useMultiFileAuthState, que Baileys desaconseja para producción).
 */
export async function loadAuthState(
  store: SessionStore,
  sessionId: string,
): Promise<StoredAuthState> {
  const existing = await store.readAuth(sessionId, [CREDS_KEY]);
  const credsRaw = existing.get(CREDS_KEY);
  const creds: AuthenticationCreds = credsRaw
    ? (JSON.parse(credsRaw, BufferJSON.reviver) as AuthenticationCreds)
    : initAuthCreds();

  const keys = {
    get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
      const raw = await store.readAuth(
        sessionId,
        ids.map((id) => `${type}:${id}`),
      );
      const out: { [id: string]: SignalDataTypeMap[T] } = {};
      for (const id of ids) {
        const json = raw.get(`${type}:${id}`);
        if (json === undefined) continue;
        let value = JSON.parse(json, BufferJSON.reviver);
        if (type === 'app-state-sync-key' && value) {
          value = proto.Message.AppStateSyncKeyData.fromObject(value);
        }
        out[id] = value as SignalDataTypeMap[T];
      }
      return out;
    },
    set: async (data: SignalDataSet) => {
      const entries: Record<string, string | null> = {};
      for (const type of Object.keys(data) as (keyof SignalDataTypeMap)[]) {
        const byId = data[type];
        if (!byId) continue;
        for (const [id, value] of Object.entries(byId)) {
          entries[`${type}:${id}`] = value ? JSON.stringify(value, BufferJSON.replacer) : null;
        }
      }
      if (Object.keys(entries).length) await store.writeAuth(sessionId, entries);
    },
    clear: async () => {
      await store.clearAuth(sessionId);
    },
  };

  return {
    state: { creds, keys },
    saveCreds: () =>
      store.writeAuth(sessionId, { [CREDS_KEY]: JSON.stringify(creds, BufferJSON.replacer) }),
    isLinked: () => Boolean(creds.me?.id),
  };
}
