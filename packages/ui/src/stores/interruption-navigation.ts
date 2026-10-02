import { createSignal } from "solid-js"

// UI intents only. Native pending queues and tool results remain authoritative.
export const [interruptionFocus, setInterruptionFocus] = createSignal<{
  instanceId: string; sessionId?: string; requestId?: string
}>()
export function focusInterruption(instanceId: string, sessionId?: string, requestId?: string) {
  setInterruptionFocus({ instanceId, sessionId, requestId })
}

export const [interruptionReveal, setInterruptionReveal] = createSignal<{
  instanceId: string; sessionId: string; messageId: string; callId?: string
}>()
