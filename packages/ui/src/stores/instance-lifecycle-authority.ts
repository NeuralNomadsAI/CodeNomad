export interface InstanceLifecycleAuthorityEvent {
  type: "removed" | "opened"
  instanceId: string
  folder: string
  occurrence: number
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
