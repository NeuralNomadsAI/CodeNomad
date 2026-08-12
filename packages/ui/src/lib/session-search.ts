import type { ClientPart, MessageInfo } from "../types/message"
import { isHiddenSyntheticTextPart } from "../types/message"
import type { InstanceMessageStore } from "../stores/message-v2/instance-store"
import type { MessageRecord, MessageRole } from "../stores/message-v2/types"
import { getToolSearchText } from "../components/tool-call/search-text"

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

interface SearchablePartText {
  partId?: string
  partType?: string
  text: string
  truncated?: boolean
}

export interface BuildSessionSearchMatchesOptions {
  store: InstanceMessageStore
  sessionId: string
  query: string
  includeThinking: boolean
}

export interface SessionSearchResult {
  matches: SessionSearchMatch[]
  partial: boolean
}

export const SESSION_SEARCH_MATCH_LIMIT = 250
export const SESSION_SEARCH_WORK_CHARACTER_LIMIT = 2_000_000

const PREVIEW_RADIUS = 56

function normalizeSearchValue(value: string): string {
  return value.toLocaleLowerCase()
}

function segmentToText(segment: unknown, limit = SESSION_SEARCH_WORK_CHARACTER_LIMIT): { text: string; truncated: boolean } {
  const parts: string[] = []
  const pending: unknown[] = [segment]
  const seen = new WeakSet<object>()
  let characters = 0
  let nodes = 0
  let truncated = false
  while (pending.length > 0 && characters < limit && nodes < 10_000) {
    const current = pending.pop()
    nodes += 1
    if (typeof current === "string") {
      const text = current.slice(0, limit - characters)
      if (text) parts.push(text)
      characters += text.length
      continue
    }
    if (!current || typeof current !== "object" || seen.has(current)) continue
    seen.add(current)
    if (Array.isArray(current)) {
      const count = Math.min(current.length, 10_000 - nodes - pending.length)
      if (count < current.length) truncated = true
      for (let index = count - 1; index >= 0; index -= 1) pending.push(current[index])
      continue
    }
    const candidate = current as { text?: unknown; value?: unknown; content?: unknown }
    if (candidate.content !== undefined) pending.push(candidate.content)
    if (candidate.value !== undefined) pending.push(candidate.value)
    if (candidate.text !== undefined) pending.push(candidate.text)
  }
  return { text: parts.join("\n"), truncated: truncated || pending.length > 0 }
}

function extractToolText(part: Extract<ClientPart, { type: "tool" }>): { text: string; truncated: boolean } {
  const toolName = typeof part.tool === "string" ? part.tool : ""
  const context = { toolCall: part, toolState: (part as any).state, toolName }
  const values = getToolSearchText(context)
  const rendered: string[] = []
  let characters = 0
  let truncated = false
  for (const value of values) {
    if (!value.trim()) continue
    const remaining = SESSION_SEARCH_WORK_CHARACTER_LIMIT - characters
    if (remaining <= 0) {
      truncated = true
      break
    }
    rendered.push(value.slice(0, remaining))
    characters += Math.min(value.length, remaining)
    if (value.length > remaining) {
      truncated = true
      break
    }
  }
  return { text: rendered.join("\n"), truncated }
}

function extractMessageInfoText(info: MessageInfo | undefined): string {
  if (!info || info.role !== "assistant" || !info.error) return ""
  const error = info.error as { data?: { message?: unknown }; message?: unknown; name?: unknown }
  const values = [error.data?.message, error.message, error.name]
  return values.filter((value): value is string => typeof value === "string" && value.trim().length > 0).join("\n")
}

function extractSearchablePartText(part: ClientPart, includeThinking: boolean): SearchablePartText | null {
  if (!part || typeof part !== "object") return null
  if (isHiddenSyntheticTextPart(part)) return null

  const partId = typeof (part as any).id === "string" ? (part as any).id : undefined
  const partType = typeof (part as any).type === "string" ? (part as any).type : undefined

  if (part.type === "text") {
    const raw = (part as any).text
    const result = typeof raw === "string" ? { text: raw, truncated: false } : segmentToText(raw)
    return result.text.trim().length > 0 ? { partId, partType, ...result } : null
  }

  if (part.type === "reasoning") {
    if (!includeThinking) return null
    const result = segmentToText([(part as any).text, (part as any).content])
    return result.text.trim().length > 0 ? { partId, partType, ...result } : null
  }

  if (part.type === "file") {
    const filename = (part as any).filename
    return typeof filename === "string" && filename.trim().length > 0 ? { partId, partType, text: filename } : null
  }

  if (part.type === "tool") {
    const result = extractToolText(part)
    return result.text.trim().length > 0 ? { partId, partType, ...result } : null
  }

  if (part.type === "compaction") {
    const text = (part as any).auto ? "Session auto-compacted" : "Session compacted"
    return { partId, partType, text }
  }

  const candidate = part as Record<string, unknown>
  const result = segmentToText([candidate.text, candidate.content, candidate.value, candidate.title, candidate.name, candidate.filename, candidate.message])
  return result.text.trim().length > 0 ? { partId, partType, ...result } : null
}

function buildPreview(text: string, start: number, end: number): string {
  const from = Math.max(0, start - PREVIEW_RADIUS)
  const to = Math.min(text.length, end + PREVIEW_RADIUS)
  const prefix = from > 0 ? "..." : ""
  const suffix = to < text.length ? "..." : ""
  return `${prefix}${text.slice(from, to).replace(/\s+/g, " ").trim()}${suffix}`
}

export function buildSessionSearchMatches(options: BuildSessionSearchMatchesOptions): SessionSearchResult {
  const query = options.query.trim()
  if (!query) return { matches: [], partial: false }

  const needle = normalizeSearchValue(query)
  const matches: SessionSearchMatch[] = []
  const messageIds = options.store.getSessionMessageIds(options.sessionId)
  let remainingWork = SESSION_SEARCH_WORK_CHARACTER_LIMIT

  for (const messageId of messageIds) {
    if (remainingWork <= 0) return { matches, partial: true }
    const record = options.store.getMessage(messageId)
    if (!record) continue
    const searchableParts = function* (): Generator<SearchablePartText> {
      for (const partId of record.partIds) {
        if (remainingWork <= 0) return
        const part = record.parts[partId]?.data
        if (!part) continue
        const searchable = extractSearchablePartText(part, options.includeThinking)
        if (searchable) yield searchable
      }
      const infoText = extractMessageInfoText(options.store.getMessageInfo(record.id))
      if (infoText.trim()) yield { partType: "error", text: infoText }
    }

    for (const searchable of searchableParts()) {
      if (remainingWork <= 0) return { matches, partial: true }
      const text = searchable.text.slice(0, remainingWork)
      remainingWork -= text.length
      const haystack = normalizeSearchValue(text)
      let from = 0
      let occurrence = 0
      while (from < haystack.length) {
        const index = haystack.indexOf(needle, from)
        if (index === -1) break
        const end = index + query.length
        matches.push({
          id: `${messageId}:${searchable.partId ?? searchable.partType ?? "info"}:${index}`,
          messageId,
          partId: searchable.partId,
          partType: searchable.partType,
          role: record.role,
          start: index,
          end,
          occurrence,
          preview: buildPreview(text, index, end),
        })
        if (matches.length >= SESSION_SEARCH_MATCH_LIMIT) return { matches, partial: true }
        occurrence += 1
        from = end > index ? end : index + 1
      }
      if (text.length < searchable.text.length) return { matches, partial: true }
      if (searchable.truncated) return { matches, partial: true }
    }
  }

  return { matches, partial: false }
}
