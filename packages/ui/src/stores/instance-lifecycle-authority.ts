import type { BackendId } from "../lib/backend-transport"

export interface InstanceLifecycleAuthorityEvent {
  type: "removed" | "opened" | "unavailable"
  instanceId: string
  folder: string
  /** Occurrence among the open instances of the same folder on the same backend. */
  occurrence: number
  /** Absent for the local backend. */
  backendId?: BackendId
  serverId?: string
  windowRelease?: true
}

const listeners = new Set<(event: InstanceLifecycleAuthorityEvent) => void>()
const openOccurrences = new Set<string>()
const reusedOccurrences = new Set<string>()

export const markInstanceOccurrenceReused = (id: string) => reusedOccurrences.add(id)
export const isInstanceOccurrenceReused = (id: string) => reusedOccurrences.has(id)

export function isInstanceOccurrenceOpen(instanceId: string): boolean {
  return openOccurrences.has(instanceId)
}

export function onInstanceLifecycleAuthority(
  listener: (event: InstanceLifecycleAuthorityEvent) => void,
): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function publishInstanceLifecycleAuthority(event: InstanceLifecycleAuthorityEvent): void {
  if (event.type === "opened") openOccurrences.add(event.instanceId)
  if (event.type !== "opened") {
    openOccurrences.delete(event.instanceId)
    reusedOccurrences.delete(event.instanceId)
  }
  for (const listener of listeners) listener(event)
}
