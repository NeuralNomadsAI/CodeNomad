// Exact task → native child evidence from the coordinator's own transcript:
// a native `subagent` call whose prompt carries the canonical Mission assignment
// (server `buildAssignmentPrompt`) and whose state metadata names the child.
// No title, timing or ordering heuristics.

const HEADER = "# CodeNomad Mission Assignment"
const MISSION_LINE = /^You are a [a-z -]+ in mission (\S+)\.$/m

// Coordinators may also write their own brief that opens with the exact mission
// ID and task key: "Mission msn_… task <key>. …". Only the first line counts.
const SHORT_HEADER = /^Mission (\S+) task ([a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?)(?=[.:,;\s]|$)/

function canonicalTaskKey(prompt: string, missionId: string): string | undefined {
  // The coordinator may wrap the canonical prompt; read only from its header.
  const start = prompt.indexOf(HEADER)
  if (start < 0) return undefined
  const assignment = prompt.slice(start, start + 4_000)
  // First occurrences only: these header lines precede the untrusted task data.
  if (MISSION_LINE.exec(assignment)?.[1] !== missionId) return undefined
  return /^Task key: (\S+)$/m.exec(assignment)?.[1]
}

function shortTaskKey(prompt: string, missionId: string): string | undefined {
  const match = SHORT_HEADER.exec(prompt.trimStart().split("\n", 1)[0] ?? "")
  return match && match[1] === missionId ? match[2] : undefined
}

// Free-form coordinator briefs ("New declared mission task X (msn_…)", "Declared
// mission msn_… task X"): the opening must name this exact mission ID, and the
// FIRST "task <key>" phrase must be one of this mission's declared task keys.
const OPENING = 400
// A trailing sentence period ends the key; dots inside a key stay part of it.
const TASK_PHRASE = /\btask ([a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?)(?=$|[^a-z0-9._-]|\.(?![a-z0-9]))/

function declaredTaskKey(prompt: string, missionId: string, taskKeys: ReadonlySet<string>): string | undefined {
  const opening = prompt.trimStart().slice(0, OPENING)
  if (!opening.includes(missionId)) return undefined
  const key = TASK_PHRASE.exec(opening)?.[1]
  return key && taskKeys.has(key) ? key : undefined
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** A running native `subagent` call records its child only when it completes; until
 * then the child's own first (user) message carries the exact assignment prompt. */
export function parseMissionChildTaskKey(missionId: string, firstMessage: unknown, taskKeys: ReadonlySet<string>): string | undefined {
  const value = record(firstMessage)
  if (value?.type !== "user" || typeof value.text !== "string") return undefined
  const key = canonicalTaskKey(value.text, missionId)
  return key && taskKeys.has(key) ? key : undefined
}

/** Returns child session IDs per task key, oldest first (the latest call is last). */
export function parseMissionTaskSessions(missionId: string, coordinatorSessionId: string, messages: readonly unknown[],
  taskKeys: ReadonlySet<string> = new Set()): Map<string, string[]> {
  const result = new Map<string, string[]>()
  for (const message of messages) {
    const value = record(message)
    if (value?.type !== "assistant" || !Array.isArray(value.content)) continue
    for (const raw of value.content) {
      const part = record(raw), state = record(part?.state)
      if (part?.type !== "tool" || part.name !== "subagent" || !state) continue
      const prompt = record(state.input)?.prompt, child = record(state.metadata)?.sessionID
      if (typeof prompt !== "string" || typeof child !== "string" || !child || child === coordinatorSessionId) continue
      const key = canonicalTaskKey(prompt, missionId) ?? shortTaskKey(prompt, missionId)
        ?? declaredTaskKey(prompt, missionId, taskKeys)
      if (!key) continue
      const sessions = result.get(key) ?? []
      result.set(key, [...sessions.filter(id => id !== child), child])
    }
  }
  return result
}
