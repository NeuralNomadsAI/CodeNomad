import { Dialog } from "@kobalte/core/dialog"
import { Show, createEffect, createSignal, onCleanup } from "solid-js"
import type { ShellInfo } from "@opencode-ai/client"

import { createAnsiStreamRenderer, hasAnsi } from "../lib/ansi"
import { useI18n } from "../lib/i18n"
import { appendShellOutput } from "../stores/shell-store"
import { shellStore } from "../stores/shells"

interface ShellOutputDialogProps {
  open: boolean
  instanceId: string
  directory: string
  shell: ShellInfo | null
  onClose: () => void
}

export function ShellOutputDialog(props: ShellOutputDialogProps) {
  const { t } = useI18n()
  const [output, setOutput] = createSignal("")
  const [outputHtml, setOutputHtml] = createSignal("")
  const [ansiEnabled, setAnsiEnabled] = createSignal(false)
  const [truncated, setTruncated] = createSignal(false)
  const [loading, setLoading] = createSignal(false)

  createEffect(() => {
    const shell = props.shell
    const directory = props.directory
    if (!props.open || !shell || !directory) return

    let active = true
    let cursor = 0
    let raw = ""
    let timer: ReturnType<typeof setTimeout> | undefined
    const render = () => {
      const ansi = hasAnsi(raw)
      setAnsiEnabled(ansi)
      if (!ansi) return setOutputHtml("")
      const renderer = createAnsiStreamRenderer()
      setOutputHtml(renderer.render(raw))
    }
    const poll = async () => {
      try {
        const result = await shellStore.output(props.instanceId, directory, shell.id, cursor)
        if (!active) return
        cursor = result.cursor
        if (result.output) {
          const next = appendShellOutput(raw, result.output)
          raw = next.output
          setOutput(raw)
          setTruncated((current) => current || result.truncated || next.truncated)
          render()
        } else if (result.truncated) {
          setTruncated(true)
        }
      } catch {
        if (!active) return
        setOutput(t("backgroundProcessOutputDialog.loadErrorFallback"))
      } finally {
        if (!active) return
        setLoading(false)
        timer = setTimeout(poll, 1000)
      }
    }

    setOutput("")
    setOutputHtml("")
    setAnsiEnabled(false)
    setTruncated(false)
    setLoading(true)
    void poll()
    onCleanup(() => {
      active = false
      if (timer) clearTimeout(timer)
    })
  })

  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && props.onClose()} modal>
      <Dialog.Portal>
        <Dialog.Overlay class="modal-overlay" />
        <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
          <Dialog.Content class="modal-surface flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden">
            <div class="flex items-start justify-between gap-4 border-b border-base px-6 py-4">
              <div class="min-w-0 flex-1">
                <Dialog.Title class="text-lg font-semibold text-primary">{t("backgroundProcessOutputDialog.title")}</Dialog.Title>
                <span class="block truncate text-xs text-secondary" title={props.shell?.command}>{props.shell?.command}</span>
              </div>
              <button type="button" class="button-tertiary shrink-0" onClick={props.onClose}>
                {t("backgroundProcessOutputDialog.actions.close")}
              </button>
            </div>
            <div class="flex-1 overflow-auto p-6">
              <Show when={loading()}><p class="text-xs text-secondary">{t("backgroundProcessOutputDialog.loading")}</p></Show>
              <Show when={truncated()}><p class="mb-2 text-xs text-secondary">{t("backgroundProcessOutputDialog.truncatedNotice")}</p></Show>
              <Show when={!loading()}>
                <pre
                  class="border border-base bg-surface-secondary p-4 font-mono text-xs text-primary whitespace-pre-wrap break-all"
                  innerHTML={ansiEnabled() ? outputHtml() : undefined}
                >{ansiEnabled() ? undefined : output()}</pre>
              </Show>
            </div>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog>
  )
}
