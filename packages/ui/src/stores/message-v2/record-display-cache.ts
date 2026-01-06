import type { ClientPart } from "../../types/message"
import type { MessageRecord } from "./types"

type ClientPartWithRevision = ClientPart & { revision?: number }

export interface RecordDisplayData {
  orderedParts: ClientPartWithRevision[]
}

interface RecordDisplayCacheEntry {
  revision: number
  data: RecordDisplayData
}

const recordDisplayCache = new Map<string, RecordDisplayCacheEntry>()

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

  for (const partId of record.partIds) {
    const entry = record.parts[partId]
    if (!entry?.data) continue
    orderedParts.push({ ...(entry.data as ClientPart), revision: entry.revision })
  }

  const data: RecordDisplayData = { orderedParts }
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
