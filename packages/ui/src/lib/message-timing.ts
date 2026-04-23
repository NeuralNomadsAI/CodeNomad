import type { ClientPart, MessageInfo } from "../types/message"
import type { MessageStatus } from "../stores/message-v2/types"

function getPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined
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

export function getMessageCompletedAt(messageInfo?: MessageInfo, status?: MessageStatus): number | undefined {
  const endedAt = getTimeValue(messageInfo, "end")
  if (endedAt) {
    return endedAt
  }

  if (status && status !== "streaming" && status !== "sending") {
    return getTimeValue(messageInfo, "updated")
  }

  return undefined
}

export function getMessageDurationMs(messageInfo?: MessageInfo, status?: MessageStatus, fallbackStartedAt?: number): number | undefined {
  return getDurationBetween(getMessageStartedAt(messageInfo, fallbackStartedAt), getMessageCompletedAt(messageInfo, status))
}

export function getPartStartedAt(part?: ClientPart): number | undefined {
  return getTimeValue(part, "start") ?? getTimeValue(part, "created")
}

export function getPartDurationMs(part?: ClientPart): number | undefined {
  const explicitDuration = getPositiveNumber((part as any)?.duration) ?? getPositiveNumber((part as any)?.time?.duration)
  if (explicitDuration) {
    return explicitDuration
  }

  return getDurationBetween(getPartStartedAt(part), getTimeValue(part, "end") ?? getTimeValue(part, "updated"))
}

export function inferReasoningDurationMs(parts: ClientPart[], reasoningPart: ClientPart, messageInfo?: MessageInfo, status?: MessageStatus): number | undefined {
  const explicitDuration = getPartDurationMs(reasoningPart)
  if (explicitDuration) {
    return explicitDuration
  }

  const startedAt = getPartStartedAt(reasoningPart) ?? getMessageStartedAt(messageInfo)
  if (!startedAt) {
    return undefined
  }

  let foundReasoningPart = false
  for (const part of parts) {
    if (!foundReasoningPart) {
      foundReasoningPart = part === reasoningPart || (Boolean(part.id) && part.id === reasoningPart.id)
      continue
    }

    const nextStartedAt = getPartStartedAt(part)
    if (nextStartedAt && nextStartedAt > startedAt) {
      return nextStartedAt - startedAt
    }
  }

  return getDurationBetween(startedAt, getMessageCompletedAt(messageInfo, status))
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
