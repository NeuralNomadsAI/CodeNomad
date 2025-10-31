import { createSignal } from "solid-js"

function getSessionKey(instanceId: string, sessionId: string): string {
  return `${instanceId}:${sessionId}`
}

const [prompts, setPrompts] = createSignal<Map<string, string>>(new Map())

export function getPromptValue(instanceId: string, sessionId: string): string {
  const key = getSessionKey(instanceId, sessionId)
  return prompts().get(key) || ""
}

export function setPromptValue(instanceId: string, sessionId: string, value: string) {
  const key = getSessionKey(instanceId, sessionId)
  setPrompts((prev) => {
    const next = new Map(prev)
    if (value.length === 0) {
      next.delete(key)
    } else {
      next.set(key, value)
    }
    return next
  })
}

export function clearPromptValue(instanceId: string, sessionId: string) {
  const key = getSessionKey(instanceId, sessionId)
  setPrompts((prev) => {
    const next = new Map(prev)
    next.delete(key)
    return next
  })
}
