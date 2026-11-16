export interface InstanceLifecycleAuthorityEvent {
  type: "removed" | "opened" | "unavailable"
  instanceId: string
  folder: string
  occurrence: number
}

const listeners = new Set<(event: InstanceLifecycleAuthorityEvent) => void>()
const openOccurrences = new Set<string>()

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
  if (event.type !== "opened") openOccurrences.delete(event.instanceId)
  for (const listener of listeners) listener(event)
}
