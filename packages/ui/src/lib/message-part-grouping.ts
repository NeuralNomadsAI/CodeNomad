import { isHiddenSyntheticTextPart, partHasRenderableText, type ClientPart, type MessageInfo } from "../types/message"

export type TechnicalPartGroup =
  | { kind: "part"; part: ClientPart }
  | { kind: "reasoning"; parts: ClientPart[]; groupId?: string }
  | { kind: "exploration"; parts: ClientPart[]; groupId?: string }

export interface TranscriptTechnicalPart {
  messageId: string
  partId: string
  part: ClientPart
  completed: boolean
  revision: string
}

export interface TranscriptTechnicalGroup {
  id: string
  kind: "reasoning" | "exploration"
  parts: TranscriptTechnicalPart[]
  completed: boolean
  signature: string
}

export type ExplorationSegment<T> =
  | { kind: "group"; items: T[] }
  | { kind: "pending"; item: T }

export function getTechnicalGroupKind(part: ClientPart) {
  if (part.type === "reasoning") return "reasoning" as const
  if (part.type === "tool" && ["read", "glob", "grep"].includes(part.tool.toLowerCase())) return "exploration" as const
}

export function reasoningHasRenderableContent(part: ClientPart): boolean {
  const check = (segment: unknown): boolean => {
    if (typeof segment === "string") return segment.trim().length > 0
    if (!segment || typeof segment !== "object") return false
    const value = segment as { text?: unknown; value?: unknown; content?: unknown[] }
    return (typeof value.text === "string" && value.text.trim().length > 0)
      || (typeof value.value === "string" && value.value.trim().length > 0)
      || (Array.isArray(value.content) && value.content.some(check))
  }
  return part.type === "reasoning" && (check(part.text) || (Array.isArray((part as any).content) && (part as any).content.some(check)))
}

export function isTechnicalGroupingVisiblePart(part: ClientPart): boolean {
  if ((part as any)?.type === "patch") return false
  if (part.type === "step-start" || part.type === "step-finish") return false
  if (part.type === "reasoning") return reasoningHasRenderableContent(part)
  if (part.type === "text" || part.type === "file") return !isHiddenSyntheticTextPart(part) && partHasRenderableText(part)
  return true
}

export function isVisibleStepFinish(part: ClientPart, messageInfo: MessageInfo | undefined, usageVisible: boolean): boolean {
  if (part.type !== "step-finish" || !usageVisible) return false
  return Boolean((part as any).tokens ?? (messageInfo?.role === "assistant" ? messageInfo.tokens : undefined))
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
