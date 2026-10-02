export class MissionControlError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
    this.name = "MissionControlError"
  }
}
