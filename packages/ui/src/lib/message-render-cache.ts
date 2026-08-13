interface MessageCacheItem {
  messageId: string
}

export interface MessageRenderCache {
  messageItems: Map<string, MessageCacheItem>
  toolItems: Map<string, MessageCacheItem>
  messageBlocks: Map<string, unknown>
  recordDisplayCache: Map<string, unknown>
}

const renderCaches = new Map<string, MessageRenderCache>()

export const REASONING_RENDER_CHARACTER_LIMIT = 10_000
export const REASONING_RENDER_NODE_LIMIT = 1_000
export const REASONING_TITLE_CHARACTER_LIMIT = 384

interface TraversalCursor {
  array: unknown[]
  index: number
}

function isTraversalCursor(item: unknown): item is TraversalCursor {
  if (!item || typeof item !== "object") return false
  const cursor = item as Partial<TraversalCursor>
  return Array.isArray(cursor.array) && typeof cursor.index === "number"
}

function extractReasoningSource(source: unknown, characterLimit: number, nodeLimit: number): string {
  const pieces: string[] = []
  const stack: unknown[] = [source]
  const seen = new WeakSet<object>()
  let characters = 0
  let visited = 0

  while (stack.length > 0 && characters < characterLimit && visited < nodeLimit) {
    const item = stack.pop()
    visited += 1

    if (isTraversalCursor(item)) {
      if (item.index >= item.array.length) continue
      stack.push({ array: item.array, index: item.index + 1 }, item.array[item.index])
      continue
    }

    if (typeof item === "string") {
      const separatorLength = pieces.length > 0 ? 1 : 0
      const available = characterLimit - characters - separatorLength
      if (available <= 0) break
      const candidate = item.slice(0, available)
      if (/\S/.test(candidate)) {
        pieces.push(candidate)
        characters += candidate.length + separatorLength
      }
      if (candidate.length < item.length) break
      continue
    }

    if (!item || typeof item !== "object" || seen.has(item)) continue
    seen.add(item)

    if (Array.isArray(item)) {
      stack.push({ array: item, index: 0 })
      continue
    }

    const segment = item as { text?: unknown; value?: unknown; content?: unknown }
    stack.push(segment.content, segment.value, segment.text)
  }

  return pieces.join("\n")
}

function extractReasoningText(part: unknown, characterLimit: number, nodeLimit: number): string {
  const reasoning = part as { text?: unknown; content?: unknown } | null
  if (!reasoning || typeof reasoning !== "object") return ""
  const text = extractReasoningSource(reasoning.text, characterLimit, nodeLimit)
  return text || extractReasoningSource(reasoning.content, characterLimit, nodeLimit)
}

export function extractReasoningTextForRender(part: unknown): string {
  return extractReasoningText(part, REASONING_RENDER_CHARACTER_LIMIT, REASONING_RENDER_NODE_LIMIT)
}

export function extractReasoningTextForCopy(part: unknown): string {
  return extractReasoningText(part, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY)
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
    cache = { messageItems: new Map(), toolItems: new Map(), messageBlocks: new Map(), recordDisplayCache: new Map() }
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
  for (const messageId of removed) cache.recordDisplayCache.delete(messageId)
  for (const [key, item] of cache.messageItems) {
    if (removed.has(item.messageId)) cache.messageItems.delete(key)
  }
  for (const [key, item] of cache.toolItems) {
    if (removed.has(item.messageId)) cache.toolItems.delete(key)
  }
}
