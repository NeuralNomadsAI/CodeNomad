import type { ClientPart } from "../../types/message"
import { extractReasoningTextForRender } from "../../lib/message-render-cache"
import type { MessageRecord } from "./types"

type ClientPartWithRevision = ClientPart & { revision?: number }

export interface RecordDisplayData {
  orderedParts: ClientPartWithRevision[]
  truncated: boolean
}

interface RecordDisplayCacheEntry {
  revision: number
  data: RecordDisplayData
}

const recordDisplayCache = new Map<string, RecordDisplayCacheEntry>()
export const MESSAGE_PART_DISPLAY_LIMIT = 200

function makeCacheKey(instanceId: string, messageId: string) {
  return `${instanceId}:${messageId}`
}

export function buildRecordDisplayData(instanceId: string, record: MessageRecord): RecordDisplayData {
  const cacheKey = makeCacheKey(instanceId, record.id)
  const cached = recordDisplayCache.get(cacheKey)
  if (cached && cached.revision === record.revision) {
    return cached.data
  }

  const orderedParts: ClientPartWithRevision[] = []
  const headCount = Math.floor(MESSAGE_PART_DISPLAY_LIMIT / 2)
  const partIds = record.partIds.length > MESSAGE_PART_DISPLAY_LIMIT
    ? [...record.partIds.slice(0, headCount), ...record.partIds.slice(-(MESSAGE_PART_DISPLAY_LIMIT - headCount))]
    : record.partIds

  for (const partId of partIds) {
    const entry = record.parts[partId]
    if (!entry?.data) continue
    const part = entry.data as ClientPart
    if (part.type === "reasoning") {
      const time = (part as any).time
      orderedParts.push({
        id: part.id,
        type: "reasoning",
        text: extractReasoningTextForRender(part),
        time: time ? { start: time.start, end: time.end, created: time.created } : undefined,
        revision: entry.revision,
      } as ClientPartWithRevision)
      continue
    }
    orderedParts.push({ ...part, revision: entry.revision })
  }

  const data: RecordDisplayData = { orderedParts, truncated: record.partIds.length > MESSAGE_PART_DISPLAY_LIMIT }
  recordDisplayCache.set(cacheKey, { revision: record.revision, data })
  return data
}

export function clearRecordDisplayCacheForInstance(instanceId: string) {
  const prefix = `${instanceId}:`
  for (const key of recordDisplayCache.keys()) {
    if (key.startsWith(prefix)) {
      recordDisplayCache.delete(key)
    }
  }
}

export function clearRecordDisplayCacheForMessages(instanceId: string, messageIds: Iterable<string>) {
  for (const messageId of messageIds) {
    if (typeof messageId !== "string" || messageId.length === 0) continue
    recordDisplayCache.delete(makeCacheKey(instanceId, messageId))
  }
}

export function* getRecordDisplayCacheEntries(instanceId: string, messageIds: Iterable<string>): Generator<unknown> {
  for (const messageId of messageIds) {
    const entry = recordDisplayCache.get(makeCacheKey(instanceId, messageId))
    if (entry) yield entry
  }
}
