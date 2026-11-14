import { Show, createEffect, createSignal, createUniqueId, onCleanup } from "solid-js"
import type { ShellInfo } from "@opencode/client"

import { createAnsiStreamRenderer, hasAnsi } from "../lib/ansi"
import { useI18n } from "../lib/i18n"
import { appendShellOutput } from "../stores/shell-store"
import { shellStore } from "../stores/shells"
import { OutputWindow } from "./output-window"

interface ShellOutputDialogProps {
  open: boolean
  instanceId: string
  directory: string
  workspaceID?: string
  shell: ShellInfo | null
  onClose: () => void
}

export function ShellOutputDialog(props: ShellOutputDialogProps) {
  const { t } = useI18n()
  const id = `shell-output-${createUniqueId()}`
  const [output, setOutput] = createSignal("")
  const [outputHtml, setOutputHtml] = createSignal("")
  const [ansiEnabled, setAnsiEnabled] = createSignal(false)
  const [truncated, setTruncated] = createSignal(false)
  const [loading, setLoading] = createSignal(false)

  createEffect(() => {
    const shell = props.shell
    const directory = props.directory
    const workspaceID = props.workspaceID
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
        const result = await shellStore.output(props.instanceId, directory, shell.id, cursor, workspaceID)
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
        setAnsiEnabled(false)
        setOutputHtml("")
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
    <OutputWindow id={id} open={props.open} title={t("backgroundProcessOutputDialog.title")}
      subtitle={props.shell?.command} onClose={props.onClose}>
              <Show when={loading()}><p class="text-xs text-secondary">{t("backgroundProcessOutputDialog.loading")}</p></Show>
              <Show when={truncated()}><p class="mb-2 text-xs text-secondary">{t("backgroundProcessOutputDialog.truncatedNotice")}</p></Show>
              <Show when={!loading()}>
                <Show when={ansiEnabled()} fallback={
                  <pre class="border border-base bg-surface-inset p-4 font-mono text-xs text-primary whitespace-pre-wrap break-all">{output()}</pre>
                }>
                  <pre class="border border-base bg-surface-inset p-4 font-mono text-xs text-primary whitespace-pre-wrap break-all" innerHTML={outputHtml()} />
                </Show>
              </Show>
    </OutputWindow>
  )
}
