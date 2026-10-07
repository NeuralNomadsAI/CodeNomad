import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import RightPanel from "../../../src/components/instance/shell/right-panel/RightPanel"
import { RIGHT_PANEL_TAB_STORAGE_KEY } from "../../../src/components/instance/shell/storage"
import { initializeClientState, writeClientLayoutValue } from "../../../src/stores/client-state"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider, useI18n } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { serverEvents } from "../../../src/lib/server-events"
import { missionStore } from "../../../src/stores/missions"
import type { Instance } from "../../../src/types/instance"
import "../../../src/index.css"

await initializeClientState()
writeClientLayoutValue(RIGHT_PANEL_TAB_STORAGE_KEY, "missions")
const instance: Instance = { id: "mission-visibility", folder: "/fixture", port: 0, pid: 0,
  proxyPath: "/fixture", status: "ready", client: null }
function Fixture() {
  const { t } = useI18n()
  const [active, setActive] = createSignal(false)
  ;(window as any).missionVisibility = {
    activate: setActive,
    demanded: () => missionStore.demandedInstanceIds(),
    state: () => missionStore.state(instance.id),
    event: (type: string) => (serverEvents as any).dispatchBatch([
      { type: "instance.event", instanceId: instance.id, event: { type, data: { sessionID: "visibility-actor", status: { type: "busy" } } } },
    ]),
  }
  return <div style={{ width: "390px", height: "850px", display: active() ? "block" : "none" }}>
    <RightPanel isActive={active} t={t} instanceId={instance.id} instance={instance}
      activeSessionId={() => null} activeSession={() => null} isPhoneLayout={() => false}
      rightDrawerWidth={() => 390} rightDrawerWidthInitialized={() => true}
      onCloseRightDrawer={() => {}} promptInputApi={() => null} setContentEl={() => {}} />
  </div>
}
render(() => <ConfigProvider><I18nProvider><ThemeProvider><Fixture /></ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
