import { Show, createSignal } from "solid-js"
import { render } from "solid-js/web"
import { ConfigFilesSettingsSection } from "../../../src/components/settings/config-files-settings-section"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { adoptSettingsRowHint, openSettingsConfigFile, settingsRowTarget } from "../../../src/stores/settings-screen"
import AlertDialog from "../../../src/components/alert-dialog"
import { confirmSettingsDiscard } from "../../../src/stores/settings-dirty-guard"
import "../../../src/index.css"

function Fixture() {
  const [mounted, mount] = createSignal(false)
  Object.assign(window, { configTarget: {
    open: async (id: string) => { await openSettingsConfigFile(id); mount(true) },
    native: (id: string, at = Date.now()) => {
      localStorage.setItem("codenomad.settings.rowTarget", JSON.stringify({ section: "config-files", row: `config-file:${id}`, at }))
      adoptSettingsRowHint("config-files"); mount(true)
    },
    pending: settingsRowTarget,
    checkDiscard: () => { void confirmSettingsDiscard().then(result => { (window as any).configTarget.discardResult = result }) },
  } })
  return <><Show when={mounted()}><ConfigFilesSettingsSection /></Show><AlertDialog /></>
}
render(() => <ConfigProvider><I18nProvider><ThemeProvider><Fixture /></ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
