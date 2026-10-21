import { createStore, produce } from "solid-js/store"
import type { ClientPart } from "../../types/message"
import { extractReasoningTextForRender } from "../../lib/message-render-cache"
import type { MessageRecord } from "./types"
import { MESSAGE_DISPLAY_HEAD, MESSAGE_DISPLAY_LIMIT, MESSAGE_DISPLAY_TAIL } from "../../../../server/src/opencode/session-pruning/navigation-contract"

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
// Indexed timeline markers mirror the same window, hence the shared bound.
export const MESSAGE_PART_DISPLAY_LIMIT = MESSAGE_DISPLAY_LIMIT
export const MESSAGE_PART_REVEAL_STEP = 1000
const MESSAGE_PART_TAIL_COUNT = MESSAGE_DISPLAY_TAIL

// User-revealed part counts keyed by instance/message. Reactive so every
// projection of the same record (blocks, grouping, timeline) agrees.
const [revealedParts, setRevealedParts] = createStore<Record<string, number>>({})

/** One display-bounded text block of a message part, e.g. a text part, a tool's output or a task's prompt. */
export interface RecordTextRevealTarget {
  instanceId: string
  messageId: string
  partId: string
  section: string
}

// User-revealed text steps (see `getRenderTextWindow`) keyed by instance/message/part/section,
// so a block remounted by virtualization, a re-render or a session switch keeps its reveal.
const [revealedText, setRevealedText] = createStore<Record<string, number>>({})

function makeCacheKey(instanceId: string, messageId: string) {
  return `${instanceId}:${messageId}`
}

function makeTextRevealKey(target: RecordTextRevealTarget) {
  return `${makeCacheKey(target.instanceId, target.messageId)}:${target.partId}:${target.section}`
}

/** Tracked read of how many reveal steps the user applied to a text block. */
export function getRevealedRecordText(target: RecordTextRevealTarget): number {
  return revealedText[makeTextRevealKey(target)] ?? 0
}

export function revealHiddenRecordText(target: RecordTextRevealTarget) {
  setRevealedText(makeTextRevealKey(target), (current) => (current ?? 0) + 1)
}

/** Tracked read; caches derived from the display window must key on it. */
export function getRevealedRecordParts(instanceId: string, messageId: string): number {
  return revealedParts[makeCacheKey(instanceId, messageId)] ?? 0
}

function getDisplayWindow(instanceId: string, record: MessageRecord) {
  const revealed = getRevealedRecordParts(instanceId, record.id)
  const headCount = MESSAGE_DISPLAY_HEAD + revealed
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

/** Whether `record.partIds[index]` renders in the message's current display window. */
export function isRecordPartDisplayed(instanceId: string, record: MessageRecord, index: number): boolean {
  const { headCount, hiddenCount } = getDisplayWindow(instanceId, record)
  return hiddenCount === 0 || index < headCount || index >= headCount + hiddenCount
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
          time: time ? { created: time.created, completed: time.completed } : undefined,
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
  const forget = produce((state: Record<string, number>) => {
    for (const key of Object.keys(state)) {
      if (key.startsWith(prefix)) delete state[key]
    }
  })
  setRevealedParts(forget)
  setRevealedText(forget)
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
