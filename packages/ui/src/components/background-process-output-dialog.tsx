import { Dialog } from "@kobalte/core/dialog"
import { Show, createEffect, createSignal, onCleanup } from "solid-js"
import type { BackgroundProcess } from "../../../server/src/api-types"
import { buildBackgroundProcessStreamUrl, serverApi } from "../lib/api-client"
import { createAnsiStreamRenderer, hasAnsi } from "../lib/ansi"

interface BackgroundProcessOutputDialogProps {
  open: boolean
  instanceId: string
  process: BackgroundProcess | null
  onClose: () => void
}

export function BackgroundProcessOutputDialog(props: BackgroundProcessOutputDialogProps) {
  const [output, setOutput] = createSignal("")
  const [outputHtml, setOutputHtml] = createSignal("")
  const [ansiEnabled, setAnsiEnabled] = createSignal(false)
  const [truncated, setTruncated] = createSignal(false)
  const [loading, setLoading] = createSignal(false)
  let ansiRenderer = createAnsiStreamRenderer()

  createEffect(() => {
    const process = props.process
    if (!props.open || !process) {
      return
    }

    let eventSource: EventSource | null = null
    let active = true

    let rawOutput = ""

    const setRawOutput = (next: string) => {
      rawOutput = next
      setOutput(next)
    }

    const appendRawOutput = (chunk: string) => {
      rawOutput += chunk
      setOutput(rawOutput)
    }

    setAnsiEnabled(false)
    setOutputHtml("")
    setRawOutput("")
    ansiRenderer.reset()

    setLoading(true)
    serverApi
      .fetchBackgroundProcessOutput(props.instanceId, process.id, { method: "full", maxBytes: undefined })
      .then((response) => {
        if (!active) return

        setRawOutput(response.content)
        setTruncated(response.truncated)

        const detectedAnsi = hasAnsi(response.content)
        if (detectedAnsi) {
          setAnsiEnabled(true)
          ansiRenderer.reset()
          setOutputHtml(ansiRenderer.render(response.content))
        } else {
          setAnsiEnabled(false)
          setOutputHtml("")
          ansiRenderer.reset()
        }
      })
      .catch(() => {
        if (!active) return
        setRawOutput("Failed to load output.")
        setAnsiEnabled(false)
        setOutputHtml("")
      })
      .finally(() => {
        if (!active) return
        setLoading(false)
      })

    eventSource = new EventSource(buildBackgroundProcessStreamUrl(props.instanceId, process.id), { withCredentials: true } as any)
    eventSource.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as { type?: string; content?: string }
        if (payload?.type !== "chunk" || typeof payload.content !== "string") {
          return
        }

        const chunk = payload.content
        const wasAnsiEnabled = ansiEnabled()

        if (!wasAnsiEnabled) {
          appendRawOutput(chunk)

          if (hasAnsi(chunk)) {
            setAnsiEnabled(true)
            ansiRenderer.reset()
            setOutputHtml(ansiRenderer.render(rawOutput))
          }

          return
        }

        appendRawOutput(chunk)
        const htmlChunk = ansiRenderer.render(chunk)
        setOutputHtml((prev) => `${prev}${htmlChunk}`)
      } catch {
        // ignore parse errors
      }
    }

    onCleanup(() => {
      active = false
      eventSource?.close()
    })
  })

  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && props.onClose()} modal>
      <Dialog.Portal>
        <Dialog.Overlay class="modal-overlay" />
        <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
          <Dialog.Content class="modal-surface w-full max-w-5xl max-h-[90vh] flex flex-col overflow-hidden">
            <div class="flex items-start justify-between px-6 py-4 border-b border-base gap-4">
              <div class="flex-1 min-w-0">
                <Dialog.Title class="text-lg font-semibold text-primary">Background Output</Dialog.Title>
                <Show when={props.process}>
                  <span class="text-xs text-secondary block">
                    {props.process?.title} · {props.process?.id}
                  </span>
                  <span class="text-xs text-secondary mt-1 block truncate" title={props.process?.command}>
                    {props.process?.command}
                  </span>
                </Show>
              </div>

              <button type="button" class="button-tertiary flex-shrink-0" onClick={props.onClose}>
                Close
              </button>
            </div>
            <div class="flex-1 overflow-auto p-6">
              <Show when={loading()}>
                <p class="text-xs text-secondary">Loading output...</p>
              </Show>
              <Show when={!loading()}>
                <Show when={truncated()}>
                  <p class="text-xs text-secondary mb-2">Output truncated for display.</p>
                </Show>
                <Show
                  when={ansiEnabled()}
                  fallback={
                    <pre class="text-xs whitespace-pre-wrap break-all text-primary bg-surface-secondary border border-base rounded-md p-4 font-mono">
                      {output()}
                    </pre>
                  }
                >
                  <pre
                    class="text-xs whitespace-pre-wrap break-all text-primary bg-surface-secondary border border-base rounded-md p-4 font-mono"
                    innerHTML={outputHtml()}
                  />
                </Show>
              </Show>
            </div>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog>
  )
}
