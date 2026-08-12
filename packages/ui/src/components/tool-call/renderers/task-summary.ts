export const TASK_STEP_RENDER_LIMIT = 200

export function getLegacyTaskSummary(summary: unknown) {
  const entries = Array.isArray(summary) ? summary : []
  return {
    entries,
    renderedEntries: entries.slice(-TASK_STEP_RENDER_LIMIT),
    truncated: entries.length > TASK_STEP_RENDER_LIMIT,
  }
}

export function stringifyLegacyTaskSummary(summary: unknown): string {
  return JSON.stringify(getLegacyTaskSummary(summary).entries, null, 2)
}
