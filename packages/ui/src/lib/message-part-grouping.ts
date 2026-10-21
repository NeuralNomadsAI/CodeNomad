import { isHiddenSyntheticTextPart, partHasRenderableText, type ClientPart, type MessageInfo } from "../types/message"

export type TechnicalGroupKind = "reasoning" | "exploration" | "shell"

/** A displayed part's transcript row kind: text runs share content rows, tools/system/compaction stand alone. */
export type TranscriptRowKind = TechnicalGroupKind | "content" | "part"

/** One transcript row: a content row, a technical group, a standalone part or (`null`) the omitted-parts gap. */
export type TranscriptRow<T> =
  | { [K in "content" | TechnicalGroupKind]: { kind: K; items: T[]; groupId?: string } }["content" | TechnicalGroupKind]
  | { kind: "part"; item: T }
  | null

export interface TranscriptTechnicalPart {
  messageId: string
  partId: string
  part: ClientPart
  completed: boolean
  revision: string
}

export interface TranscriptTechnicalGroup {
  id: string
  kind: TechnicalGroupKind
  parts: TranscriptTechnicalPart[]
  completed: boolean
  signature: string
}

export interface TechnicalCleanupPart {
  messageId: string
  partId: string
  type: "tool" | "reasoning"
}

export type TechnicalCleanupTranscriptItem =
  | TechnicalCleanupPart
  | { messageId: string; partId: string; type: "boundary" }
  | null

export type ExplorationSegment<T> =
  | { kind: "group"; items: T[] }
  | { kind: "pending"; item: T }

export function toolGroupKind(name: string) {
  const tool = name.toLowerCase()
  if (["read", "glob", "grep"].includes(tool)) return "exploration" as const
  if (tool === "bash" || tool === "shell") return "shell" as const
}

export function getTechnicalGroupKind(part: ClientPart) {
  if (part.type === "reasoning") return "reasoning" as const
  if (part.type === "tool") return toolGroupKind(part.tool)
}

export function transcriptPartKind(part: ClientPart): TranscriptRowKind {
  return getTechnicalGroupKind(part) ?? (part.type === "tool" || part.type === "system" || part.type === "compaction" ? "part" : "content")
}

export function reasoningHasRenderableContent(part: ClientPart): boolean {
  return part.type === "reasoning" && part.text.trim().length > 0
}

export function isTechnicalGroupingVisiblePart(part: ClientPart): boolean {
  if (part.type === "reasoning") return reasoningHasRenderableContent(part)
  if (part.type === "text" || part.type === "file") return !isHiddenSyntheticTextPart(part) && partHasRenderableText(part)
  return true
}

/** Text that answers the user: it bounds technical cleanup runs and agent responses. */
export function isResponseTextPart(part: ClientPart): boolean {
  return (part.type === "text" || part.type === "file") && !isHiddenSyntheticTextPart(part) && partHasRenderableText(part)
}

/** Adds up native usage of distinct messages; `base` supplies the line's own metadata. */
export function sumMessageUsage(base: MessageInfo, messages: ReadonlyArray<MessageInfo | undefined>): MessageInfo {
  const settled = messages.filter((info): info is MessageInfo => Boolean(info?.tokens))
  const total = (read: (tokens: NonNullable<MessageInfo["tokens"]>) => number | undefined) =>
    settled.reduce((sum, info) => sum + (read(info.tokens!) ?? 0), 0)
  return {
    ...base,
    tokens: {
      input: total(tokens => tokens.input), output: total(tokens => tokens.output), reasoning: total(tokens => tokens.reasoning),
      cache: { read: total(tokens => tokens.cache?.read), write: total(tokens => tokens.cache?.write) },
    },
    cost: settled.reduce((sum, info) => sum + (info.cost ?? 0), 0),
  }
}

export function technicalPartKey(messageId: string, partId: string) {
  return `${messageId}:${partId}`
}

/**
 * The transcript's row boundaries over a message's displayed items, shared by
 * its blocks and the timeline rail: consecutive content items form one row,
 * consecutive technical items of one kind (and group) one group; `null`, the
 * omitted-parts gap, ends every row.
 */
export function groupTranscriptRows<T>(items: Array<T | null>, classify: (item: T) => { kind: TranscriptRowKind; groupId?: string }): TranscriptRow<T>[] {
  const rows: TranscriptRow<T>[] = []
  for (const item of items) {
    if (item === null) {
      rows.push(null)
      continue
    }
    const { kind, groupId } = classify(item)
    const previous = rows.at(-1)
    if (kind === "part") rows.push({ kind, item })
    else if (previous && previous.kind !== "part" && previous.kind === kind && previous.groupId === groupId) previous.items.push(item)
    else rows.push({ kind, items: [item], groupId })
  }
  return rows
}

export function projectTranscriptTechnicalGroups(items: Array<TranscriptTechnicalPart | null>) {
  const groups: TranscriptTechnicalGroup[] = []
  const byPartKey = new Map<string, TranscriptTechnicalGroup>()
  let current: Omit<TranscriptTechnicalGroup, "completed" | "signature"> | undefined

  const flush = (closed: boolean) => {
    if (!current) return
    const completed = closed || Boolean(current.parts.at(-1)?.completed)
    const group: TranscriptTechnicalGroup = {
      ...current,
      completed,
      signature: `${completed ? 1 : 0}|${current.parts.map((item) => `${technicalPartKey(item.messageId, item.partId)}:${item.revision}`).join("|")}`,
    }
    groups.push(group)
    for (const item of group.parts) byPartKey.set(technicalPartKey(item.messageId, item.partId), group)
    current = undefined
  }

  for (const item of items) {
    if (!item) {
      flush(true)
      continue
    }
    const kind = getTechnicalGroupKind(item.part)
    if (!kind) {
      flush(true)
      continue
    }
    if (current && current.kind !== kind) flush(true)
    if (!current) current = { id: `${technicalPartKey(item.messageId, item.partId)}:${kind}`, kind, parts: [] }
    current.parts.push(item)
  }
  flush(false)

  return { groups, byPartKey }
}

export function getTechnicalCleanupParts(
  items: TechnicalCleanupTranscriptItem[],
  targetMessageId: string,
  targetPartId: string,
): TechnicalCleanupPart[] {
  const targetIndex = items.findIndex((item) => item?.type === "boundary"
    && item.messageId === targetMessageId
    && item.partId === targetPartId)
  if (targetIndex < 0) return []

  const parts: TechnicalCleanupPart[] = []
  for (let index = targetIndex - 1; index >= 0; index--) {
    const item = items[index]
    if (!item || item.type === "boundary") break
    parts.unshift(item)
  }
  return parts
}

export function segmentExplorationItems<T>(items: T[], isPending: (item: T) => boolean): ExplorationSegment<T>[] {
  return items.reduce<ExplorationSegment<T>[]>((segments, item) => {
    const previous = segments.at(-1)
    if (isPending(item)) {
      segments.push({ kind: "pending", item })
    } else if (previous?.kind === "group") {
      previous.items.push(item)
    } else {
      segments.push({ kind: "group", items: [item] })
    }
    return segments
  }, [])
}
