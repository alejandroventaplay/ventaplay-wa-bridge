/**
 * Candado de solo lectura.
 *
 * Este servicio existe para MIGRAR (leer) un WhatsApp, nunca para escribir en él:
 * enviar mensajes, marcar leídos o aparecer "en línea" desde un dispositivo no oficial
 * es justo lo que hace que WhatsApp bloquee números.
 *
 * Reemplazamos en el socket todos los métodos públicos que escriben o cambian algo,
 * para que ni nosotros ni un futuro cambio los pueda llamar por error.
 * Baileys llama a sus funciones internas por referencia, así que esto no afecta
 * el protocolo (acks, llaves, sincronización), solo la API pública.
 */
export const BLOCKED_METHODS = [
  // mensajes
  'sendMessage',
  'relayMessage',
  'sendReceipt',
  'sendReceipts',
  'readMessages',
  'sendPeerDataOperationMessage',
  'sendRawMessage',
  // primitivas de bajo nivel: Baileys las usa internamente por closure, no por esta API
  'sendNode',
  'query',
  'appPatch',
  'cleanDirtyBits',
  'issuePrivacyTokens',
  'updateMediaMessage',
  'sendRetryRequest',
  'createCallLink',
  // presencia / estado
  'sendPresenceUpdate',
  'presenceSubscribe',
  'updateProfileStatus',
  'updateProfileName',
  'updateProfilePicture',
  'removeProfilePicture',
  'updateBlockStatus',
  'updateLastSeenPrivacy',
  'updateOnlinePrivacy',
  'updateProfilePicturePrivacy',
  'updateStatusPrivacy',
  'updateReadReceiptsPrivacy',
  'updateGroupsAddPrivacy',
  'updateDefaultDisappearingMode',
  'updateMessagesPrivacy',
  'updateCallPrivacy',
  'updateDisableLinkPreviewsPrivacy',
  'updateMemberLabel',
  // chats
  'chatModify',
  'star',
  'addChatLabel',
  'removeChatLabel',
  'addMessageLabel',
  'removeMessageLabel',
  'addOrEditContact',
  'removeContact',
  'addLabel',
  'addOrEditQuickReply',
  'removeQuickReply',
  'rejectCall',
  // grupos y comunidades
  'groupCreate',
  'groupLeave',
  'groupUpdateSubject',
  'groupUpdateDescription',
  'groupParticipantsUpdate',
  'groupSettingUpdate',
  'groupMemberAddMode',
  'groupJoinApprovalMode',
  'groupRequestParticipantsUpdate',
  'groupInviteCode',
  'groupRevokeInvite',
  'groupAcceptInvite',
  'groupAcceptInviteV4',
  'groupRevokeInviteV4',
  'groupToggleEphemeral',
  'communityCreate',
  'communityCreateGroup',
  'communityLeave',
  'communityUpdateSubject',
  'communityUpdateDescription',
  'communityLinkGroup',
  'communityUnlinkGroup',
  'communityParticipantsUpdate',
  'communityRequestParticipantsUpdate',
  'communitySettingUpdate',
  'communityMemberAddMode',
  'communityJoinApprovalMode',
  'communityToggleEphemeral',
  'communityInviteCode',
  'communityRevokeInvite',
  'communityAcceptInvite',
  'communityAcceptInviteV4',
  'communityRevokeInviteV4',
  // canales
  'newsletterCreate',
  'newsletterFollow',
  'newsletterUnfollow',
  'newsletterMute',
  'newsletterUnmute',
  'newsletterUpdate',
  'newsletterReactMessage',
  'newsletterDelete',
  'newsletterUpdateName',
  'newsletterUpdateDescription',
  'newsletterUpdatePicture',
  'newsletterRemovePicture',
  'newsletterChangeOwner',
  'newsletterDemote',
  // negocio
  'productCreate',
  'productUpdate',
  'productDelete',
  'updateBussinesProfile',
  'updateCoverPhoto',
  'removeCoverPhoto',
] as const;

export class ReadOnlyViolation extends Error {
  constructor(method: string) {
    super(`WA Bridge es de solo lectura: "${method}" está bloqueado`);
    this.name = 'ReadOnlyViolation';
  }
}

/** Reemplaza los métodos de escritura del socket por stubs que lanzan error. Devuelve los bloqueados. */
export function enforceReadOnly<T extends object>(sock: T): string[] {
  const blocked: string[] = [];
  const target = sock as Record<string, unknown>;
  for (const name of BLOCKED_METHODS) {
    if (typeof target[name] === 'function') {
      target[name] = () => {
        throw new ReadOnlyViolation(name);
      };
      blocked.push(name);
    }
  }
  return blocked;
}
