import type { SessionMessageInfo as SDKMessage } from "@opencode-ai/client"
import type { OpenCodeClient } from "./opencode-client"

export interface MessageWindowPage {
  messages: SDKMessage[]
  olderCursor?: string
  newerCursor?: string
}

const MAX_WINDOW_PAGES = 1_000

async function listMessageWindow(
  client: OpenCodeClient,
  sessionId: string,
  options: { limit: number; cursor?: string; forward?: boolean; signal?: AbortSignal; isAuthoritative?: () => boolean },
): Promise<MessageWindowPage | null> {
  const isAuthoritative = options.isAuthoritative ?? (() => true)
  const messages: SDKMessage[] = []
  const seenCursors = new Set(options.cursor ? [options.cursor] : [])
  let cursor = options.cursor
  let olderCursor: string | undefined
  let newerCursor: string | undefined

  for (let page = 0; page < MAX_WINDOW_PAGES && messages.length < options.limit; page += 1) {
    options.signal?.throwIfAborted()
    if (!isAuthoritative()) return null
    const remaining = options.limit - messages.length
    const response = await client.message.list(cursor
      ? { sessionID: sessionId, limit: remaining, cursor }
      : { sessionID: sessionId, limit: remaining, order: options.forward ? "asc" : "desc" }, { signal: options.signal })
    if (!isAuthoritative()) return null
    if (options.forward) {
      if (page === 0) olderCursor = response.cursor?.previous ?? undefined
      messages.push(...response.data.slice(0, remaining))
      newerCursor = response.cursor?.next ?? undefined
    } else {
      if (page === 0) newerCursor = response.cursor?.previous ?? undefined
      messages.unshift(...response.data.slice(0, remaining).reverse())
      olderCursor = response.cursor?.next ?? undefined
    }

    const nextCursor = options.forward ? newerCursor : olderCursor
    if (!nextCursor) return { messages, olderCursor, newerCursor }
    if (seenCursors.has(nextCursor)) throw new Error(`Repeated message cursor for session ${sessionId}`)
    seenCursors.add(nextCursor)
    cursor = nextCursor
  }

  if (messages.length >= options.limit) return { messages, olderCursor, newerCursor }
  throw new Error(`Message window pagination exceeded ${MAX_WINDOW_PAGES} pages for session ${sessionId}`)
}

export { listMessageWindow }
