import { render } from "solid-js/web"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { GeneralSettingsSection } from "../../../src/components/settings/general-settings-section"
import { initializeClientState, updateRestorableSession, flushClientState } from "../../../src/stores/client-state"
import { runStartupStateCommand } from "../../../src/stores/client-state-owner-commands"
import { installNativeStartupStateCommandHandler } from "../../../src/lib/native/client-state"
import "../../../src/index.css"

// A local main window: it owns client state and executes forwarded commands.
void (async () => {
  await initializeClientState()
  await installNativeStartupStateCommandHandler(runStartupStateCommand)
  ;(window as any).ownerFixture = {
    capture: async (folder: string) => {
      updateRestorableSession({ tabs: [{ kind: "workspace", folder, occurrence: 0 }], activeTabIndex: 0 } as never)
      await flushClientState()
    },
  }
  render(() => <ConfigProvider><I18nProvider><ThemeProvider>
    <section class="settings-screen-content"><GeneralSettingsSection /></section>
  </ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
})()
