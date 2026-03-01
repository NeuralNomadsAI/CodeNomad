export const MESSAGE_ANCHOR_PREFIX = "message-anchor-"

export function getMessageAnchorId(messageId: string) {
  return `${MESSAGE_ANCHOR_PREFIX}${messageId}`
}

export function getMessageIdFromAnchorId(anchorId: string) {
  return anchorId.startsWith(MESSAGE_ANCHOR_PREFIX) ? anchorId.slice(MESSAGE_ANCHOR_PREFIX.length) : anchorId
}
