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

/** Each native assistant message is one model step; its settlement records the step's usage. */
export function hasVisibleUsage(messageInfo: MessageInfo | undefined, usageVisible: boolean): boolean {
  return usageVisible && messageInfo?.role === "assistant" && Boolean(messageInfo.tokens)
}

/** A transcript record in order; prompts and native end-of-turn records end the turn. */
export interface UsageStep { messageId: string; endsTurn?: boolean; info?: MessageInfo; endsWithResponse?: boolean }

/** Whether a step's last cleanup item (tool, reasoning or response text) is response text. */
export function endsWithResponseText(parts: readonly ClientPart[]): boolean {
  const last = parts.filter((part) => part.type === "tool" || part.type === "reasoning" || isResponseTextPart(part)).at(-1)
  return Boolean(last && isResponseTextPart(last))
}
export interface UsageLine {
  /** The summed usage, shown with the response's own message metadata. */
  info: MessageInfo
  signature: string
}

/**
 * One usage line per agent response, with the scope of its "delete tools and
 * reasoning" cleanup: a settled step ending with response text shows the sum of
 * itself and every settled step since the previous such step or prompt. A step
 * whose response text is followed by tools passes its usage on to the next
 * response, so no usage line splits a technical group. A turn ending without a
 * response shows none.
 */
export function projectUsageLines(steps: readonly UsageStep[]): Map<string, UsageLine> {
  const lines = new Map<string, UsageLine>()
  let pending: MessageInfo[] = []
  for (const step of steps) {
    if (step.endsTurn) {
      pending = []
      continue
    }
    if (!hasVisibleUsage(step.info, true)) continue
    pending.push(step.info!)
    if (step.endsWithResponse) {
      lines.set(step.messageId, sumUsage(pending))
      pending = []
    }
  }
  return lines
}

function sumUsage(steps: MessageInfo[]): UsageLine {
  const total = (read: (tokens: NonNullable<MessageInfo["tokens"]>) => number | undefined) =>
    steps.reduce((sum, step) => sum + (read(step.tokens ?? {}) ?? 0), 0)
  const tokens = {
    input: total(tokens => tokens.input), output: total(tokens => tokens.output), reasoning: total(tokens => tokens.reasoning),
    cache: { read: total(tokens => tokens.cache?.read), write: total(tokens => tokens.cache?.write) },
  }
  const cost = steps.reduce((sum, step) => sum + (step.cost ?? 0), 0)
  return {
    info: { ...steps.at(-1)!, tokens, cost },
    signature: [steps.length, tokens.input, tokens.output, tokens.reasoning, tokens.cache.read, tokens.cache.write, cost].join(":"),
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
