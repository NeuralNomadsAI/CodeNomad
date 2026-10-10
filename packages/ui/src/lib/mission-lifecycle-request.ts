import type { MissionMap } from "../../../server/src/api-types"
import { authenticatedFetch } from "./auth-recovery"
import { HttpResponseError } from "./retryable-file-search"

export type MissionLifecycleInput = { action: "start" | "pause" | "stop"; expectedRevision: number; requestId: string }
const codes = ["revision-conflict", "request-conflict", "control-conflict", "control-pending"] as const
type LifecycleCode = typeof codes[number]

export class MissionLifecycleRequestError extends HttpResponseError {
  constructor(status: number, readonly code?: LifecycleCode) {
    super("Mission control was not confirmed", status, null)
  }
}

// Lifecycle checks the revision only when no event exists for this request ID,
// before appending mission.control-requested. Neither another 409 code nor a
// missing/lost acknowledgement proves non-admission.
export function isRejectedLifecycleIntent(error: unknown): boolean {
  return error instanceof MissionLifecycleRequestError && error.status === 409 && error.code === "revision-conflict"
}

export async function missionLifecycleRequest(url: string, input: MissionLifecycleInput): Promise<{ mission: MissionMap }> {
  const response = await authenticatedFetch(url, { method: "POST", credentials: "include",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) })
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => undefined)
    const code = body && typeof body === "object" && "code" in body ? codes.find(code => body.code === code) : undefined
    throw new MissionLifecycleRequestError(response.status, code)
  }
  return await response.json()
}
