import { createSignal, Show } from "solid-js"
import { render } from "solid-js/web"
import ProviderUsagePanel from "../../../src/components/session/provider-usage-panel"
import { ConfigProvider, useConfig } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { serverEvents } from "../../../src/lib/server-events"
import { settingsOpen, activeSettingsSection } from "../../../src/stores/settings-screen"
import "../../../src/index.css"

const [scope, setScope] = createSignal({ instanceId: "first", sessionId: "session-a", directory: "/repo", providerId: "openai", modelId: "gpt-5" })
const [active, setActive] = createSignal(true)
const [mounted, setMounted] = createSignal(false)
// Establish the real stream before mounting the panel so each test owns its
// subsequent synthetic reconnects independently of bootstrap network timing.
const stopOpen = serverEvents.onOpen(() => { stopOpen(); setMounted(true) })
;(window as any).usageFixture = {
  select: (next: Partial<ReturnType<typeof scope>>) => setScope(current => ({ ...current, ...next })),
  active: setActive, mounted: setMounted,
  locale: (locale: string) => (serverEvents as any).dispatchBatch([{ type: "storage.configChanged", owner: "ui", value: { settings: { locale } } }]),
  settings: () => ({ open: settingsOpen(), section: activeSettingsSection() }),
  event: (type: string, instanceId = scope().instanceId, directory = scope().directory, data = {}) => (serverEvents as any).dispatchBatch([{
    type: "instance.event", instanceId, event: { type, id: "event", created: Date.now(), data, location: { directory } },
  }]),
  connection: (status: string, generation = 1, instanceId = scope().instanceId) =>
    (serverEvents as any).dispatchBatch([{ type: "instance.eventStatus", instanceId, status, generation }]),
  transport: (status: string) => (serverEvents as any).emitTransportStatus(status),
}
function PreferencesControl() {
  const { updatePreferences } = useConfig()
  ;(window as any).usageFixture.creditBalance = (show: boolean) => updatePreferences({ showProviderUsageCreditBalance: show })
  return null
}
render(() => <ConfigProvider><PreferencesControl /><I18nProvider><Show when={mounted()}>
  <div data-usage class="border border-base bg-surface-secondary px-3 py-2"><ProviderUsagePanel instanceId={scope().instanceId} sessionId={scope().sessionId} directory={scope().directory}
    providerId={scope().providerId} modelId={scope().modelId} active={active()} /></div>
</Show></I18nProvider></ConfigProvider>, document.getElementById("root")!)
