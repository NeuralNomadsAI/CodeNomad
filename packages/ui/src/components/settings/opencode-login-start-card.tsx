import { Show, createSignal, createUniqueId, onCleanup, onMount } from "solid-js"
import type { LoginStartResponse } from "../../../../server/src/api-types"
import { useI18n } from "../../lib/i18n"
import { serverApi } from "../../lib/api-client"
import { serverEvents } from "../../lib/server-events"
import { HttpResponseError } from "../../lib/retryable-file-search"
import { SettingsInfoTip } from "./settings-info-tip"
import { SettingsSwitch } from "./settings-switch"

type Failure = "read" | "failed" | "unsupported-binary"
const states: LoginStartResponse["state"][] = ["on", "off", "unavailable"]
const checked = (value: LoginStartResponse) => {
  if (!value || !states.includes(value.state)) throw new Error("Invalid login start state")
  return value
}

/** Settings → OpenCode: the OS starts the OpenCode service at login. Stable row
 * anchor: `#opencode-login-start`. Reads on mount and reconnect; the latest
 * request wins and a change disables the switch until the server confirms it. */
export function OpenCodeLoginStartCard() {
  const { t } = useI18n()
  const titleID = createUniqueId()
  const [status, setStatus] = createSignal<LoginStartResponse>()
  const [busy, setBusy] = createSignal(false)
  const [failure, setFailure] = createSignal<Failure>()
  let sequence = 0, disposed = false
  const load = async () => {
    const request = ++sequence
    try {
      const next = checked(await serverApi.getOpenCodeLoginStart())
      if (!disposed && request === sequence) { setStatus(next); setFailure(undefined) }
    } catch { if (!disposed && request === sequence) setFailure("read") }
  }
  const change = async (enabled: boolean) => {
    if (busy()) return
    const request = ++sequence
    setBusy(true); setFailure(undefined)
    try {
      const next = checked(await serverApi.setOpenCodeLoginStart({ enabled }))
      if (!disposed && request === sequence) setStatus(next)
    } catch (error) {
      if (disposed) return
      const code = error instanceof HttpResponseError ? (error.body as { error?: unknown } | undefined)?.error : undefined
      // Show what the OS actually has after a refused change, with the cause; an
      // unreadable state keeps its own error and Try again.
      await load()
      if (!disposed && failure() !== "read") setFailure(code === "login-start-unsupported-binary" ? "unsupported-binary" : "failed")
    } finally { if (!disposed) setBusy(false) }
  }
  onMount(() => {
    const reconnect = serverEvents.onOpen(() => void load())
    onCleanup(() => { disposed = true; reconnect() })
    void load()
  })
  const unavailable = () => status()?.state === "unavailable"
  return <section id="opencode-login-start" class="settings-card" aria-labelledby={titleID}>
    <div class="settings-card-header">
      <h3 id={titleID} class="settings-card-title">{t("settings.loginStart.title")}<SettingsInfoTip text={t("settings.loginStart.info")} /></h3>
      <SettingsSwitch label={t("settings.loginStart.title")} checked={status()?.state === "on"}
        disabled={busy() || !status() || unavailable()} onChange={enabled => void change(enabled)} />
    </div>
    <Show when={unavailable() || failure()}>
      <div class="settings-card-body">
        <Show when={unavailable()}><p class="settings-toggle-caption">{t("settings.loginStart.unavailable")}</p></Show>
        <Show when={failure()}>{code => <div role="alert" class="settings-info-actions">
          <span class="settings-toggle-caption">{t(`settings.loginStart.error.${code()}`)}</span>
          <Show when={code() === "read"}>
            <button type="button" class="window-action" onClick={() => void load()}>{t("settings.loginStart.retry")}</button>
          </Show>
        </div>}</Show>
      </div>
    </Show>
  </section>
}
