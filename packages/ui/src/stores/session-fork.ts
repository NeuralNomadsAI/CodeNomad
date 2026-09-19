import type { OpenCodeClient } from "./opencode-client"

// Resolve against native history, not the filtered/paginated display window.
// Descending traversal makes a recent message cheap and includes hidden events.
export async function forkAfterMessage(
  client: OpenCodeClient,
  sessionID: string,
  messageID: string,
  isCurrent: () => boolean,
) {
  const checkAuthority = () => {
    if (!isCurrent()) throw new Error("Session fork was superseded by reconnect")
  }
  let successor: string | undefined
  let cursor: string | undefined
  const seen = new Set<string>()
  for (;;) {
    checkAuthority()
    const page = await client.message.list({ sessionID, limit: 200, ...(cursor ? { cursor } : { order: "desc" as const }) })
    checkAuthority()
    for (const message of page.data) {
      if (message.id === messageID) {
        if (message.type === "assistant" && !message.time.completed) {
          throw new Error("Cannot fork after an unfinished response")
        }
        const fork = await client.session.fork({ sessionID, ...(successor ? { before: successor } : {}) })
        checkAuthority()
        // A tail fork is atomic in OpenCode, but another client can append
        // between our read and that write. Never open a fork past the selection.
        if (!successor && (fork.fork?.boundary.type !== "through" || fork.fork.boundary.messageID !== messageID)) {
          await client.session.remove({ sessionID: fork.id })
          throw new Error("Session changed while forking; please try again")
        }
        return fork
      }
      successor = message.id
    }
    const next = page.cursor?.next
    if (!next) throw new Error("Fork message no longer exists")
    if (seen.has(next)) throw new Error("Repeated message cursor")
    seen.add(next)
    cursor = next
  }
}
