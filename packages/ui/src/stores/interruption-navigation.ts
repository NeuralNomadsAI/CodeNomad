import { createSignal } from "solid-js"

// UI intents only. Native pending queues and tool results remain authoritative.
export const [interruptionFocus, setInterruptionFocus] = createSignal<{
  instanceId: string; sessionId?: string; requestId?: string; kind?: "form" | "permission"
}>()
export function focusInterruption(instanceId: string, sessionId?: string, requestId?: string, kind?: "form" | "permission") {
  setInterruptionFocus({ instanceId, sessionId, requestId, kind })
}
