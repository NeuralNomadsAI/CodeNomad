import { render } from "solid-js/web"
import { createRoot, createSignal } from "solid-js"
import { createPreferencesProjectContext } from "../../../src/components/settings/preferences-project-context"
import type { NativePreferencesRequest } from "../../../src/lib/native/preferences-window"
import { registerSettingsDirtyGuard } from "../../../src/stores/settings-dirty-guard"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { PreferencesWindow } from "../../../src/components/preferences-window"
import { serverEvents } from "../../../src/lib/server-events"
import { sseManager } from "../../../src/lib/sse-manager"
import "../../../src/index.css"

;(window as any).preferencesFixture = {
  guard: registerSettingsDirtyGuard,
  dispatch: (events: unknown[]) => (serverEvents as any).dispatchBatch(events),
  status: (instanceId: string) => sseManager.getStatuses().get(instanceId) ?? null,
  startContext: (initial: NativePreferencesRequest) => createRoot(dispose => {
    const [request, setRequest] = createSignal(initial), [active, setActive] = createSignal(true)
    const rebounds: unknown[] = []
    const context = createPreferencesProjectContext(request, active, (value, current) => { if (current()) rebounds.push(value) })
    return { context, setRequest, setActive, rebounds, dispose }
  }),
}

render(() => <ConfigProvider><I18nProvider><ThemeProvider>
  <PreferencesWindow />
</ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
