import { createSignal, For } from "solid-js"
import { render } from "solid-js/web"
import { SettingsInfoTip } from "../../../src/components/settings/settings-info-tip"
import { SettingsChoiceRow } from "../../../src/components/settings/settings-switch"
import { OpenCodeLoginStartCard } from "../../../src/components/settings/opencode-login-start-card"
import { createCoreStatusSectionManifest } from "../../../src/components/instance/shell/right-panel/core-plugin"
import AlertDialog from "../../../src/components/alert-dialog"
import { ConfigProvider, updatePreferences } from "../../../src/stores/preferences"
import { I18nProvider, useI18n } from "../../../src/lib/i18n"
import { applyUiSettings } from "./ui-settings"
import "../../../src/index.css"

await applyUiSettings({ locale: "en", theme: "dark" })
const [changed, setChanged] = createSignal(0)
const [leaked, setLeaked] = createSignal(0)
const [checked, setChecked] = createSignal(false)
;(window as any).fixture = { locale: (locale: any) => updatePreferences({ locale }), changed, leaked }

function Example() {
  const { t } = useI18n()
  const sections = createCoreStatusSectionManifest({ renderTokens: () => null, renderYoloModeSection: () => null,
    renderProviderUsage: () => null, renderBackgroundProcesses: () => null, renderMcpStatus: () => null, renderPluginStatus: () => null,
    renderInfo: section => <SettingsInfoTip text={t(section.tooltipKey)} help={section.help} /> }).statusSections
  return <main class="settings-content" style={{ width: "min(700px, 100%)", margin: "auto", padding: "24px" }}>
    <OpenCodeLoginStartCard />
    <div class="settings-card" onClick={() => setLeaked(n => n + 1)} onPointerDown={() => setLeaked(n => n + 1)} onKeyDown={() => setLeaked(n => n + 1)}>
      <SettingsChoiceRow checked={checked()} title={t("settings.behavior.keepComputerAwake.title")}
        info={t("settings.behavior.keepComputerAwake.info")} help={{ page: "settings", anchor: "keep-computer-awake" }}
        onChange={value => { setChecked(value); setChanged(n => n + 1) }} />
      <label data-only-tip><span>Diagnostic<SettingsInfoTip text="Live diagnostic explanation" /></span><input type="checkbox" /></label>
      <details><summary>{t("advancedSettings.environmentVariables.title")}<SettingsInfoTip text={t("advancedSettings.environmentVariables.subtitle")} help={{ page: "opencode", anchor: "session-environment" }} /></summary><div>Environment</div></details>
    </div>
    <div class="settings-card" data-status-tips><For each={sections}>{section => <div>{t(section.labelKey)}{section.renderInfo?.()}</div>}</For></div>
    <AlertDialog />
  </main>
}
render(() => <ConfigProvider><I18nProvider><Example /></I18nProvider></ConfigProvider>, document.getElementById("root")!)
