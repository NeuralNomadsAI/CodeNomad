import type { ClientPart, MessageInfo } from "../types/message"
import { isHiddenSyntheticTextPart } from "../types/message"
import type { InstanceMessageStore } from "../stores/message-v2/instance-store"
import type { MessageRecord, MessageRole } from "../stores/message-v2/types"
import { getDefaultToolSearchText } from "../components/tool-call/search-text"
import type { ToolSearchTextContext } from "../components/tool-call/types"
import { iterateTextSearchOccurrences, makeTextSearchPreview } from "./session-search-matches"

export interface SessionSearchMatch {
  id: string
  messageId: string
  partId?: string
  partType?: string
  role: MessageRole
  start: number
  end: number
  occurrence: number
  preview: string
}

type ToolSearchTextSource = AsyncIterable<string> | Promise<string[]> | string[] | undefined

export interface BuildSessionSearchMatchesOptions {
  store: InstanceMessageStore
  sessionId: string
  query: string
  includeThinking: boolean
  resolveToolSearchText?: (context: ToolSearchTextContext) => ToolSearchTextSource
  limit?: number
  signal?: AbortSignal
  yieldControl?: () => Promise<void>
}

export interface SessionSearchResult {
  matches: SessionSearchMatch[]
  totalMatches: number | null
  offset: number
  hasMore: boolean
}

export interface SessionSearchPager {
  nextPage(): Promise<SessionSearchResult>
}

export const SESSION_SEARCH_PAGE_SIZE = 250
export const SESSION_SEARCH_RETAINED_PAGE_LIMIT = 3
const SEARCH_TEXT_CHUNK_CHARACTERS = 64 * 1024
const OVERSIZED_LITERAL_QUERY_CHARACTERS = 4_096
const SEARCH_YIELD_INTERVAL_MS = 8
const SEARCH_CHECKPOINT_UNITS = 64

function yieldToEventLoop(): Promise<void> {
  const schedulerYield = (globalThis as any).scheduler?.yield
  if (typeof schedulerYield === "function") return schedulerYield.call((globalThis as any).scheduler)
  const setImmediate = (globalThis as any).setImmediate
  if (typeof setImmediate === "function") return new Promise((resolve) => setImmediate(resolve))
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function abortSearch(): never {
  const error = new Error("Session search cancelled")
  error.name = "AbortError"
  throw error
}

async function* segmentTexts(segment: unknown, checkpoint: () => Promise<void>): AsyncGenerator<string> {
  type Pending = { value: unknown } | { array: unknown[]; index: number }
  const pending: Pending[] = [{ value: segment }]
  const seen = new WeakSet<object>()
  while (pending.length > 0) {
    const item = pending.pop()!
    if ("array" in item) {
      if (item.index < item.array.length) pending.push({ array: item.array, index: item.index + 1 }, { value: item.array[item.index] })
      continue
    }
    const current = item.value
    if (typeof current === "string" && current.length > 0) yield current
    else if (current && typeof current === "object" && !seen.has(current)) {
      seen.add(current)
      if (Array.isArray(current)) pending.push({ array: current, index: 0 })
      else {
        const candidate = current as { text?: unknown; value?: unknown; content?: unknown }
        if (candidate.content !== undefined) pending.push({ value: candidate.content })
        if (candidate.value !== undefined) pending.push({ value: candidate.value })
        if (candidate.text !== undefined) pending.push({ value: candidate.text })
      }
    }
    await checkpoint()
  }
}

async function* toolTexts(
  part: Extract<ClientPart, { type: "tool" }>,
  checkpoint: () => Promise<void>,
  resolver?: BuildSessionSearchMatchesOptions["resolveToolSearchText"],
): AsyncGenerator<string> {
  const toolName = typeof part.tool === "string" ? part.tool : ""
  const context = { toolCall: part, toolState: (part as any).state, toolName, checkpoint }
  const source = resolver?.(context) ?? getDefaultToolSearchText(context)
  const resolved = await source
  if (resolved && Symbol.asyncIterator in Object(resolved)) {
    for await (const text of resolved as AsyncIterable<string>) if (text.length > 0) yield text
  } else if (Array.isArray(resolved)) {
    for (const text of resolved) if (text.length > 0) yield text
  }
}

async function* partTexts(
  part: ClientPart,
  includeThinking: boolean,
  checkpoint: () => Promise<void>,
  resolver?: BuildSessionSearchMatchesOptions["resolveToolSearchText"],
): AsyncGenerator<string> {
  if (!part || typeof part !== "object" || isHiddenSyntheticTextPart(part)) return
  if (part.type === "text") {
    yield* segmentTexts((part as any).text, checkpoint)
    return
  }
  if (part.type === "reasoning") {
    if (!includeThinking) return
    yield* segmentTexts((part as any).text, checkpoint)
    yield* segmentTexts((part as any).content, checkpoint)
    return
  }
  if (part.type === "file") {
    if (typeof (part as any).filename === "string") yield (part as any).filename
    return
  }
  if (part.type === "tool") {
    yield* toolTexts(part, checkpoint, resolver)
    return
  }
  if (part.type === "compaction") {
    yield (part as any).auto ? "Session auto-compacted" : "Session compacted"
    return
  }
  const candidate = part as Record<string, unknown>
  for (const value of [candidate.text, candidate.content, candidate.value, candidate.title, candidate.name, candidate.filename, candidate.message]) {
    yield* segmentTexts(value, checkpoint)
  }
}

async function* infoTexts(info: MessageInfo | undefined, checkpoint: () => Promise<void>): AsyncGenerator<string> {
  if (!info || info.role !== "assistant" || !info.error) return
  const error = info.error as { data?: { message?: unknown }; message?: unknown; name?: unknown }
  for (const value of [error.data?.message, error.message, error.name]) yield* segmentTexts(value, checkpoint)
}

async function* scanTextSource(
  messageId: string,
  record: MessageRecord,
  source: { partId?: string; partType?: string; texts: AsyncIterable<string> },
  query: string,
  checkpoint: (force?: boolean) => Promise<void>,
): AsyncGenerator<SessionSearchMatch> {
  let partOffset = 0
  let occurrence = 0
  for await (const text of source.texts) {
    const chunkSize = Math.max(SEARCH_TEXT_CHUNK_CHARACTERS, query.length)
    const overlap = Math.max(0, query.length - 1)
    let nextAllowedStart = 0
    for (let chunkStart = 0; chunkStart < text.length; chunkStart += chunkSize) {
      const primaryEnd = Math.min(text.length, chunkStart + chunkSize)
      const windowEnd = Math.min(text.length, primaryEnd + overlap)
      const windowText = text.slice(chunkStart, windowEnd)
      const windowFrom = Math.max(0, nextAllowedStart - chunkStart)
      for (const match of iterateTextSearchOccurrences(windowText, query, windowFrom)) {
        const start = chunkStart + match.start
        if (start >= primaryEnd) break
        const end = chunkStart + match.end
        nextAllowedStart = end
        const absoluteStart = partOffset + start
        yield {
          id: `${messageId}:${source.partId ?? source.partType ?? "info"}:${absoluteStart}`,
          messageId,
          partId: source.partId,
          partType: source.partType,
          role: record.role,
          start: absoluteStart,
          end: partOffset + end,
          occurrence,
          preview: makeTextSearchPreview(text, start, end),
        }
        occurrence += 1
        await checkpoint()
      }
      await checkpoint(query.length > OVERSIZED_LITERAL_QUERY_CHARACTERS)
    }
    partOffset += text.length + 1
  }
}

async function* scanSessionSearchMatches(options: BuildSessionSearchMatchesOptions): AsyncGenerator<SessionSearchMatch> {
  const query = options.query.trim()
  if (!query) return
  const yieldControl = options.yieldControl ?? yieldToEventLoop
  let checkpointUnits = 0
  let lastYieldAt = Date.now()
  const checkpoint = async (force = false) => {
    if (options.signal?.aborted) abortSearch()
    checkpointUnits += 1
    if (!force && checkpointUnits < SEARCH_CHECKPOINT_UNITS && Date.now() - lastYieldAt < SEARCH_YIELD_INTERVAL_MS) return
    checkpointUnits = 0
    await yieldControl()
    lastYieldAt = Date.now()
    if (options.signal?.aborted) abortSearch()
  }

  for (const messageId of options.store.getSessionMessageIds(options.sessionId)) {
    if (options.signal?.aborted) abortSearch()
    const record = options.store.getMessage(messageId)
    if (!record) continue
    for (const partId of record.partIds) {
      const part = record.parts[partId]?.data
      if (!part) continue
      yield* scanTextSource(
        messageId,
        record,
        { partId, partType: part.type, texts: partTexts(part, options.includeThinking, checkpoint, options.resolveToolSearchText) },
        query,
        checkpoint,
      )
    }
    yield* scanTextSource(
      messageId,
      record,
      { partType: "error", texts: infoTexts(options.store.getMessageInfo(record.id), checkpoint) },
      query,
      checkpoint,
    )
    await checkpoint()
  }
}

export function createSessionSearchPager(options: BuildSessionSearchMatchesOptions): SessionSearchPager {
  const iterator = scanSessionSearchMatches(options)[Symbol.asyncIterator]()
  const limit = Math.max(1, Math.trunc(options.limit ?? SESSION_SEARCH_PAGE_SIZE))
  let lookahead: SessionSearchMatch | undefined
  let offset = 0
  let done = false

  return {
    async nextPage() {
      const pageOffset = offset
      const matches: SessionSearchMatch[] = []
      if (lookahead) {
        matches.push(lookahead)
        lookahead = undefined
      }
      while (matches.length < limit && !done) {
        const next = await iterator.next()
        done = Boolean(next.done)
        if (!next.done) matches.push(next.value)
      }
      if (!done) {
        const next = await iterator.next()
        done = Boolean(next.done)
        if (!next.done) lookahead = next.value
      }
      offset += matches.length
      return {
        matches,
        offset: pageOffset,
        hasMore: Boolean(lookahead),
        totalMatches: done ? offset : null,
      }
    },
  }
}

export function retainSessionSearchPage(
  pages: Map<number, SessionSearchResult>,
  pageIndex: number,
  result: SessionSearchResult,
  limit = SESSION_SEARCH_RETAINED_PAGE_LIMIT,
): void {
  pages.delete(pageIndex)
  pages.set(pageIndex, result)
  while (pages.size > limit) pages.delete(pages.keys().next().value!)
}

export async function findLastSessionSearchPage(
  loadPage: (pageIndex: number) => Promise<SessionSearchResult>,
): Promise<{ pageIndex: number; result: SessionSearchResult }> {
  let pageIndex = 0
  let result = await loadPage(pageIndex)
  while (result.hasMore) {
    pageIndex += 1
    result = await loadPage(pageIndex)
  }
  return { pageIndex, result }
}

export async function buildSessionSearchMatches(options: BuildSessionSearchMatchesOptions): Promise<SessionSearchResult> {
  return createSessionSearchPager(options).nextPage()
}
