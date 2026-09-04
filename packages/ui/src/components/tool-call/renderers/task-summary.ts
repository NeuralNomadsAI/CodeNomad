import { limitToolTitleForRender } from "../utils"

export const TASK_STEP_RENDER_LIMIT = 200

export function isTaskStepListTruncated(count: number): boolean {
  return count > TASK_STEP_RENDER_LIMIT
}

export function isTaskScanTruncated(...sources: boolean[]): boolean {
  return sources.some(Boolean)
}

export function resolveTaskStepTruncation(childSourceActive: boolean, childTruncated: boolean, legacyTruncated: boolean): boolean {
  return childTruncated || (!childSourceActive && legacyTruncated)
}

export function getTaskOutputCopyText(state: unknown): string | null {
  const output = (state as { output?: unknown } | null | undefined)?.output
  return typeof output === "string" && output.length > 0 ? output : null
}

export function collectChildTaskSteps(
  messageIds: readonly string[],
  getMessage: (messageId: string) => { partIds: readonly string[]; parts: Record<string, { data?: unknown } | undefined> } | undefined,
): unknown[] {
  const steps: unknown[] = []
  for (const messageId of messageIds) {
    const message = getMessage(messageId)
    if (!message) continue
    for (const partId of message.partIds) {
      const part = message.parts[partId]?.data as { type?: unknown } | undefined
      if (part?.type === "tool") steps.push(part)
    }
  }
  return steps
}

export function stringifyChildTaskSteps(
  messageIds: readonly string[],
  getMessage: (messageId: string) => { partIds: readonly string[]; parts: Record<string, { data?: unknown } | undefined> } | undefined,
): string {
  return JSON.stringify(collectChildTaskSteps(messageIds, getMessage), null, 2)
}

export function getLegacyTaskSummary(summary: unknown) {
  const entries = Array.isArray(summary) ? summary : []
  return {
    entries,
    renderedEntries: entries.slice(-TASK_STEP_RENDER_LIMIT),
    truncated: isTaskStepListTruncated(entries.length),
  }
}

export function stringifyLegacyTaskSummary(summary: unknown): string {
  return JSON.stringify(getLegacyTaskSummary(summary).entries, null, 2)
}

export function getTruncatedTaskStepTitleCopyText(title: string): string | null {
  return limitToolTitleForRender(title) === title ? null : title
}
