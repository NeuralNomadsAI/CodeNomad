import type { MissionMap } from "../../../server/src/api-types"
import { authenticatedFetch } from "./auth-recovery"
import { HttpResponseError } from "./retryable-file-search"

const codes = ["creation-uncertain", "creation-conflict", "creation-capacity", "creation-unavailable", "creation-worktree-deleting",
  "mission-limit", "revision-conflict", "request-conflict"] as const
type MissionMutationCode = typeof codes[number]
type Operation = "create" | "edit"
// The route forwards a native mission-limit only with its exact no-effect receipt.
const createOnly = (code: MissionMutationCode) => code.startsWith("creation-") || code === "mission-limit"

export function missionMutationCode(body: unknown, operation: Operation): MissionMutationCode | undefined {
  if (!body || typeof body !== "object" || !("code" in body)) return undefined
  return codes.find(code => body.code === code && (operation === "create" || !createOnly(code)))
}

export class MissionMutationError extends HttpResponseError {
  constructor(status: number, readonly operation: Operation, readonly code?: MissionMutationCode) {
    super("Mission change was not confirmed", status, null)
  }
}

// Only reviewed redacted codes cross this seam. Never display or log arbitrary
// upstream error text, and never replay an already dispatched mutation.
export async function missionMutationRequest(url: string, method: "POST" | "PATCH", input: object): Promise<{ mission: MissionMap }> {
  const response = await authenticatedFetch(url, { method, credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) })
  if (!response.ok) {
    const operation = method === "POST" ? "create" : "edit"
    const body: unknown = await response.json().catch(() => undefined)
    throw new MissionMutationError(response.status, operation, missionMutationCode(body, operation))
  }
  const body: unknown = await response.json()
  const mission = body && typeof body === "object" && "mission" in body ? body.mission : undefined
  if (!mission || typeof mission !== "object" || typeof (mission as { id?: unknown }).id !== "string") {
    throw new TypeError("Mission change acknowledgement is unreadable")
  }
  return body as { mission: MissionMap }
}

export function isUncertainCreation(error: unknown): boolean {
  return error instanceof MissionMutationError && error.operation === "create" && error.status === 409 && error.code === "creation-uncertain"
}

// The route answers every dispatched-but-unproven create with `creation-uncertain`;
// only another received, reviewed rejection proves no effect. Refusals before the
// native create was attempted carry `creation-unavailable` or
// `creation-worktree-deleting`. Transport loss, an undecodable acknowledgement and
// codeless statuses (including proxy 5xx and post-dispatch failures) may follow a
// committed native write and must keep the original request held.
export function isDefinitiveCreationRejection(error: unknown): boolean {
  if (!(error instanceof MissionMutationError) || error.operation !== "create") return false
  if (error.code) return error.code !== "creation-uncertain"
  return [400, 401, 403, 404].includes(error.status)
}

export function missionMutationErrorKey(error: unknown): string {
  if (error instanceof MissionMutationError) {
    if (isUncertainCreation(error)) return "missions.control.creation.uncertain"
    if (error.status === 409 && error.code === "creation-conflict") return "missions.control.creation.scopeConflict"
    if (error.status === 503 && error.code === "creation-capacity") return "missions.control.creation.capacity"
    if (error.status === 503 && error.code === "creation-unavailable") return "missions.control.creation.unavailable"
    if (error.status === 409 && error.code === "creation-worktree-deleting") return "missions.control.creation.worktreeDeleting"
    if (error.status === 409 && error.code === "mission-limit") return "missions.control.creation.limit"
    if (error.status === 409 && error.code === "revision-conflict") return "missions.control.mutation.conflict"
    if (error.status === 409 && error.code === "request-conflict") return "missions.control.mutation.requestConflict"
    if (error.status === 403) return "missions.control.mutation.forbidden"
  }
  return "missions.control.mutation.error"
}
