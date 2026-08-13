import type { SessionMessageInfo as SDKMessage } from "@opencode-ai/client"
import { estimateRetainedBytes } from "../lib/retained-size"
import type { OpenCodeClient } from "./opencode-client"

const PAGE_LIMIT = 200
const MAX_PAGES = 10_000
const MAX_MESSAGES = 100_000
const MAX_RETAINED_BYTES = 64 * 1024 * 1024

async function listAllSessionMessages(
  client: OpenCodeClient,
  sessionId: string,
  signal?: AbortSignal,
  isAuthoritative: () => boolean = () => true,
): Promise<SDKMessage[] | null> {
  const messages: SDKMessage[] = []
  const seenCursors = new Set<string>()
  let retainedBytes = 0
  let cursor: string | undefined

  for (let page = 0; page < MAX_PAGES; page += 1) {
    signal?.throwIfAborted()
    if (!isAuthoritative()) return null
    const response = await client.message.list(cursor
      ? { sessionID: sessionId, limit: PAGE_LIMIT, cursor }
      : { sessionID: sessionId, limit: PAGE_LIMIT, order: "asc" }, { signal })
    if (!isAuthoritative()) return null
    if (messages.length + response.data.length > MAX_MESSAGES) {
      throw new Error(`Message reload exceeded ${MAX_MESSAGES} messages for session ${sessionId}`)
    }
    if (response.data.length > 0) {
      const remainingBytes = MAX_RETAINED_BYTES - retainedBytes
      const pageBytes = estimateRetainedBytes(response.data, remainingBytes)
      if (pageBytes > remainingBytes) {
        throw new Error(`Message reload exceeded 64 MiB for session ${sessionId}`)
      }
      retainedBytes += pageBytes
    }
    messages.push(...response.data)

    const nextCursor = response.cursor?.next ?? undefined
    if (!nextCursor) return messages
    if (seenCursors.has(nextCursor)) throw new Error(`Repeated message cursor for session ${sessionId}`)
    seenCursors.add(nextCursor)
    cursor = nextCursor
  }

  throw new Error(`Message pagination exceeded ${MAX_PAGES} pages for session ${sessionId}`)
}

export { listAllSessionMessages }
