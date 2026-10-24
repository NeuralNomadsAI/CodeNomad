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

/** Model-facing refusal when a Wayfinder decision cannot name the exact native call that asked the human. */
export function decisionInvocationUnavailable() {
  return new MissionControlError("Wayfinder decision invocation unavailable: a completed decision task cites the human's answer to a native question "
    + "asked from the task's own conversation, which your subagent call launched with its exact assignmentPrompt. Pass artifact "
    + '{"kind":"decision","question":"...","answer":"...","provenance":{"kind":"native-form-answer","contract":{"missionID":"...","taskKey":"...","generation":1},'
    + '"nativeCall":{"generation":1,"parentSessionID":"<launching conversation>","parentMessageID":"<its message holding the subagent call>","toolCallID":"<that subagent call>"},'
    + '"sessionID":"<decision conversation>","formID":"<answered Form>","messageID":"<its message holding the question call>","toolCallID":"<that question call>","fieldKey":"q0"}}. '
    + "Record a self-contained analysis as a research task instead, or report this decision blocked.", "policy-unqualified")
}

/** Only the authoritative create preflight may certify this exact no-write denial. */
export class MissionCreateNoEffectError extends MissionControlError {
  readonly noEffect: { requestID: string; missionID: string }

  constructor(requestID: string, missionID: string, code: "mission-limit" | "request-conflict" = "mission-limit") {
    super(code === "mission-limit" ? "Project mission limit reached" : "Creation request ID was already used with a different mission", code)
    this.noEffect = { requestID, missionID }
  }
}
