import { createSignal } from "solid-js"

const [target, setTarget] = createSignal<{ instanceId: string; sessionId: string } | null>(null)

export const sessionSearchWindowId = (instanceId: string, sessionId: string) => `session-search-${instanceId}-${sessionId}`

export function isSessionSearchOpen(instanceId: string, sessionId: string): boolean {
  return target()?.instanceId === instanceId && target()?.sessionId === sessionId
}

export function setSessionSearchOpen(instanceId: string, sessionId: string, open: boolean): void {
  if (open) setTarget({ instanceId, sessionId })
  else if (isSessionSearchOpen(instanceId, sessionId)) setTarget(null)
}
