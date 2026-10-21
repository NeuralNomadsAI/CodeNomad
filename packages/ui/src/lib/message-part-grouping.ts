import { isHiddenSyntheticTextPart, partHasRenderableText, type ClientPart, type MessageInfo } from "../types/message"

export type TechnicalGroupKind = "reasoning" | "exploration" | "shell"

export type TechnicalPartGroup =
  | { kind: "part"; part: ClientPart }
  | { kind: "reasoning"; parts: ClientPart[]; groupId?: string }
  | { kind: "exploration"; parts: ClientPart[]; groupId?: string }
  | { kind: "shell"; parts: ClientPart[]; groupId?: string }

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

export function getTechnicalGroupKind(part: ClientPart) {
  if (part.type === "reasoning") return "reasoning" as const
  if (part.type !== "tool") return
  const tool = part.tool.toLowerCase()
  if (["read", "glob", "grep"].includes(tool)) return "exploration" as const
  if (tool === "bash" || tool === "shell") return "shell" as const
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

export function groupTechnicalParts(parts: ClientPart[], getGroupId?: (part: ClientPart) => string | undefined): TechnicalPartGroup[] {
  return parts.reduce<TechnicalPartGroup[]>((groups, part) => {
    const kind = getTechnicalGroupKind(part)
    const groupId = kind ? getGroupId?.(part) : undefined
    const previous = groups.at(-1)
    if (!kind) {
      groups.push({ kind: "part", part })
    } else if (previous?.kind === kind && previous.groupId === groupId) {
      previous.parts.push(part)
    } else {
      groups.push({ kind, parts: [part], groupId })
    }
    return groups
  }, [])
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
