import type { BackendId } from "./backend-transport"

export const LOCAL_BACKEND_ID: BackendId = "local"

/** Joins a backend id to an id or folder of that backend. Never `:`, which instance-keyed maps split on. */
export const BACKEND_SCOPE_SEPARATOR = "~"

const BACKEND_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

export function isBackendId(value: unknown): value is BackendId {
  return typeof value === "string" && BACKEND_ID_PATTERN.test(value)
}

const isLocal = (backendId: BackendId | undefined) => backendId === undefined || backendId === LOCAL_BACKEND_ID

/** The backend of an instance or saved tab; absent means local. */
export function backendIdOf(value: { backendId?: BackendId }): BackendId {
  return value.backendId ?? LOCAL_BACKEND_ID
}

/** `value` for the local backend, `${backendId}~${value}` for another one. */
export function backendScoped(backendId: BackendId | undefined, value: string): string {
  if (isLocal(backendId)) return value
  if (!isBackendId(backendId)) throw new Error(`Invalid backend id: ${backendId}`)
  return `${backendId}${BACKEND_SCOPE_SEPARATOR}${value}`
}

/** The UI-wide instance id of a backend's workspace: the workspace id itself for the local backend. */
export function instanceKey(backendId: BackendId, workspaceId: string): string {
  return backendScoped(backendId, workspaceId)
}

/** Reverses `instanceKey`. Local workspace ids never start with a backend id followed by `~`. */
export function parseInstanceKey(key: string): { backendId: BackendId; workspaceId: string } {
  const separator = key.indexOf(BACKEND_SCOPE_SEPARATOR)
  const backendId = separator > 0 ? key.slice(0, separator) : undefined
  if (backendId && backendId !== LOCAL_BACKEND_ID && isBackendId(backendId)) {
    return { backendId, workspaceId: key.slice(separator + 1) }
  }
  return { backendId: LOCAL_BACKEND_ID, workspaceId: key }
}

/** One project of one backend: the key of its per-project view state (Missions, previews). */
export function projectScope(project: { folder: string; backendId?: BackendId }): string {
  return backendScoped(project.backendId, project.folder)
}
