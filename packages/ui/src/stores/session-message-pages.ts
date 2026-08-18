import type { SessionMessageInfo as SDKMessage } from "@opencode-ai/client"
import type { OpenCodeClient } from "./opencode-client"

export interface MessageWindowPage {
  messages: SDKMessage[]
  olderCursor?: string
}

const MAX_WINDOW_PAGES = 1_000

async function listMessageWindow(
  client: OpenCodeClient,
  sessionId: string,
  options: { limit: number; cursor?: string; signal?: AbortSignal; isAuthoritative?: () => boolean },
): Promise<MessageWindowPage | null> {
  const isAuthoritative = options.isAuthoritative ?? (() => true)
  const messages: SDKMessage[] = []
  const seenCursors = new Set<string>()
  let cursor = options.cursor

  for (let page = 0; page < MAX_WINDOW_PAGES && messages.length < options.limit; page += 1) {
    options.signal?.throwIfAborted()
    if (!isAuthoritative()) return null
    const remaining = options.limit - messages.length
    const response = await client.message.list(cursor
      ? { sessionID: sessionId, limit: remaining, cursor }
      : { sessionID: sessionId, limit: remaining, order: "desc" }, { signal: options.signal })
    if (!isAuthoritative()) return null
    messages.unshift(...response.data.slice(0, remaining).reverse())

    const nextCursor = response.cursor?.next ?? undefined
    if (!nextCursor) return { messages, olderCursor: undefined }
    if (seenCursors.has(nextCursor)) throw new Error(`Repeated message cursor for session ${sessionId}`)
    seenCursors.add(nextCursor)
    cursor = nextCursor
  }

  if (messages.length >= options.limit) return { messages, olderCursor: cursor }
  throw new Error(`Message window pagination exceeded ${MAX_WINDOW_PAGES} pages for session ${sessionId}`)
}

export { listMessageWindow }
