export class MissionControlError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
    this.name = "MissionControlError"
  }
}

/** Only the authoritative create preflight may certify this exact no-write denial. */
export class MissionCreateNoEffectError extends MissionControlError {
  readonly noEffect: { requestID: string; missionID: string }

  constructor(requestID: string, missionID: string, code: "mission-limit" | "request-conflict" = "mission-limit") {
    super(code === "mission-limit" ? "Project mission limit reached" : "Creation request ID was already used with a different mission", code)
    this.noEffect = { requestID, missionID }
  }
}
