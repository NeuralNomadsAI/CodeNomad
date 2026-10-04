import type { MissionCleanup } from "../../../server/src/missions/model"
import { authenticatedFetch } from "./auth-recovery"
import { HttpResponseError } from "./retryable-file-search"

export interface MissionDeletionRequest { expectedRevision: number; requestId: string; deleteManagedSessions?: boolean }
const codes = ["cleanup-pending", "control-pending", "revision-conflict", "request-conflict", "mission-not-found", "foreign-session", "child-session", "invalid-delete-option"]
export class MissionDeletionError extends HttpResponseError {
  constructor(status: number, readonly code?: string) { super("Mission deletion was not confirmed", status, null) }
}

export async function deleteMissionRequest(url: string, input: MissionDeletionRequest): Promise<{ deleted: true; cleanup?: MissionCleanup }> {
  const response = await authenticatedFetch(url, { method: "DELETE", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) })
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => undefined)
    const code = body && typeof body === "object" && "code" in body && typeof body.code === "string" && codes.includes(body.code) ? body.code : undefined
    throw new MissionDeletionError(response.status, code)
  }
  return await response.json()
}

export function deletionErrorKey(error: unknown): string {
  if (error instanceof MissionDeletionError) {
    if (error.status === 503 && error.code === "cleanup-pending") return "missions.cleanup.error.pending"
    if (error.status === 409) return "missions.control.mutation.conflict"
    if (error.status === 403) return "missions.cleanup.error.forbidden"
    if (error.status === 404) return "missions.cleanup.error.missing"
  }
  return "missions.cleanup.error.unconfirmed"
}
