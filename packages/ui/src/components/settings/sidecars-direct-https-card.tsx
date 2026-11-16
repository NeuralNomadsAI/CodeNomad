import { Show, createSignal, onMount, type Component } from "solid-js"
import { useI18n } from "../../lib/i18n"
import { getServerMeta, localRequest } from "../../lib/server-meta"
import { setSidecarsOverDirectHttps, useConfig } from "../../stores/preferences"
import { SettingsInfoTip } from "./settings-info-tip"
import { SettingsSwitch } from "./settings-switch"

/** Host-only switch: lets signed-in browsers on verified direct HTTPS origins open SideCars. */
export const SideCarsDirectHttpsCard: Component = () => {
  const { t } = useI18n()
  const { serverSettings } = useConfig()
  const [saving, setSaving] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  onMount(() => { void getServerMeta().catch(() => {}) })

  const change = async (enabled: boolean) => {
    setSaving(true)
    setError(null)
    try {
      await setSidecarsOverDirectHttps(enabled)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Show when={localRequest()}>
      <div class="settings-card">
        <div class="settings-card-content">
          <div class="settings-toggle-row">
            <div class="settings-toggle-title">
              {t("sidecars.directHttps.title")}
              <SettingsInfoTip text={t("sidecars.directHttps.info")} help={{ page: "browser-sidecars", anchor: "register-sidecar" }} />
            </div>
            <SettingsSwitch
              checked={serverSettings().sidecarsOverDirectHttps}
              label={t("sidecars.directHttps.title")}
              disabled={saving()}
              onChange={(enabled) => void change(enabled)}
            />
          </div>
          <Show when={error()}>{(message) => <div class="settings-error-message">{message()}</div>}</Show>
        </div>
      </div>
    </Show>
  )
}
