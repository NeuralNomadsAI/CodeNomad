import { createSignal } from "solid-js"

// UI intents only. Native pending queues and tool results remain authoritative.
export const [interruptionFocus, setInterruptionFocus] = createSignal<{
  instanceId: string; sessionId?: string; requestId?: string; kind?: "permission" | "form"
}>()
export function focusInterruption(instanceId: string, sessionId?: string, requestId?: string, kind?: "permission" | "form") {
  setInterruptionFocus({ instanceId, sessionId, requestId, kind })
}
