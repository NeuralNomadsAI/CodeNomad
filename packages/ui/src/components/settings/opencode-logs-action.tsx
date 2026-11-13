import { Show, createEffect, createMemo, createSignal, createUniqueId, on, onCleanup } from "solid-js"
import { RefreshCw } from "lucide-solid"
import type { OpenCodeLogsResponse } from "../../../../server/src/api-types"
import { serverApi } from "../../lib/api-client"
import { useI18n } from "../../lib/i18n"
import { useConfig } from "../../stores/preferences"
import { OutputWindow } from "../output-window"
import { BoundedText } from "../hidden-text"
import { SettingsInfoTip } from "./settings-info-tip"

export function OpenCodeLogsAction() {
  const { t } = useI18n()
  const { serverSettings } = useConfig()
  const [open, setOpen] = createSignal(false)
  const [revision, setRevision] = createSignal(0)
  const [snapshot, setSnapshot] = createSignal<OpenCodeLogsResponse>()
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal(false)
  const id = `opencode-logs-${createUniqueId()}`
  let trigger: HTMLButtonElement | undefined
  const selectedBinary = createMemo(() => serverSettings().opencodeBinary)
  createEffect(on(selectedBinary, () => setOpen(false), { defer: true }))
  createEffect(on([open, revision], ([visible]) => {
    if (!visible) return
    const controller = new AbortController()
    setSnapshot(undefined); setError(false); setLoading(true)
    void serverApi.fetchOpenCodeLogs(controller.signal).then(result => {
      if (!controller.signal.aborted) setSnapshot(result)
    }).catch(() => {
      if (!controller.signal.aborted) setError(true)
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    onCleanup(() => controller.abort())
  }))
  return <>
    <div class="settings-info-actions">
      <button ref={element => { trigger = element }} type="button" class="window-action" aria-expanded={open()} aria-controls={id} onClick={() => setOpen(!open())}>
        {t("settings.opencode.logs.open")}
      </button>
      <SettingsInfoTip text={t("settings.opencode.logs.info")} />
    </div>
    <OutputWindow id={id} open={open()} title={t("settings.opencode.logs.title")} subtitle={snapshot()?.path}
      onClose={() => setOpen(false)} returnFocus={() => trigger} actions={
        <button type="button" class="window-icon-button" disabled={loading()} title={t("instanceShell.rightPanel.actions.refresh")}
          aria-label={t("instanceShell.rightPanel.actions.refresh")} onClick={() => setRevision(value => value + 1)}><RefreshCw class="h-4 w-4" /></button>
      }>
      <Show when={loading()}><p role="status">{t("instanceInfo.loading")}</p></Show>
      <Show when={error()}><p role="alert">{t("settings.opencode.logs.failed")}</p></Show>
      <Show when={snapshot()}>{value => <>
        <Show when={value().truncated}><p class="mb-2 text-xs text-secondary">{t("settings.opencode.logs.truncated")}</p></Show>
        <BoundedText source={value().text || t("settings.opencode.logs.empty")}>{text => <pre class="output-window-text">{text()}</pre>}</BoundedText>
      </>}</Show>
    </OutputWindow>
  </>
}
