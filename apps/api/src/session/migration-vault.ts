import type { MessageLike } from './stats.js';
import { parseVaultMessage, type StoredMessage } from './message-vault.js';

/** prefijo de las claves en el SessionStore (junto a las credenciales, se borra con ellas) */
export const MIGRATION_KEY_PREFIX = 'migration:chat:';

/**
 * Conversaciones guardadas para migrar a VentaPlay (modo migración).
 *
 * A diferencia de la bóveda del dueño (300 mensajes / 90 días), aquí entra TODO lo que
 * llegue de cada chat, sin tope ni ventana, pero sin el mensaje original de WhatsApp
 * (la v1 no migra archivos). Se persiste cifrado como `migration:chat:<jid>` y se borra
 * con las credenciales al desvincular.
 */
export class MigrationVault {
  private chats = new Map<string, Map<string, StoredMessage>>();
  private dirty = new Set<string>();

  get size(): number {
    return this.chats.size;
  }

  /** Agrega mensajes (History Sync o en vivo). Devuelve cuántos cambiaron algo. */
  add(messages: MessageLike[]): number {
    let changed = 0;
    for (const m of messages) {
      const p = parseVaultMessage(m, null);
      if (!p) continue;
      const chat = this.chats.get(p.jid);
      if ('action' in p) {
        const msg = chat?.get(p.action.id);
        if (!msg) continue;
        if (p.action.type === 'revoke') {
          msg.kind = 'deleted';
          msg.text = null;
          msg.media = null;
          delete msg.location;
        } else if (p.action.edited) {
          msg.text = p.action.edited.text;
          msg.edited = true;
        } else continue;
        this.dirty.add(p.jid);
        changed += 1;
        continue;
      }
      const list = chat ?? new Map<string, StoredMessage>();
      const old = list.get(p.stored.id);
      // llega dos veces (historial + en vivo): conserva borrado / edición
      if (old && (old.kind === 'deleted' || old.edited)) continue;
      list.set(
        p.stored.id,
        old ? { ...p.stored, pushName: p.stored.pushName ?? old.pushName } : p.stored,
      );
      this.chats.set(p.jid, list);
      this.dirty.add(p.jid);
      changed += 1;
    }
    return changed;
  }

  /** chats guardados (jid → mensajes de más antiguo a más nuevo) */
  entries(): [string, StoredMessage[]][] {
    return [...this.chats.entries()].map(([jid, list]) => [jid, sorted(list)]);
  }

  counts(): { chats: number; messages: number } {
    let messages = 0;
    for (const list of this.chats.values()) messages += list.size;
    return { chats: this.chats.size, messages };
  }

  clear(): void {
    for (const jid of this.chats.keys()) this.dirty.add(jid);
    this.chats.clear();
  }

  /** cambios pendientes de guardar: clave → JSON (null = borrar) */
  takeDirty(): Record<string, string | null> {
    const out: Record<string, string | null> = {};
    for (const jid of this.dirty) {
      const list = this.chats.get(jid);
      out[MIGRATION_KEY_PREFIX + jid] = list?.size ? JSON.stringify(sorted(list)) : null;
    }
    this.dirty.clear();
    return out;
  }

  /** vuelve a marcar como pendientes (si falló el guardado) */
  markDirty(keys: string[]): void {
    for (const k of keys)
      if (k.startsWith(MIGRATION_KEY_PREFIX)) this.dirty.add(k.slice(MIGRATION_KEY_PREFIX.length));
  }

  /** carga lo guardado (clave del store → JSON) */
  load(entries: Map<string, string>): void {
    for (const [key, json] of entries) {
      if (!key.startsWith(MIGRATION_KEY_PREFIX)) continue;
      try {
        const list = JSON.parse(json) as StoredMessage[];
        if (!Array.isArray(list) || !list.length) continue;
        this.chats.set(key.slice(MIGRATION_KEY_PREFIX.length), new Map(list.map((m) => [m.id, m])));
      } catch {
        /* un archivo dañado no bota el resto */
      }
    }
  }
}

const sorted = (list: Map<string, StoredMessage>) =>
  [...list.values()].sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
