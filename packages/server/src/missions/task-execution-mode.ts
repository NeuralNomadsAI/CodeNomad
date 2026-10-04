/** Business execution choice, separate from the agent/model selection. */
export type MissionTaskExecutionMode =
  | { kind: "native"; parentTaskKey: string | null; reuseFromTaskKey?: string }
  | { kind: "independent"; reason: "location" | "lifetime" | "existing-root" | "playbook"; explanation: string }

/** Absence stays absent. Invalid declarations throw rather than lose fields. */
export function parseExecutionMode(input: unknown): MissionTaskExecutionMode | undefined {
  if (input === undefined) return undefined
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid task execution mode")
  const value = input as Record<string, unknown>
  const only = (fields: readonly string[]) => {
    if (Object.keys(value).some(key => !fields.includes(key))) throw new Error("Unknown task execution mode field")
  }
  const taskKey = (input: unknown): string => {
    if (typeof input !== "string" || !/^[a-z0-9][a-z0-9._-]{1,63}$/.test(input)) throw new Error("Invalid execution mode task key")
    return input
  }
  if (value.kind === "native") {
    only(["kind", "parentTaskKey", "reuseFromTaskKey"])
    return {
      kind: "native",
      parentTaskKey: value.parentTaskKey === null ? null : taskKey(value.parentTaskKey),
      ...(value.reuseFromTaskKey === undefined ? {} : { reuseFromTaskKey: taskKey(value.reuseFromTaskKey) }),
    }
  }
  if (value.kind === "independent") {
    only(["kind", "reason", "explanation"])
    if (value.reason !== "location" && value.reason !== "lifetime" && value.reason !== "existing-root" && value.reason !== "playbook") {
      throw new Error("Invalid independent task reason")
    }
    if (typeof value.explanation !== "string" || !value.explanation.trim() || value.explanation.length > 2_000) {
      throw new Error("Invalid independent task explanation")
    }
    return { kind: "independent", reason: value.reason, explanation: value.explanation }
  }
  throw new Error("Invalid task execution mode kind")
}

export function sameExecutionMode(left?: MissionTaskExecutionMode, right?: MissionTaskExecutionMode): boolean {
  if (!left || !right) return left === right
  if (left.kind === "native" && right.kind === "native") {
    return left.parentTaskKey === right.parentTaskKey && left.reuseFromTaskKey === right.reuseFromTaskKey
  }
  return left.kind === "independent" && right.kind === "independent"
    && left.reason === right.reason && left.explanation === right.explanation
}
