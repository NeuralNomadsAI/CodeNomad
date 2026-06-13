import type { ClientPart, MessageInfo } from "../types/message"
import type { MessageStatus } from "../stores/message-v2/types"

function getPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined
}

function getTimeValue(source: unknown, key: "created" | "updated" | "completed" | "end" | "start"): number | undefined {
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
  return getTimeValue(messageInfo, "completed")
}

// Match OpenChamber's explicit OpenCode message timing model:
// message duration is defined by time.created -> time.completed.
export function getMessageDurationMs(messageInfo?: MessageInfo, _status?: MessageStatus, _fallbackStartedAt?: number): number | undefined {
  return getDurationBetween(getTimeValue(messageInfo, "created"), getMessageCompletedAt(messageInfo))
}

export function getPartStartedAt(part?: ClientPart): number | undefined {
  return getTimeValue(part, "start") ?? getTimeValue(part, "created")
}

export function getPartDurationMs(part?: ClientPart): number | undefined {
  return getDurationBetween(getTimeValue(part, "start"), getTimeValue(part, "end"))
}

export function inferReasoningDurationMs(
  _parts: ClientPart[],
  reasoningPart: ClientPart,
  _messageInfo?: MessageInfo,
  _status?: MessageStatus,
): number | undefined {
  return getPartDurationMs(reasoningPart)
}

export function formatElapsedClock(durationMs?: number, locale?: string): string {
  const safeDuration = getPositiveNumber(durationMs)
  if (!safeDuration) {
    return ""
  }

  const formatNumber = (value: number, minimumIntegerDigits = 1) =>
    new Intl.NumberFormat(locale, { minimumIntegerDigits, useGrouping: false }).format(value)
  const totalSeconds = Math.max(1, Math.round(safeDuration / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  if (hours > 0) {
    return `${formatNumber(hours)}:${formatNumber(minutes, 2)}:${formatNumber(seconds, 2)}`
  }

  return `${formatNumber(minutes)}:${formatNumber(seconds, 2)}`
}
