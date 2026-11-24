import { createSignal } from "solid-js"

// One-shot requests to focus a session's composer once its view is active,
// for host actions that navigate to a conversation (or stay on it) and hand
// the keyboard to the composer. The session view consumes its own request.
const [requests, setRequests] = createSignal<ReadonlySet<string>>(new Set())
const key = (instanceId: string, sessionId: string) => `${instanceId}\0${sessionId}`

export function requestComposerFocus(instanceId: string, sessionId: string): void {
  setRequests(previous => new Set(previous).add(key(instanceId, sessionId)))
}

export function composerFocusRequested(instanceId: string, sessionId: string): boolean {
  return requests().has(key(instanceId, sessionId))
}

export function clearComposerFocusRequest(instanceId: string, sessionId: string): void {
  if (!requests().has(key(instanceId, sessionId))) return
  setRequests(previous => {
    const next = new Set(previous)
    next.delete(key(instanceId, sessionId))
    return next
  })
}
