import type { BackendId } from "../lib/backend-transport"

export interface InstanceLifecycleAuthorityEvent {
  type: "removed" | "opened" | "unavailable"
  instanceId: string
  folder: string
  /** Occurrence among the open instances of the same folder on the same backend. */
  occurrence: number
  /** Absent for the local backend. */
  backendId?: BackendId
}

const listeners = new Set<(event: InstanceLifecycleAuthorityEvent) => void>()

export function onInstanceLifecycleAuthority(
  listener: (event: InstanceLifecycleAuthorityEvent) => void,
): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function publishInstanceLifecycleAuthority(event: InstanceLifecycleAuthorityEvent): void {
  for (const listener of listeners) listener(event)
}
