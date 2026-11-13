/**
 * Background subagent delivery. A background launch completes its tool call at once with
 * `metadata.status: "running"`; the child's result reaches the parent session later as hidden
 * synthetic reports, one per idle period:
 * `<subagent sessionID="…" state="…" description="…">\n<body>\n</subagent>`.
 * A report tagged `running` is intermediate: the child still owns background work.
 */
import type { ClientPart } from "../../../types/message"
import { getPartStartedAt } from "../../../lib/message-timing"

export type SubagentReportState = "running" | "completed" | "error" | "cancelled"

export interface SubagentReport {
  childId: string
  state: SubagentReportState
  body: string
  createdAt: number
  messageId: string
}

/** One child's reports and the creation times of every call that launched or continued it. */
export interface SubagentDeliveries {
  reports: SubagentReport[]
  launches: number[]
}

/** Bounded scan of the parent session's newest messages. */
export const SUBAGENT_REPORT_SCAN_LIMIT = 500

const REPORT = /^<subagent sessionID="([^"]+)" state="(running|completed|error|cancelled)"[^\n]*>\n([\s\S]*)\n<\/subagent>\s*$/
const SUBAGENT_TOOLS = new Set(["subagent", "task"])

export function parseSubagentReport(text: string): Pick<SubagentReport, "childId" | "state" | "body"> | null {
  const match = REPORT.exec(text)
  return match ? { childId: match[1], state: match[2] as SubagentReportState, body: match[3] } : null
}

/** A tool state that only acknowledges a background launch (OpenCode 2.3 always; 2.2 with `background: true`). */
export function isBackgroundSubagentLaunch(state: unknown): boolean {
  const value = state as { status?: unknown; metadata?: { status?: unknown } } | null | undefined
  return value?.status === "completed" && value.metadata?.status === "running"
}

/** The child session a subagent call launched or continued. */
export function subagentChildId(state: unknown): string {
  const metadata = (state as { metadata?: { sessionID?: unknown; sessionId?: unknown } } | null | undefined)?.metadata
  const id = metadata?.sessionId ?? metadata?.sessionID
  return typeof id === "string" ? id : ""
}

type ReportMessage = {
  createdAt: number
  partIds: readonly string[]
  parts: Record<string, { data?: unknown } | undefined>
}

/** When a call started executing (`time.ran`, else its part or message creation): reports before it belong to earlier calls. */
export function subagentCallTime(part: unknown, messageCreatedAt: number): number {
  return getPartStartedAt(part as ClientPart) ?? messageCreatedAt
}

/** Every child's reports and launch times in the parent session; listing order is irrelevant. */
export function indexSubagentDeliveries(
  messageIds: readonly string[],
  getMessage: (messageId: string) => ReportMessage | undefined,
): Map<string, SubagentDeliveries> {
  const index = new Map<string, SubagentDeliveries>()
  const entry = (childId: string) => {
    let value = index.get(childId)
    if (!value) index.set(childId, value = { reports: [], launches: [] })
    return value
  }
  for (let position = Math.max(0, messageIds.length - SUBAGENT_REPORT_SCAN_LIMIT); position < messageIds.length; position += 1) {
    const messageId = messageIds[position]
    const record = getMessage(messageId)
    if (!record) continue
    for (const partId of record.partIds) {
      const part = record.parts[partId]?.data as { type?: unknown; synthetic?: unknown; text?: unknown; tool?: unknown; state?: unknown } | undefined
      if (part?.type === "tool" && typeof part.tool === "string" && SUBAGENT_TOOLS.has(part.tool)) {
        const childId = subagentChildId(part.state)
        if (childId) entry(childId).launches.push(subagentCallTime(part, record.createdAt))
        continue
      }
      if (part?.type !== "text" || !part.synthetic || typeof part.text !== "string") continue
      const report = parseSubagentReport(part.text)
      if (report) entry(report.childId).reports.push({ ...report, createdAt: record.createdAt, messageId })
    }
  }
  return index
}

/**
 * The latest report delivered to the call started at `launchedAt`, chosen by creation time, then
 * by monotonic message id. A call's period ends at the next call continuing the same child; every
 * idle period reports, so a period without a report was still running when continued and joins
 * the next call's period until one reports.
 */
export function latestReportForLaunch(deliveries: SubagentDeliveries | undefined, launchedAt: number): SubagentReport | null {
  if (!deliveries) return null
  const boundaries = [...deliveries.launches.filter(time => time > launchedAt).sort((left, right) => left - right), Infinity]
  for (const end of boundaries) {
    let latest: SubagentReport | null = null
    for (const report of deliveries.reports) {
      if (report.createdAt < launchedAt || report.createdAt >= end) continue
      if (!latest || report.createdAt > latest.createdAt
        || (report.createdAt === latest.createdAt && report.messageId > latest.messageId)) latest = report
    }
    if (latest) return latest
  }
  return null
}

type IndexOwner = object
const indexes = new WeakMap<IndexOwner, Map<string, { revision: number; messageIds: readonly string[]; length: number; index: Map<string, SubagentDeliveries> }>>()

/**
 * One index per session revision, shared by every card of that session. Owned by the message store
 * and tied to the session's message-id list, so eviction, reload or store replacement (which can
 * restart revision numbers) always rebuild it.
 */
export function cachedSubagentDeliveries(owner: IndexOwner, sessionId: string, revision: number,
  messageIds: readonly string[], build: () => Map<string, SubagentDeliveries>) {
  let sessions = indexes.get(owner)
  if (!sessions) indexes.set(owner, sessions = new Map())
  const cached = sessions.get(sessionId)
  if (cached && cached.revision === revision && cached.messageIds === messageIds && cached.length === messageIds.length) return cached.index
  const index = build()
  sessions.set(sessionId, { revision, messageIds, length: messageIds.length, index })
  return index
}
