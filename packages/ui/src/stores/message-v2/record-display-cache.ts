import { createStore, produce } from "solid-js/store"
import type { ClientPart } from "../../types/message"
import { extractReasoningTextForRender } from "../../lib/message-render-cache"
import type { MessageRecord } from "./types"

type ClientPartWithRevision = ClientPart & { revision?: number }

export interface RecordDisplayData {
  orderedParts: ClientPartWithRevision[]
  /** Parts omitted between the head and tail windows; zero when the whole message renders. */
  hiddenCount: number
  /** Index in `orderedParts` where the omitted parts belong. */
  gapIndex: number
  /** Index in `record.partIds` of the first omitted part. */
  hiddenStart: number
}

interface RecordDisplayCacheEntry {
  revision: number
  revealed: number
  data: RecordDisplayData
}

const recordDisplayCache = new Map<string, RecordDisplayCacheEntry>()
// One message is one virtualized row, so this bounds the DOM a single long
// agent turn can mount. Omitted parts stay in the store and can be revealed.
export const MESSAGE_PART_DISPLAY_LIMIT = 1000
export const MESSAGE_PART_REVEAL_STEP = 1000
const MESSAGE_PART_TAIL_COUNT = MESSAGE_PART_DISPLAY_LIMIT - Math.floor(MESSAGE_PART_DISPLAY_LIMIT / 2)

// User-revealed part counts keyed by instance/message. Reactive so every
// projection of the same record (blocks, grouping, timeline) agrees.
const [revealedParts, setRevealedParts] = createStore<Record<string, number>>({})

function makeCacheKey(instanceId: string, messageId: string) {
  return `${instanceId}:${messageId}`
}

/** Tracked read; caches derived from the display window must key on it. */
export function getRevealedRecordParts(instanceId: string, messageId: string): number {
  return revealedParts[makeCacheKey(instanceId, messageId)] ?? 0
}

function getDisplayWindow(instanceId: string, record: MessageRecord) {
  const revealed = getRevealedRecordParts(instanceId, record.id)
  const headCount = Math.floor(MESSAGE_PART_DISPLAY_LIMIT / 2) + revealed
  const hiddenCount = Math.max(0, record.partIds.length - headCount - MESSAGE_PART_TAIL_COUNT)
  return { revealed, headCount, hiddenCount }
}

export function getRecordDisplayPartIds(instanceId: string, record: MessageRecord): readonly string[] {
  const { headCount, hiddenCount } = getDisplayWindow(instanceId, record)
  if (hiddenCount === 0) return record.partIds
  return [
    ...record.partIds.slice(0, headCount),
    ...record.partIds.slice(-MESSAGE_PART_TAIL_COUNT),
  ]
}

export function revealHiddenRecordParts(instanceId: string, messageId: string) {
  const key = makeCacheKey(instanceId, messageId)
  setRevealedParts(key, (current) => (current ?? 0) + MESSAGE_PART_REVEAL_STEP)
}

export function buildRecordDisplayData(instanceId: string, record: MessageRecord): RecordDisplayData {
  // Read the reveal state before the cache check so reactive callers track it.
  const { revealed, headCount, hiddenCount } = getDisplayWindow(instanceId, record)
  const cacheKey = makeCacheKey(instanceId, record.id)
  const cached = recordDisplayCache.get(cacheKey)
  if (cached && cached.revision === record.revision && cached.revealed === revealed) {
    return cached.data
  }

  const orderedParts: ClientPartWithRevision[] = []
  const append = (partIds: readonly string[]) => {
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
  }

  if (hiddenCount === 0) {
    append(record.partIds)
  } else {
    append(record.partIds.slice(0, headCount))
  }
  const gapIndex = orderedParts.length
  if (hiddenCount > 0) append(record.partIds.slice(-MESSAGE_PART_TAIL_COUNT))

  const data: RecordDisplayData = { orderedParts, hiddenCount, gapIndex, hiddenStart: Math.min(headCount, record.partIds.length) }
  recordDisplayCache.set(cacheKey, { revision: record.revision, revealed, data })
  return data
}

export function clearRecordDisplayCacheForInstance(instanceId: string) {
  const prefix = `${instanceId}:`
  for (const key of recordDisplayCache.keys()) {
    if (key.startsWith(prefix)) {
      recordDisplayCache.delete(key)
    }
  }
  setRevealedParts(produce((state) => {
    for (const key of Object.keys(state)) {
      if (key.startsWith(prefix)) delete state[key]
    }
  }))
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
