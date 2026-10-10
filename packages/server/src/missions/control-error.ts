export class MissionControlError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
    this.name = "MissionControlError"
  }
}

/** Model-facing refusal of the Wayfinder human gate. The innermost cause is kept as a
 * detail; native Effect wrappers ("An error occurred in Effect.tryPromise") are skipped. */
export function humanDecisionRequired(cause?: unknown) {
  let detail: string | undefined
  for (let error = cause, depth = 0; error instanceof Error && depth < 8; error = (error as { cause?: unknown }).cause, depth++)
    if (error.message && !error.message.startsWith("An error occurred in Effect.")) detail = error.message
  return new MissionControlError("Human decision required: the user must answer this question from the CodeNomad interface. "
    + "An ordinary or agent answer is not a proven human decision; ask again with the native question tool if needed."
    + (detail ? ` (${detail})` : ""), "policy-unqualified")
}

/** Only the authoritative create preflight may certify this exact no-write denial. */
export class MissionCreateNoEffectError extends MissionControlError {
  readonly noEffect: { requestID: string; missionID: string }

  constructor(requestID: string, missionID: string, code: "mission-limit" | "request-conflict" = "mission-limit") {
    super(code === "mission-limit" ? "Project mission limit reached" : "Creation request ID was already used with a different mission", code)
    this.noEffect = { requestID, missionID }
  }
}
