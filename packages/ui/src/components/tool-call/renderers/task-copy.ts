import { createEffect, createSignal, onCleanup } from "solid-js"
import type { ClipboardCopyOptions } from "../../../lib/clipboard"
import { loadCompleteMessageHistory, MESSAGE_HISTORY_TRAVERSAL_PAGE_LIMIT } from "../../message-history-pagination"

interface TaskStepCopyOptions {
  childSessionId: () => string
  isActive: () => boolean
  beginTraversal: (sessionId: string) => () => void
  getPageKey: (sessionId: string) => string
  isLatest: (sessionId: string) => boolean
  loadOldest: (sessionId: string, signal: AbortSignal) => Promise<boolean>
  loadNewer: (sessionId: string, signal: AbortSignal) => Promise<boolean>
  readSteps: (sessionId: string) => unknown[]
  copy: (chunks: readonly string[], options: ClipboardCopyOptions) => Promise<unknown>
}

/** One explicit full-copy lifetime, independent of the bounded rendered step list. */
export function useTaskStepCopy(options: TaskStepCopyOptions) {
  const [pending, setPending] = createSignal(false)
  const visibilityDocument = typeof document === "undefined" ? undefined : document
  type Operation = { id: string; controller: AbortController; release?: () => void; promise?: Promise<void> }
  let current: Operation | undefined
  let disposed = false
  const isActive = () => options.isActive() && visibilityDocument?.visibilityState !== "hidden"

  function release(operation: Operation) {
    const done = operation.release
    operation.release = undefined
    done?.()
  }

  function cancel() {
    const operation = current
    if (!operation) return
    current = undefined
    setPending(false)
    // Release synchronously: a returning view can acquire a new traversal even
    // when the cancelled loader has not settled. Its finally cannot release it.
    operation.controller.abort()
    release(operation)
  }

  createEffect(() => {
    const id = options.childSessionId()
    const active = options.isActive()
    if (current && (!active || current.id !== id)) cancel()
  })
  const onVisibilityChange = () => { if (!isActive()) cancel() }
  visibilityDocument?.addEventListener("visibilitychange", onVisibilityChange)
  onCleanup(() => {
    disposed = true
    visibilityDocument?.removeEventListener("visibilitychange", onVisibilityChange)
    cancel()
  })

  function copy(): Promise<void> {
    if (disposed || !isActive()) return Promise.resolve()
    const id = options.childSessionId()
    if (!id) return Promise.resolve()
    if (current?.id === id) return current.promise ?? Promise.resolve()
    cancel()
    const operation: Operation = { id, controller: new AbortController() }
    current = operation
    setPending(true)
    const signal = operation.controller.signal
    const isCurrent = () => !disposed && current === operation && !signal.aborted
      && isActive() && options.childSessionId() === id
    const loadPage = async (load: TaskStepCopyOptions["loadOldest"]) => {
      // A superseded native read can resolve without committing a page while
      // this view stays active. Never mistake the resident tail for that page.
      if (!await load(id, signal)) throw new Error("Task step copy page was not committed")
    }

    operation.promise = (async () => {
      try {
        operation.release = options.beginTraversal(id)
        const steps = await loadCompleteMessageHistory({
          getPageKey: () => options.getPageKey(id),
          isCurrent,
          isLatest: () => options.isLatest(id),
          loadOldest: () => loadPage(options.loadOldest),
          loadNewer: () => loadPage(options.loadNewer),
          visit: () => options.readSteps(id).map(step => JSON.stringify(step, null, 2)),
          // Bound network work, never truncate copied steps/strings to a render
          // budget. Retain serialized output across evicted pages until copying;
          // exhausting the operation budget fails without copying partial data.
          maxPages: MESSAGE_HISTORY_TRAVERSAL_PAGE_LIMIT,
        })
        if (!steps || !isCurrent()) return
        const chunks = ["[\n"]
        steps.forEach((step, index) => chunks.push(index === 0 ? step : `,\n${step}`))
        chunks.push("\n]")
        if (isCurrent()) await options.copy(chunks, { isCurrent, signal })
      } catch (error) {
        if (isCurrent()) throw error
      } finally {
        release(operation)
        if (current === operation) {
          current = undefined
          setPending(false)
        }
      }
    })()
    return operation.promise
  }

  return { copy, pending }
}
