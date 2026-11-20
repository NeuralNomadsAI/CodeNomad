import { createSignal } from "solid-js"
import type { SessionSearchMatch } from "../lib/session-search"
import { supportsWorkspaceCapability } from "./workspace-capabilities"

const [target, setTarget] = createSignal<{ instanceId: string; sessionId: string } | null>(null)
const [destination, setDestination] = createSignal<{ instanceId: string; sessionId: string; query: string; match: SessionSearchMatch }>()

export function sessionSearchDestination(instanceId: string, sessionId: string) {
  const value = destination()
  return value?.instanceId === instanceId && value.sessionId === sessionId ? value : undefined
}
export function setSessionSearchDestination(instanceId: string, sessionId: string, query: string, match: SessionSearchMatch) {
  setDestination({ instanceId, sessionId, query, match })
}
export function clearSessionSearchDestination(instanceId: string, sessionId: string) {
  if (sessionSearchDestination(instanceId, sessionId)) setDestination(undefined)
}

export const sessionSearchWindowId = (instanceId: string, sessionId: string) => `session-search-${instanceId}-${sessionId}`

export function isSessionSearchOpen(instanceId: string, sessionId: string): boolean {
  return target()?.instanceId === instanceId && target()?.sessionId === sessionId
}

/** Session search reads the backend's history routes. */
export const sessionSearchSupported = (instanceId: string) => supportsWorkspaceCapability(instanceId, "history-search")

export function setSessionSearchOpen(instanceId: string, sessionId: string, open: boolean): void {
  if (open) { if (sessionSearchSupported(instanceId)) setTarget({ instanceId, sessionId }) }
  else if (isSessionSearchOpen(instanceId, sessionId)) setTarget(null)
}
