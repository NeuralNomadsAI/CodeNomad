import type { MissionMap } from "../../../server/src/api-types"
import { authenticatedFetch } from "./auth-recovery"
import { HttpResponseError } from "./retryable-file-search"

const codes = ["creation-uncertain", "creation-conflict", "creation-capacity", "revision-conflict", "request-conflict"] as const
type MissionMutationCode = typeof codes[number]
type Operation = "create" | "edit"

export function missionMutationCode(body: unknown, operation: Operation): MissionMutationCode | undefined {
  if (!body || typeof body !== "object" || !("code" in body)) return undefined
  return codes.find(code => body.code === code && (operation === "create" || !code.startsWith("creation-")))
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
  return await response.json()
}

export function isUncertainCreation(error: unknown): boolean {
  return error instanceof MissionMutationError && error.operation === "create" && error.status === 409 && error.code === "creation-uncertain"
}

export function missionMutationErrorKey(error: unknown): string {
  if (error instanceof MissionMutationError) {
    if (isUncertainCreation(error)) return "missions.control.creation.uncertain"
    if (error.status === 409 && error.code === "creation-conflict") return "missions.control.creation.scopeConflict"
    if (error.status === 503 && error.code === "creation-capacity") return "missions.control.creation.capacity"
    if (error.status === 409 && error.code === "revision-conflict") return "missions.control.mutation.conflict"
    if (error.status === 409 && error.code === "request-conflict") return "missions.control.mutation.requestConflict"
    if (error.status === 403) return "missions.control.mutation.forbidden"
  }
  return "missions.control.mutation.error"
}
