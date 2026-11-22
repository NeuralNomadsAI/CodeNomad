import { Show, createSignal } from "solid-js"
import { render } from "solid-js/web"
import AlertDialog from "../../../src/components/alert-dialog"
import RightPanel from "../../../src/components/instance/shell/right-panel/RightPanel"
import { SettingsScreen } from "../../../src/components/settings-screen"
import { RIGHT_PANEL_CUSTOMIZATION_STORAGE_KEY, RIGHT_PANEL_TAB_STORAGE_KEY } from "../../../src/components/instance/shell/storage"
import { initializeClientState, writeClientLayoutValue } from "../../../src/stores/client-state"
import { ConfigProvider, ensureLoaded } from "../../../src/stores/preferences"
import { activeSettingsSection, setActiveSettingsSection } from "../../../src/stores/settings-screen"
import { I18nProvider, useI18n } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { serverEvents } from "../../../src/lib/server-events"
import { missionStore } from "../../../src/stores/missions"
import { getTabViewState, updateTabViewState } from "../../../src/stores/tab-view-state"
import { pluginControlsCache } from "../../../src/stores/plugin-controls"
import type { Instance } from "../../../src/types/instance"
import "../../../src/index.css"
import { setSessionListFetching } from "./session-list-restored"

await initializeClientState()
await ensureLoaded()
writeClientLayoutValue(RIGHT_PANEL_TAB_STORAGE_KEY, "missions")
if (new URLSearchParams(location.search).has("hidden")) {
  writeClientLayoutValue(RIGHT_PANEL_CUSTOMIZATION_STORAGE_KEY, JSON.stringify({ hiddenTabIds: ["missions"] }))
}
const instance: Instance = { id: "mission-visibility", folder: "/fixture", port: 0, pid: 0,
  proxyPath: "/fixture", status: "ready", client: null }
updateTabViewState(instance.id, { rightPanelTab: "missions" })
function Fixture() {
  const { t } = useI18n()
  const [active, setActive] = createSignal(false)
  const [mounted, setMounted] = createSignal(true)
  const [settings, showSettings] = createSignal<boolean | "global">(false)
  ;(window as any).missionVisibility = {
    activate: setActive,
    warmActivation: () => pluginControlsCache.load(instance.id, { directory: instance.folder }),
    savedTab: () => getTabViewState(instance.id).rightPanelTab,
    // Selection persists in the per-window view; unmounting disposes the selected toolbar.
    mount: setMounted,
    settings: showSettings,
    settingsSection: activeSettingsSection,
    restoreMissionsSettings: () => setActiveSettingsSection("missions"),
    demanded: () => missionStore.demandedInstanceIds(),
    state: () => missionStore.state(instance.id),
    // Startup order: restoration has not begun, is running, then settles.
    restoration: (fetching: boolean) => setSessionListFetching(fetching, instance.id),
    event: (type: string) => (serverEvents as any).dispatchBatch([
      { type: "instance.event", instanceId: instance.id, event: { type, location: { directory: instance.folder }, data: { sessionID: "visibility-actor" } } },
    ]),
  }
  return <div style={{ width: "390px", height: "850px", display: active() ? "block" : "none" }}>
    <Show when={mounted()}><RightPanel isActive={active} t={t} instanceId={instance.id} instance={instance}
      activeSessionId={() => null} activeSession={() => null} isPhoneLayout={() => false}
      rightDrawerWidth={() => 390} rightDrawerWidthInitialized={() => true}
      onCloseRightDrawer={() => {}} promptInputApi={() => null} setContentEl={() => {}} /></Show>
    <Show when={settings()}><SettingsScreen standalone providerContext={settings() === "global" ? undefined
      : { instanceId: instance.id, location: { directory: instance.folder } }} /></Show>
    {/* App-level host for Stop… confirmations, as in App.tsx. */}
    <AlertDialog />
  </div>
}
render(() => <ConfigProvider><I18nProvider><ThemeProvider><Fixture /></ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
