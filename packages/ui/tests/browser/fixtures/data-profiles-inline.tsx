import { render } from "solid-js/web"
import { Toaster } from "solid-toast"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import AlertDialog from "../../../src/components/alert-dialog"
import { GeneralSettingsSection } from "../../../src/components/settings/general-settings-section"
import { initializeClientState } from "../../../src/stores/client-state"
import "../../../src/index.css"

// Inline settings inside a main window (or a plain browser when no host is stubbed).
void (async () => {
  await initializeClientState()
  render(() => <ConfigProvider><I18nProvider><ThemeProvider>
    <section class="settings-screen-content"><GeneralSettingsSection /></section>
    <AlertDialog />
    <Toaster position="top-right" />
  </ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
  ;(window as any).fixtureRendered = true
})()
