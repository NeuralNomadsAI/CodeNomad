import { For, Show, createUniqueId } from "solid-js"
import { useI18n } from "../../lib/i18n"
import { useConfig } from "../../stores/preferences"
import { activeSettingsSection } from "../../stores/settings-screen"
import { SettingsInfoTip } from "./settings-info-tip"
import { SettingsSwitch } from "./settings-switch"
import { useServiceSupervision } from "./useServiceSupervision"

export function ServiceSupervisionCard() {
  const { t, locale } = useI18n(), { serverSettings } = useConfig()
  const titleID = createUniqueId(), descriptionID = createUniqueId()
  const settings = useServiceSupervision({ active: () => activeSettingsSection() === "opencode",
    selection: () => serverSettings().opencodeBinary })
  const disabled = () => settings.busy() || settings.error() || !settings.snapshot() || Boolean(settings.operation())
  const date = (value: string) => {
    const parsed = new Date(value)
    return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString(locale()) : value
  }
  const timestamps = () => {
    const value = settings.snapshot()
    return value ? (["lastAttemptAt", "retryAt", "recoveryNextTickAt"] as const)
      .flatMap(key => value[key] ? [{ key, value: value[key]! }] : []) : []
  }
  return <section class="settings-card" aria-labelledby={titleID}>
    <div class="settings-card-header">
      <h3 id={titleID} class="settings-card-title">{t("settings.supervision.title")}
        <SettingsInfoTip text={t("settings.supervision.info")} /></h3>
      <SettingsSwitch label={t("settings.supervision.title")} checked={settings.snapshot()?.desired === "on"}
        disabled={disabled()} describedBy={descriptionID} onChange={checked => void settings.save(checked ? "on" : "off")} />
    </div>
    <div class="settings-card-body">
      <p id={descriptionID} class="settings-toggle-caption">{t("settings.supervision.scope")}</p>
      <Show when={settings.snapshot()} fallback={<Show when={!settings.error()}><p role="status">{t("settings.supervision.loading")}</p></Show>}>{data => <>
        <p role="status" class="settings-toggle-title">{t(`settings.supervision.state.${data().state}`)}</p>
        <Show when={data().desired === "unset"}><p class="settings-toggle-caption">{t("settings.supervision.default")}</p></Show>
        <Show when={data().desired === "off"}><p class="settings-toggle-caption">{t("settings.supervision.off")}</p></Show>
        <Show when={data().cause}>{cause => <p role="status" class="settings-toggle-caption">{t(`settings.supervision.cause.${cause()}`)}</p>}</Show>
        <Show when={data().serviceResponding && data().state !== "running"}>
          <p class="settings-toggle-caption">{t("settings.supervision.responding")}</p>
        </Show>
        <For each={timestamps()}>{entry => <p class="settings-toggle-caption">
          {t(`settings.supervision.${entry.key}`, { date: date(entry.value) })}
        </p>}</For>
      </>}</Show>
      <Show when={settings.error()}><p role="alert">{t("settings.supervision.unavailable")}</p></Show>
      <Show when={settings.conflict()}><p role="alert">{t("settings.supervision.conflict")}</p></Show>
      <Show when={settings.operation()?.state === "uncertain"}><p role="alert">{t("settings.supervision.uncertain")}</p></Show>
      <div class="settings-info-actions">
        <button type="button" class="window-action" disabled={settings.busy()} onClick={() => void settings.refresh()}>
          {t("settings.supervision.refresh")}
        </button>
        <Show when={settings.snapshot()?.desired === "unset"}>
          <button type="button" class="window-action" disabled={disabled()} onClick={() => void settings.save("off")}>
            {t("settings.supervision.keepOff")}
          </button>
        </Show>
        <Show when={settings.operation()?.state === "uncertain"} fallback={
          <Show when={settings.snapshot()?.cause && settings.snapshot()?.desired !== "unset"}>
            <button type="button" class="window-action" disabled={disabled()} onClick={() => void settings.save("retry")}>
              {t("settings.supervision.retry")}
            </button>
          </Show>}>
          <button type="button" class="window-action" disabled={settings.busy() || settings.error()}
            onClick={() => void settings.retryOriginal()}>{t("settings.supervision.retryOriginal")}</button>
        </Show>
      </div>
    </div>
  </section>
}
