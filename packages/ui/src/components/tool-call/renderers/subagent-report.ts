/**
 * Background subagent delivery. A background launch completes its tool call at once with
 * `metadata.status: "running"`; the child's result reaches the parent session later as hidden
 * synthetic reports, one per idle period:
 * `<subagent sessionID="…" state="…" description="…">\n<body>\n</subagent>`.
 * A report tagged `running` is intermediate: the child still owns background work.
 */
export type SubagentReportState = "running" | "completed" | "error" | "cancelled"

export interface SubagentReport {
  childId: string
  state: SubagentReportState
  body: string
  createdAt: number
  messageId: string
}

/** Bounded backward scan of the parent session for one card's reports. */
export const SUBAGENT_REPORT_SCAN_LIMIT = 500

const REPORT = /^<subagent sessionID="([^"]+)" state="(running|completed|error|cancelled)"[^\n]*>\n([\s\S]*)\n<\/subagent>\s*$/

export function parseSubagentReport(text: string): Pick<SubagentReport, "childId" | "state" | "body"> | null {
  const match = REPORT.exec(text)
  return match ? { childId: match[1], state: match[2] as SubagentReportState, body: match[3] } : null
}

/** A tool state that only acknowledges a background launch (OpenCode 2.3 always; 2.2 with `background: true`). */
export function isBackgroundSubagentLaunch(state: unknown): boolean {
  const value = state as { status?: unknown; metadata?: { status?: unknown } } | null | undefined
  return value?.status === "completed" && value.metadata?.status === "running"
}

type ReportMessage = {
  createdAt: number
  partIds: readonly string[]
  parts: Record<string, { data?: unknown } | undefined>
}

/**
 * The child's latest report after its launch message. Listing order need not follow delivery
 * order, so the latest is chosen by creation time, then by monotonic message id.
 */
export function findLatestSubagentReport(
  messageIds: readonly string[],
  getMessage: (messageId: string) => ReportMessage | undefined,
  childId: string,
  launchMessageId?: string,
): SubagentReport | null {
  let latest: SubagentReport | null = null
  const oldest = Math.max(0, messageIds.length - SUBAGENT_REPORT_SCAN_LIMIT)
  for (let index = messageIds.length - 1; index >= oldest; index -= 1) {
    const messageId = messageIds[index]
    if (messageId === launchMessageId) break
    const record = getMessage(messageId)
    if (!record) continue
    for (const partId of record.partIds) {
      const part = record.parts[partId]?.data as { type?: unknown; synthetic?: unknown; text?: unknown } | undefined
      if (part?.type !== "text" || !part.synthetic || typeof part.text !== "string") continue
      const report = parseSubagentReport(part.text)
      if (!report || report.childId !== childId) continue
      const candidate = { ...report, createdAt: record.createdAt, messageId }
      if (!latest || candidate.createdAt > latest.createdAt
        || (candidate.createdAt === latest.createdAt && candidate.messageId > latest.messageId)) latest = candidate
    }
  }
  return latest
}
