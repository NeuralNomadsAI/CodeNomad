interface MessageCacheItem {
  messageId: string
}

export interface MessageRenderCache {
  messageItems: Map<string, MessageCacheItem>
  toolItems: Map<string, MessageCacheItem>
  messageBlocks: Map<string, unknown>
}

const renderCaches = new Map<string, MessageRenderCache>()

export const REASONING_RENDER_CHARACTER_LIMIT = 10_000
export const REASONING_TITLE_CHARACTER_LIMIT = 384

// Native reasoning text is a string. The card windows the whole text with an
// exact reveal (`render-text-window`); speech and markers read a bounded prefix.
function extractReasoningText(part: unknown, characterLimit: number): string {
  const text = (part as { text?: unknown } | null)?.text
  if (typeof text !== "string") return ""
  const bounded = text.slice(0, characterLimit)
  return /\S/.test(bounded) ? bounded : ""
}

export function extractReasoningTextForRender(part: unknown): string {
  return extractReasoningText(part, REASONING_RENDER_CHARACTER_LIMIT)
}

/** The whole native text, for copy and for the card's display window. */
export function extractWholeReasoningText(part: unknown): string {
  return extractReasoningText(part, Number.POSITIVE_INFINITY)
}

export function extractReasoningTitleForRender(text: string): string {
  const bounded = text.slice(0, REASONING_TITLE_CHARACTER_LIMIT)
  const firstLine = bounded.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? ""
  return firstLine.match(/^\*\*([^*]+)\*\*/)?.[1]?.trim() ?? ""
}

function makeSessionCacheKey(instanceId: string, sessionId: string) {
  return `${instanceId}:${sessionId}`
}

export function getSessionMessageRenderCache(instanceId: string, sessionId: string): MessageRenderCache {
  const key = makeSessionCacheKey(instanceId, sessionId)
  let cache = renderCaches.get(key)
  if (!cache) {
    cache = { messageItems: new Map(), toolItems: new Map(), messageBlocks: new Map() }
    renderCaches.set(key, cache)
  }
  return cache
}

export function peekSessionMessageRenderCache(instanceId: string, sessionId: string): MessageRenderCache | undefined {
  return renderCaches.get(makeSessionCacheKey(instanceId, sessionId))
}

export function clearSessionMessageRenderCache(instanceId: string, sessionId: string): void {
  renderCaches.delete(makeSessionCacheKey(instanceId, sessionId))
}

export function clearInstanceMessageRenderCaches(instanceId: string): void {
  const prefix = `${instanceId}:`
  for (const key of renderCaches.keys()) if (key.startsWith(prefix)) renderCaches.delete(key)
}

export function purgeMessageRenderCache(cache: MessageRenderCache, messageIds: readonly string[]): void {
  const removed = new Set(messageIds)
  for (const messageId of removed) cache.messageBlocks.delete(messageId)
  for (const [key, item] of cache.messageItems) {
    if (removed.has(item.messageId)) cache.messageItems.delete(key)
  }
  for (const [key, item] of cache.toolItems) {
    if (removed.has(item.messageId)) cache.toolItems.delete(key)
  }
}
