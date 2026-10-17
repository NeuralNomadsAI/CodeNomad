import type { ClientPart, MessageInfo } from "../types/message"
import type { MessageStatus } from "../stores/message-v2/types"

function getPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined
}

function getTimeValue(source: unknown, key: "created" | "updated" | "completed" | "end" | "start" | "ran"): number | undefined {
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

// Part timing comes only from OpenCode. V2 parts carry time.created/completed
// (tools add time.ran when execution starts); V1 parts used time.start/end.
export function getPartStartedAt(part?: ClientPart): number | undefined {
  return getTimeValue(part, "ran") ?? getTimeValue(part, "start") ?? getTimeValue(part, "created")
}

export function getPartEndedAt(part?: ClientPart): number | undefined {
  return getTimeValue(part, "completed") ?? getTimeValue(part, "end")
}

export function getPartDurationMs(part?: ClientPart): number | undefined {
  return getDurationBetween(getPartStartedAt(part), getPartEndedAt(part))
}

export function inferReasoningDurationMs(
  _parts: ClientPart[],
  reasoningPart: ClientPart,
  _messageInfo?: MessageInfo,
  _status?: MessageStatus,
): number | undefined {
  return getPartDurationMs(reasoningPart)
}

/** A short, localized duration ("3s", "1m 5s", "1h 2m"), not a clock reading
 * that could be mistaken for a time of day. While `live` (ticking), the trailing
 * unit is always shown with two digits ("1m 05s", "2m 00s") so the width stays
 * steady and the header layout does not shift every minute. */
export function formatElapsedDuration(durationMs?: number, locale?: string, live = false): string {
  const safeDuration = getPositiveNumber(durationMs)
  if (!safeDuration) {
    return ""
  }

  const formatUnit = (unit: "hour" | "minute" | "second", value: number, padded = false) =>
    new Intl.NumberFormat(locale, {
      style: "unit",
      unit,
      unitDisplay: "narrow",
      useGrouping: false,
      minimumIntegerDigits: padded ? 2 : 1,
    }).format(value)
  const totalSeconds = Math.max(1, Math.round(safeDuration / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  if (hours > 0) {
    return minutes || live ? `${formatUnit("hour", hours)} ${formatUnit("minute", minutes, live)}` : formatUnit("hour", hours)
  }
  if (minutes > 0) {
    return seconds || live ? `${formatUnit("minute", minutes)} ${formatUnit("second", seconds, live)}` : formatUnit("minute", minutes)
  }
  return formatUnit("second", seconds)
}
