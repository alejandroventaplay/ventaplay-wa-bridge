import type { ComponentType } from 'react';
import type { ArchivedMessage } from '@wa-bridge/shared';

/** lo que recibe una acción extra en cada mensaje de un proyecto */
export interface MessageActionProps {
  sessionId: string;
  /** chat o grupo del proyecto */
  jid: string;
  m: ArchivedMessage;
}

interface LocalExtension {
  MessageAction?: ComponentType<MessageActionProps>;
}

/**
 * Extensiones locales opcionales: archivos `privado/web/*.tsx` en la raíz del repo.
 * Esa carpeta no se versiona (cada quien la ignora en su copia); si no existe, no hay nada.
 */
const modules = import.meta.glob<LocalExtension>('../../../../privado/web/*.tsx', {
  eager: true,
});

export const messageActions: ComponentType<MessageActionProps>[] = Object.values(modules)
  .map((mod) => mod.MessageAction)
  .filter((c): c is ComponentType<MessageActionProps> => Boolean(c));
