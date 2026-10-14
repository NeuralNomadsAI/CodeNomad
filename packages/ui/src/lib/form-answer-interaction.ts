import type { FormAnswer, FormInfo } from "@opencode/client"

export interface FormAnswerInteraction { readonly kind: "dock-input" }
const interactions = new WeakMap<FormAnswerInteraction, { form: string; answer: string }>()
const identity = (form: FormInfo) => JSON.stringify([form.id, form.sessionID, form.metadata, form.fields])

/** Originating dock input, not SubmitEvent.isTrusted (requestSubmit() sets that
 * too). This is first-party origin correlation, not physical-person attestation. */
export function createFormAnswerInteraction(form: () => FormInfo, answer: () => FormAnswer) {
  let pending: FormAnswerInteraction | undefined
  const capture = (event: MouseEvent | KeyboardEvent) => {
    pending = undefined
    if (!event.isTrusted || (globalThis as typeof globalThis & { __codenomadAutomationDepth?: number }).__codenomadAutomationDepth) return
    const element = event.target
    if (!(element instanceof HTMLElement)) return
    const owner = event.currentTarget
    if (!(owner instanceof HTMLFormElement) || !owner.contains(element)) return
    if (event instanceof KeyboardEvent) {
      if (event.isComposing || event.repeat || event.altKey || event.ctrlKey || event.metaKey
        || !(event.key === "Enter" && !(element instanceof HTMLTextAreaElement)
          || event.key === " " && element.closest('button[type="submit"]'))) return
    } else if (!element.closest('button[type="submit"]') || event.button !== 0) return
    const token = Object.freeze({ kind: "dock-input" as const })
    interactions.set(token, { form: identity(form()), answer: JSON.stringify(answer()) })
    pending = token
    // A later script requestSubmit cannot borrow an earlier click/keypress.
    setTimeout(() => { if (pending === token) { pending = undefined; interactions.delete(token) } }, 0)
  }
  return {
    attach(element: HTMLFormElement) {
      element.addEventListener("click", capture, true)
      element.addEventListener("keydown", capture, true)
      return () => {
        element.removeEventListener("click", capture, true)
        element.removeEventListener("keydown", capture, true)
        if (pending) interactions.delete(pending)
        pending = undefined
      }
    },
    take() { const token = pending; pending = undefined; return token },
  }
}

/** One-use, exact request/schema/answer match at the actual SDK send boundary. */
export function consumeFormAnswerInteraction(token: FormAnswerInteraction | undefined, form: FormInfo, answer: FormAnswer): boolean {
  if (!token || (globalThis as typeof globalThis & { __codenomadAutomationDepth?: number }).__codenomadAutomationDepth) return false
  const captured = interactions.get(token)
  interactions.delete(token)
  return captured?.form === identity(form) && captured.answer === JSON.stringify(answer)
}
