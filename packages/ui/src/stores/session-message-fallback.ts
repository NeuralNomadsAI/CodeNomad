import { OpencodeApiError } from "../lib/opencode-api"

export function isLegacyMissingAgentValidationError(error: unknown): boolean {
  if (!(error instanceof OpencodeApiError)) {
    return false
  }

  const cause = (error as any).cause
  const causeName = cause && typeof cause === "object" ? (cause as any).name : undefined
  const causeData = cause && typeof cause === "object" ? (cause as any).data : undefined
  const message = typeof causeData?.message === "string" ? causeData.message : ""
  return causeName === "BadRequest" && causeData?.kind === "Body" && /\["info"\]\["agent"\]/.test(message)
}
