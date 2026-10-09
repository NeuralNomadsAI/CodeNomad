import { createSignal, onCleanup, onMount, type Component } from "solid-js"
import { useI18n } from "../../lib/i18n"
import { showToastNotification } from "../../lib/notifications"
import { requestOpenerStartupState } from "../../lib/native/preferences-window"
import type { OpenerStartupStateResult, StartupStateCommand } from "../../lib/native/startup-state-command"
import { StartupStateSettingsView } from "./startup-state-settings-view"

/**
 * Startup state for the native Preferences window. This renderer owns no
 * client state: values and changes belong to the local window that opened
 * Preferences, and the host forwards each command to that exact window.
 */
export const OpenerStartupStateSettingsCard: Component = () => {
  const { t } = useI18n()
  const [opener, setOpener] = createSignal<OpenerStartupStateResult | null | undefined>()
  const [busy, setBusy] = createSignal(false)
  let sequence = 0

  const query = async (command: StartupStateCommand, epoch?: number) => {
    const request = ++sequence
    let result: OpenerStartupStateResult | null
    try {
      result = await requestOpenerStartupState(command, epoch)
    } catch (error) {
      if (request === sequence) setOpener(null)
      throw error
    }
    if (request === sequence) setOpener(result)
    return result
  }

  const refresh = () => {
    if (busy()) return
    void query("read").catch(() => undefined)
  }

  const mutate = async (command: StartupStateCommand, failure: string, success?: string) => {
    const epoch = opener()?.epoch
    if (epoch === undefined || busy()) return
    setBusy(true)
    try {
      const result = await query(command, epoch)
      if (!result.applied || !result.state) throw new Error("Startup state owner changed")
      if (success) showToastNotification({ message: t(success), variant: "success" })
    } catch {
      showToastNotification({ message: t(failure), variant: "error" })
    } finally {
      setBusy(false)
    }
    // A rejected or fenced change must show the opener's actual value again.
    if (!opener()?.applied) refresh()
  }

  onMount(() => {
    refresh()
    const onVisibility = () => { if (document.visibilityState === "visible") refresh() }
    window.addEventListener("focus", refresh)
    document.addEventListener("visibilitychange", onVisibility)
    onCleanup(() => {
      window.removeEventListener("focus", refresh)
      document.removeEventListener("visibilitychange", onVisibility)
    })
  })

  const state = () => opener()?.state ?? null
  const note = () => {
    if (opener() === undefined) return undefined
    return state() ? t("settings.appearance.startup.opener.scope") : t("settings.appearance.startup.opener.unavailable")
  }

  return (
    <StartupStateSettingsView
      restoreEnabled={state()?.restoreEnabled ?? false}
      disabled={busy() || !state()?.isPrimary}
      note={note()}
      onRestoreChange={(enabled) => void mutate(enabled ? "enable-restore" : "disable-restore", "settings.appearance.startup.updateError")}
      onClear={() => void mutate("clear", "settings.appearance.startup.clearError", "settings.appearance.startup.clearSuccess")}
    />
  )
}
