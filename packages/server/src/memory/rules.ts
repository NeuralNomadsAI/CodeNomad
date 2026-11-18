/// <reference lib="es2022.intl" />
import { randomUUID } from "node:crypto"
import { MEMORY_LIMITS, MemoryError, validateMemoryContent, validateMemoryEntry, type MemoryContent, type MemoryEntry, type MemoryScope } from "./model"
import { MEMORY_INJECTION_PATTERNS, MEMORY_ROLE_PATTERN, MEMORY_STOPWORDS } from "./language-data"
import type { MemoryMutation } from "./store"

export type MemoryReviewEntry = MemoryEntry & { flagged: boolean }
const segmenter = new Intl.Segmenter("en", { granularity: "word" })
const normalize = (text: string) => text.normalize("NFKC").toLowerCase()
export const normalizeMemoryTitle = (title: string): string => normalize(title).trim().replace(/\s+/gu, " ")
const stopwords = new Set(Object.values(MEMORY_STOPWORDS).flatMap(words => words.split(" ").map(normalize)))
const patterns = Object.values(MEMORY_INJECTION_PATTERNS).flat()

function words(text: string): Set<string> {
  return new Set(Array.from(segmenter.segment(normalize(text)))
    .filter(word => word.isWordLike && /\p{L}/u.test(word.segment) && !stopwords.has(word.segment))
    .map(word => word.segment))
}

function similarity(left: Set<string>, right: Set<string>): number {
  if (left.size < 4 || right.size < 4) return 0
  let common = 0
  for (const word of left) if (right.has(word)) common++
  return common / (left.size + right.size - common)
}

/** Exact titles win; equal text scores resolve by portable ID, independent of filesystem order. */
function duplicate(entries: readonly MemoryEntry[], content: MemoryContent): MemoryEntry | undefined {
  const ordered = [...entries].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  const title = normalizeMemoryTitle(content.title)
  const exact = ordered.find(entry => normalizeMemoryTitle(entry.title) === title)
  if (exact) return exact
  const incoming = words(content.text)
  let best: MemoryEntry | undefined, score = 0
  for (const entry of ordered) {
    const candidate = similarity(incoming, words(entry.text))
    if (candidate >= 0.75 && candidate > score) { best = entry; score = candidate }
  }
  return best
}

/** Invoke only from MemoryStore.mutate, using the fresh scope protected by its lock. */
export function decideMemorySave(scope: MemoryScope, entries: readonly MemoryEntry[], input: unknown, sessionId: string, id?: string): MemoryMutation<MemoryEntry> {
  const content = validateMemoryContent(input)
  const match = duplicate(entries, content)
  const existing = id === undefined ? match : entries.find(entry => entry.id === id)
  if (id !== undefined && !existing) throw new MemoryError("invalid", "Unknown memory entry")
  if (id !== undefined && match && match.id !== id)
    throw new MemoryError("conflict", "Merge or delete the duplicate memory entry before retrying")
  if (!existing && entries.length >= MEMORY_LIMITS[scope])
    throw new MemoryError("full", "Memory is full. Merge or delete entries before retrying.", entries.map(entry => entry.title))
  const now = new Date().toISOString()
  const entry = validateMemoryEntry({ ...content, id: existing?.id ?? randomUUID(), createdAt: existing?.createdAt ?? now, updatedAt: now, sessionId })
  return { kind: "save", entry, result: entry }
}

/** Recompute from both current fields, including externally edited files, without following references. */
export function reviewMemoryEntry(entry: MemoryEntry): MemoryReviewEntry {
  const flagged = [entry.title, entry.text].some(value => {
    const text = normalize(value).replace(/\p{Cf}/gu, "").replace(/[^\S\n]+/gu, " ")
    return MEMORY_ROLE_PATTERN.test(text) || patterns.some(pattern => pattern.test(text.replace(/\s+/gu, " ")))
  })
  return { ...entry, flagged }
}

export function memoryForAgent(entries: readonly MemoryEntry[]): MemoryEntry[] {
  return entries.filter(entry => !reviewMemoryEntry(entry).flagged)
}
