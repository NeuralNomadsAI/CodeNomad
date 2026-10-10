// Exact task → native child evidence from the coordinator's own transcript:
// a native `subagent` call whose prompt carries the canonical Mission assignment
// (server `buildAssignmentPrompt`) and whose state metadata names the child.
// No title, timing or ordering heuristics.

const HEADER = "# CodeNomad Mission Assignment"
const MISSION_LINE = /^You are a [a-z -]+ in mission (\S+)\.$/m

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** Returns child session IDs per task key, oldest first (the latest call is last). */
export function parseMissionTaskSessions(missionId: string, coordinatorSessionId: string, messages: readonly unknown[]): Map<string, string[]> {
  const result = new Map<string, string[]>()
  for (const message of messages) {
    const value = record(message)
    if (value?.type !== "assistant" || !Array.isArray(value.content)) continue
    for (const raw of value.content) {
      const part = record(raw), state = record(part?.state)
      if (part?.type !== "tool" || part.name !== "subagent" || !state) continue
      const prompt = record(state.input)?.prompt, child = record(state.metadata)?.sessionID
      if (typeof prompt !== "string" || typeof child !== "string" || !child || child === coordinatorSessionId) continue
      // The coordinator may wrap the canonical prompt; read only from its header.
      const start = prompt.indexOf(HEADER)
      const assignment = start < 0 ? "" : prompt.slice(start, start + 4_000)
      // First occurrences only: these header lines precede the untrusted task data.
      if (MISSION_LINE.exec(assignment)?.[1] !== missionId) continue
      const key = /^Task key: (\S+)$/m.exec(assignment)?.[1]
      if (!key) continue
      const sessions = result.get(key) ?? []
      result.set(key, [...sessions.filter(id => id !== child), child])
    }
  }
  return result
}
