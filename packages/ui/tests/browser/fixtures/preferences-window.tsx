import { render } from "solid-js/web"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { PreferencesWindow } from "../../../src/components/preferences-window"
import { serverEvents } from "../../../src/lib/server-events"
import { sseManager } from "../../../src/lib/sse-manager"
import "../../../src/index.css"

;(window as any).preferencesFixture = {
  dispatch: (events: unknown[]) => (serverEvents as any).dispatchBatch(events),
  status: (instanceId: string) => sseManager.getStatuses().get(instanceId) ?? null,
}

render(() => <ConfigProvider><I18nProvider><ThemeProvider>
  <PreferencesWindow />
</ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
