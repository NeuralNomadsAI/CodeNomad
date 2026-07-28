import type { ClientPart, MessageInfo } from "../types/message"
import { isHiddenSyntheticTextPart } from "../types/message"
import type { InstanceMessageStore } from "../stores/message-v2/instance-store"
import type { MessageRecord, MessageRole } from "../stores/message-v2/types"
import { resolveToolRenderer } from "../components/tool-call/renderers"
import { getDefaultToolSearchText } from "../components/tool-call/search-text"
import { findTextSearchOccurrences } from "./session-search-matches"

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
}

export interface BuildSessionSearchMatchesOptions {
  store: InstanceMessageStore
  sessionId: string
  query: string
  includeThinking: boolean
}

const MAX_SEARCH_MESSAGES = 10_000
const MAX_SEARCH_PARTS = 20_000
const MAX_SEARCH_PART_CHARACTERS = 1_000_000
const MAX_SEARCH_SEGMENTS = 1_000
const MAX_SEARCH_TOTAL_CHARACTERS = 5_000_000
const MAX_SEARCH_QUERY_CHARACTERS = 1_000

function segmentToText(segment: unknown, budget = { characters: MAX_SEARCH_PART_CHARACTERS, segments: MAX_SEARCH_SEGMENTS }): string {
  if (budget.characters <= 0 || budget.segments <= 0) return ""
  budget.segments -= 1
  if (typeof segment === "string") {
    const text = segment.slice(0, budget.characters)
    budget.characters -= text.length
    return text
  }
  if (Array.isArray(segment)) {
    const values: string[] = []
    for (const entry of segment) {
      const text = segmentToText(entry, budget)
      if (text) values.push(text)
      if (budget.characters <= 0 || budget.segments <= 0) break
    }
    return values.join("\n")
  }
  if (!segment || typeof segment !== "object") return ""

  const candidate = segment as { text?: unknown; value?: unknown; content?: unknown[] }
  const parts: string[] = []
  if (typeof candidate.text === "string") parts.push(segmentToText(candidate.text, budget))
  if (typeof candidate.value === "string") parts.push(segmentToText(candidate.value, budget))
  if (Array.isArray(candidate.content)) {
    parts.push(segmentToText(candidate.content, budget))
  }
  return parts.filter(Boolean).join("\n")
}

function extractReasoningText(part: ClientPart, characterLimit: number): string {
  const budget = { characters: characterLimit, segments: MAX_SEARCH_SEGMENTS }
  const text = segmentToText((part as any).text, budget)
  const content = segmentToText((part as any).content, budget)
  return [text, content].filter(Boolean).join("\n")
}

function extractGenericPartText(part: ClientPart, characterLimit: number): string {
  const candidate = part as Record<string, unknown>
  const values = [
    candidate.text,
    candidate.content,
    candidate.value,
    candidate.title,
    candidate.name,
    candidate.filename,
    candidate.message,
  ]
  const budget = { characters: characterLimit, segments: MAX_SEARCH_SEGMENTS }
  return values.map((value) => segmentToText(value, budget)).filter(Boolean).join("\n")
}

function extractToolText(part: Extract<ClientPart, { type: "tool" }>): string {
  const toolName = typeof part.tool === "string" ? part.tool : ""
  const context = { toolCall: part, toolState: (part as any).state, toolName }
  const renderer = resolveToolRenderer(toolName)
  const values = renderer.getSearchText?.(context) ?? getDefaultToolSearchText(context)
  return values.filter((value) => value.trim().length > 0).join("\n")
}

function extractMessageInfoText(info: MessageInfo | undefined, characterLimit: number): string {
  if (!info || info.role !== "assistant" || !info.error) return ""
  const error = info.error as { data?: { message?: unknown }; message?: unknown; name?: unknown }
  const values = [error.data?.message, error.message, error.name]
  const budget = { characters: characterLimit, segments: MAX_SEARCH_SEGMENTS }
  return values.map((value) => segmentToText(value, budget)).filter(Boolean).join("\n")
}

function extractSearchablePartText(part: ClientPart, includeThinking: boolean, characterLimit: number): SearchablePartText | null {
  if (!part || typeof part !== "object") return null
  if (isHiddenSyntheticTextPart(part)) return null

  const partId = typeof (part as any).id === "string" ? (part as any).id : undefined
  const partType = typeof (part as any).type === "string" ? (part as any).type : undefined

  if (part.type === "text") {
    const text = typeof (part as any).text === "string"
      ? (part as any).text.slice(0, characterLimit)
      : segmentToText((part as any).text, { characters: characterLimit, segments: MAX_SEARCH_SEGMENTS })
    return text.trim().length > 0 ? { partId, partType, text } : null
  }

  if (part.type === "reasoning") {
    if (!includeThinking) return null
    const text = extractReasoningText(part, characterLimit)
    return text.trim().length > 0 ? { partId, partType, text } : null
  }

  if (part.type === "file") {
    const filename = (part as any).filename
    const text = typeof filename === "string" ? filename.slice(0, characterLimit) : ""
    return text.trim().length > 0 ? { partId, partType, text } : null
  }

  if (part.type === "tool") {
    const text = extractToolText(part)
    return text.trim().length > 0 ? { partId, partType, text } : null
  }

  if (part.type === "compaction") {
    const text = (part as any).auto ? "Session auto-compacted" : "Session compacted"
    return { partId, partType, text }
  }

  const text = extractGenericPartText(part, characterLimit)
  return text.trim().length > 0 ? { partId, partType, text } : null
}

function collectRecordSearchableText(
  store: InstanceMessageStore,
  record: MessageRecord,
  includeThinking: boolean,
  partBudget: { remaining: number },
  characterBudget: { remaining: number },
): SearchablePartText[] {
  const results: SearchablePartText[] = []
  const partCount = Math.min(record.partIds.length, partBudget.remaining)
  partBudget.remaining -= partCount
  for (let index = 0; index < partCount; index += 1) {
    if (characterBudget.remaining <= 0) break
    const partId = record.partIds[index]
    const part = record.parts[partId]?.data
    if (!part) continue
    const text = extractSearchablePartText(part, includeThinking, Math.min(MAX_SEARCH_PART_CHARACTERS, characterBudget.remaining))
    if (text) {
      text.text = text.text.slice(0, characterBudget.remaining)
      characterBudget.remaining -= text.text.length
      results.push(text)
    }
  }

  const infoText = extractMessageInfoText(store.getMessageInfo(record.id), characterBudget.remaining)
  if (infoText.trim().length > 0) {
    results.push({ partType: "error", text: infoText })
    characterBudget.remaining -= infoText.length
  }

  return results
}

export function buildSessionSearchMatches(options: BuildSessionSearchMatchesOptions): SessionSearchMatch[] {
  const query = options.query.slice(0, MAX_SEARCH_QUERY_CHARACTERS).trim()
  if (!query) return []

  const matches: SessionSearchMatch[] = []
  const maxMatches = 1_000
  const messageIds = options.store.getSessionMessageIds(options.sessionId)
  const partBudget = { remaining: MAX_SEARCH_PARTS }
  const characterBudget = { remaining: MAX_SEARCH_TOTAL_CHARACTERS }
  const normalizedQuery = query.toLocaleLowerCase()
  const firstMessageIndex = Math.max(0, messageIds.length - MAX_SEARCH_MESSAGES)

  for (let messageIndex = firstMessageIndex; messageIndex < messageIds.length; messageIndex += 1) {
    const messageId = messageIds[messageIndex]
    const record = options.store.getMessage(messageId)
    if (!record) continue
    const searchableParts = collectRecordSearchableText(options.store, record, options.includeThinking, partBudget, characterBudget)

    for (const searchable of searchableParts) {
      const searchableText = searchable.text.slice(0, MAX_SEARCH_PART_CHARACTERS)
      const occurrences = findTextSearchOccurrences(searchableText, query, maxMatches - matches.length, normalizedQuery)
      for (const occurrence of occurrences) {
        matches.push({
          id: `${messageId}:${searchable.partId ?? searchable.partType ?? "info"}:${occurrence.start}`,
          messageId,
          partId: searchable.partId,
          partType: searchable.partType,
          role: record.role,
          ...occurrence,
        })
        if (matches.length >= maxMatches) return matches
      }
    }
    if (partBudget.remaining === 0 || characterBudget.remaining === 0) break
  }

  return matches
}
