import type { ClientPart, MessageInfo } from "../types/message"
import type { MessageStatus } from "../stores/message-v2/types"

function getPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined
}

function getExplicitDuration(source: unknown): number | undefined {
  return getPositiveNumber((source as any)?.duration) ?? getPositiveNumber((source as any)?.time?.duration)
}

function getTimeValue(source: unknown, key: "created" | "updated" | "end" | "start"): number | undefined {
  return getPositiveNumber((source as any)?.time?.[key])
}

function getDurationBetween(startedAt?: number, endedAt?: number): number | undefined {
  if (!startedAt || !endedAt || endedAt <= startedAt) return undefined
  return endedAt - startedAt
}

export function getMessageStartedAt(messageInfo?: MessageInfo, fallback?: number): number | undefined {
  return getTimeValue(messageInfo, "created") ?? getPositiveNumber(fallback)
}

export function getMessageCompletedAt(messageInfo?: MessageInfo, _status?: MessageStatus): number | undefined {
  return getTimeValue(messageInfo, "end")
}

// Only show timings that OpenCode explicitly provides on the message itself.
// Avoid client-side inference from local timestamps, stream ordering, or update events.
export function getMessageDurationMs(messageInfo?: MessageInfo, _status?: MessageStatus, _fallbackStartedAt?: number): number | undefined {
  const explicitDuration = getExplicitDuration(messageInfo)
  if (explicitDuration) {
    return explicitDuration
  }

  return getDurationBetween(getTimeValue(messageInfo, "created"), getTimeValue(messageInfo, "end"))
}

export function getPartStartedAt(part?: ClientPart): number | undefined {
  return getTimeValue(part, "start") ?? getTimeValue(part, "created")
}

export function getPartDurationMs(part?: ClientPart): number | undefined {
  const explicitDuration = getExplicitDuration(part)
  if (explicitDuration) {
    return explicitDuration
  }

  return getDurationBetween(getPartStartedAt(part), getTimeValue(part, "end"))
}

export function inferReasoningDurationMs(
  _parts: ClientPart[],
  reasoningPart: ClientPart,
  _messageInfo?: MessageInfo,
  _status?: MessageStatus,
): number | undefined {
  return getPartDurationMs(reasoningPart)
}

export function formatElapsedClock(durationMs?: number): string {
  const safeDuration = getPositiveNumber(durationMs)
  if (!safeDuration) {
    return ""
  }

  const totalSeconds = Math.max(1, Math.round(safeDuration / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const pad = (value: number) => String(value).padStart(2, "0")

  if (hours > 0) {
    return `${hours}:${pad(minutes)}:${pad(seconds)}`
  }

  return `${minutes}:${pad(seconds)}`
}
