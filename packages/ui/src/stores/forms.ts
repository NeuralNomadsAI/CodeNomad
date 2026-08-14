import { createSignal } from "solid-js"
import type { FormAnswer, FormInfo } from "@opencode-ai/client"

const [formQueues, setFormQueues] = createSignal<Map<string, FormInfo[]>>(new Map())

export function getFormQueue(instanceId: string): FormInfo[] {
  return formQueues().get(instanceId) ?? []
}

export function addFormToQueue(instanceId: string, form: FormInfo): void {
  setFormQueues((previous) => {
    const next = new Map(previous)
    const queue = next.get(instanceId) ?? []
    const index = queue.findIndex((item) => item.id === form.id)
    const updated = queue.slice()
    if (index === -1) updated.push(form)
    else updated[index] = form
    next.set(instanceId, updated)
    return next
  })
}

export function removeFormFromQueue(instanceId: string, formId: string): void {
  setFormQueues((previous) => {
    const next = new Map(previous)
    const queue = (next.get(instanceId) ?? []).filter((form) => form.id !== formId)
    if (queue.length) next.set(instanceId, queue)
    else next.delete(instanceId)
    return next
  })
}

export function replaceFormQueue(instanceId: string, forms: readonly FormInfo[]): void {
  setFormQueues((previous) => {
    const next = new Map(previous)
    if (forms.length) next.set(instanceId, [...forms])
    else next.delete(instanceId)
    return next
  })
}

export function clearFormQueue(instanceId: string): void {
  replaceFormQueue(instanceId, [])
}

export type { FormAnswer, FormInfo }
