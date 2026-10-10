// Exact task  native child evidence from the coordinator's own transcript:
// a native `subagent` call whose prompt carries the canonical Mission assignment
// (server `buildAssignmentPrompt`) and whose state metadata names the child.
// Native metadata proves the direct child; only the prompt's positively recognized
// header binds it to a task. No title, timing, ordering or contextual heuristics.

// A trailing sentence period ends a token; dots inside a key stay part of it.
const KEY = String.raw`([a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?)(?=$|[\s,;:)]|\.(?![a-z0-9]))`
const ID = String.raw`([A-Za-z0-9_-]+)(?=$|[\s,;:)]|\.(?![A-Za-z0-9_-]))`

const HEADER = /^# CodeNomad Mission Assignment$/m
// The header lines precede the untrusted task data and must appear in this order.
const CANONICAL = new RegExp(String.raw`^# CodeNomad Mission Assignment\n\nYou are a (?:native task actor|visible independent root-session actor) in mission ${ID}\.\n\nPlaybook: [^\n]*\nRole: [^\n]*\nTask key: ${KEY}\nBlocked by: `)

// Coordinators may also open their own brief with a short structural relation that
// binds the exact mission ID to one task key. Only the first line counts.
const SHORT = [
  { pattern: new RegExp(String.raw`^(?:(?:New )?[Dd]eclared )?[Mm]ission ${ID} task ${KEY}`), id: 1, key: 2 },
  { pattern: new RegExp(String.raw`^(?:New )?[Dd]eclared (?:mission )?task ${KEY} \(${ID}\)`), id: 2, key: 1 },
  { pattern: new RegExp(String.raw`^(?:New )?[Dd]eclared (?:mission )?task ${KEY} mission ${ID}`), id: 2, key: 1 },
]

function canonicalTaskKey(prompt: string, missionId: string): string | undefined {
  // The coordinator may wrap the canonical prompt; read only its first header line.
  const text = prompt.replace(/\r\n/g, "\n")
  const start = HEADER.exec(text)?.index
  if (start === undefined) return undefined
  const match = CANONICAL.exec(text.slice(start, start + 4_000))
  return match && match[1] === missionId ? match[2] : undefined
}

function shortTaskKey(prompt: string, missionId: string): string | undefined {
  const line = prompt.trimStart().split("\n", 1)[0] ?? ""
  for (const { pattern, id, key } of SHORT) {
    const match = pattern.exec(line)
    if (match) return match[id] === missionId ? match[key] : undefined
  }
  return undefined
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** A running native `subagent` call records its child only when it completes; until
 * then the child's own first (user) message carries the exact canonical assignment. */
export function parseMissionChildTaskKey(missionId: string, firstMessage: unknown, taskKeys: ReadonlySet<string>): string | undefined {
  const value = record(firstMessage)
  if (value?.type !== "user" || typeof value.text !== "string") return undefined
  const key = canonicalTaskKey(value.text, missionId)
  return key && taskKeys.has(key) ? key : undefined
}

/** Returns child session IDs per declared task key, oldest first (the latest call is last). */
export function parseMissionTaskSessions(missionId: string, coordinatorSessionId: string, messages: readonly unknown[],
  taskKeys: ReadonlySet<string>): Map<string, string[]> {
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
      if (!key || !taskKeys.has(key)) continue
      const sessions = result.get(key) ?? []
      result.set(key, [...sessions.filter(id => id !== child), child])
    }
  }
  return result
}
