import type { MessageInfo } from "../../types/message"

type MessageInfoReader = (messageId: string) => MessageInfo | undefined

function isInterruption(error: MessageInfo["error"]): boolean {
  const type = String(error?.type ?? error?.name ?? "").toLowerCase()
  return type.includes("abort") || type.includes("interrupt")
}

function isFailedIdle(info: MessageInfo | undefined): boolean {
  return info?.nativeType === "idle" && Boolean(info.error)
}

/**
 * OpenCode propagates a failed step's error (or a failed compaction's) to the run's
 * idle record. Mirror its timeline projection: within the turn, the idle record only
 * repeats that failure when the last step already shows a non-interruption error or
 * the latest notice is such a failed compaction. Walks back at most to the previous step.
 */
export function isDuplicateRunFailure(messageIds: readonly string[], index: number, getInfo: MessageInfoReader): boolean {
  if (!isFailedIdle(getInfo(messageIds[index]))) return false
  let noticeSeen = false
  for (let cursor = index - 1; cursor >= 0; cursor--) {
    const info = getInfo(messageIds[cursor])
    if (!info) continue
    const type = info.nativeType
    if (info.role === "user" || type === "shell") return false
    if (type === "idle") {
      // Successful and duplicate idle records are not timeline entries.
      if (!isFailedIdle(info) || isDuplicateRunFailure(messageIds, cursor, getInfo)) continue
      return false
    }
    if (type === "assistant") return Boolean(info.error) && !isInterruption(info.error)
    if (!noticeSeen && type === "compaction" && info.error && !isInterruption(info.error)) return true
    noticeSeen = true
  }
  return false
}
