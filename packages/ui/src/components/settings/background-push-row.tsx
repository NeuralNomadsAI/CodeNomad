import { Show, onMount } from "solid-js"
import { useI18n } from "../../lib/i18n"
import { isWebHost } from "../../lib/runtime-env"
import { backgroundPushActive } from "../../lib/background-push-state"
import { backgroundPushBusy, backgroundPushState, refreshBackgroundPush, toggleBackgroundPush } from "../../lib/background-push"
import { SettingsSwitch } from "./settings-switch"
import { SettingsInfoTip } from "./settings-info-tip"

export function BackgroundPushRow() {
  const { t } = useI18n()
  onMount(() => { if (isWebHost()) void refreshBackgroundPush() })
  return <Show when={isWebHost()}>
    <div class="settings-toggle-row">
      <span>
        <span class="settings-toggle-title">{t("settings.notifications.push.title")}
          <SettingsInfoTip text={t(`settings.notifications.push.${backgroundPushState()}`)}
            help={backgroundPushState() === "https" ? { page: "mobile", anchor: "secure-context" }
              : backgroundPushState() === "ios" ? { page: "mobile", anchor: "install-pwa" }
              : { page: "settings", anchor: "notifications" }} />
        </span>
        <Show when={backgroundPushState() !== "ready"}>
          <span class="settings-toggle-caption" role="status">{t(`settings.notifications.push.${backgroundPushState()}`)}</span>
        </Show>
      </span>
      <SettingsSwitch checked={backgroundPushActive()} label={t("settings.notifications.push.title")}
        disabled={backgroundPushBusy() || !backgroundPushActive() && backgroundPushState() !== "ready"}
        onChange={enabled => void toggleBackgroundPush(enabled)} />
    </div>
  </Show>
}
