import { createEffect, createSignal, on, onCleanup, type Accessor } from "solid-js"
import { useI18n } from "../../lib/i18n"
import { getOpencodeErrorMessage } from "../../lib/opencode-api"
import { getRootClient } from "../../stores/opencode-client"
import { captureInstanceRequestAuthority } from "../../stores/session-api"
import { instances } from "../../stores/instances"
import { requestConnectionOptions } from "../../stores/request-locations"
import { isSessionActionInterrupted } from "../../stores/session-action-queue"

// Match OpenCode's native /btw instructions. session.generate performs a single
// generation with session context; it does not run a tool loop or append messages.
const instructions = [
  "The user is asking a quick side question about the conversation so far.",
  "Answer directly and concisely in markdown from what you already know.",
  "Do not call any tools and do not take any actions.",
].join(" ")

export function usePromptAside(options: {
  instanceId: Accessor<string>
  sessionId: Accessor<string>
  active: Accessor<boolean>
}) {
  const { t } = useI18n()
  const [open, setOpen] = createSignal(false)
  const [question, setQuestion] = createSignal("")
  const [answer, setAnswer] = createSignal("")
  const [error, setError] = createSignal("")
  const [pending, setPending] = createSignal(false)
  const [interrupted, setInterrupted] = createSignal(false)
  let request: AbortController | undefined

  function cancel() {
    const previous = request
    request = undefined
    previous?.abort()
    setPending(false)
  }

  function close() {
    cancel()
    setOpen(false)
  }

  createEffect(on(
    [options.instanceId, options.sessionId, options.active],
    () => {
      close()
      setQuestion("")
      setAnswer("")
      setError("")
      setInterrupted(false)
    },
  ))
  onCleanup(cancel)

  async function ask() {
    const text = question().trim()
    if (!text || pending() || !options.active()) return
    const controller = new AbortController()
    const instanceId = options.instanceId()
    const sessionId = options.sessionId()
    const authority = captureInstanceRequestAuthority(instanceId)
    const client = getRootClient(instanceId)
    const requestOptions = requestConnectionOptions(instances().get(instanceId))
    request = controller
    const ownsRequest = () => request === controller
    const current = () => authority() && ownsRequest() && !controller.signal.aborted
      && options.active() && options.instanceId() === instanceId && options.sessionId() === sessionId
    setPending(true)
    setAnswer("")
    setError("")
    setInterrupted(false)
    try {
      if (!current()) return
      const result = await client.session.generate({
        sessionID: sessionId,
        prompt: `${instructions}\n\n${text}`,
      }, { ...requestOptions, signal: controller.signal })
      if (!current()) return
      const textAnswer = result.text.trim()
      if (!textAnswer) setError(t("promptInput.btw.empty"))
      else setAnswer(textAnswer)
    } catch (cause) {
      if (current()) {
        if (isSessionActionInterrupted(cause)) setInterrupted(true)
        else setError(getOpencodeErrorMessage(cause, t("promptInput.btw.failed")))
      }
    } finally {
      if (ownsRequest()) {
        if (!current()) setInterrupted(true)
        request = undefined
        setPending(false)
      }
    }
  }

  // Return false when a second question cannot be accepted yet, so the composer
  // keeps its draft. Bare /btw reopens the window without another model request.
  function launch(text: string): boolean {
    if (!options.active()) return false
    setOpen(true)
    if (!text.trim()) return true
    if (pending()) return false
    setQuestion(text.trim())
    void ask()
    return true
  }

  return { open, question, setQuestion, answer, error, pending, interrupted, launch, ask, cancel, close }
}

export type PromptAsideController = ReturnType<typeof usePromptAside>
