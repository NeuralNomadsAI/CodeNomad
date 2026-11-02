import { Show, createSignal } from "solid-js"
import { render } from "solid-js/web"
import MissionControl from "../../../src/components/instance/shell/right-panel/tabs/MissionControl"
import { initializeClientState } from "../../../src/stores/client-state"
import { ConfigProvider } from "../../../src/stores/preferences"
import { getRootClient } from "../../../src/stores/opencode-client"
import { I18nProvider, useI18n } from "../../../src/lib/i18n"
import { addInstance } from "../../../src/stores/instances"
import { missionStore } from "../../../src/stores/missions"
import "../../../src/index.css"
import { markSessionListsRestored } from "./session-list-restored"

await initializeClientState()
addInstance({ id: "fixture", folder: "fixture", port: 0, pid: 0, proxyPath: "", status: "ready", client: getRootClient("fixture"),
  metadata: { project: { id: "project", directory: "fixture", canonical: "/fixture" } } })
markSessionListsRestored("fixture")

// Real panel consumers with explicit view lifetime controls; no replacement focus logic.
function Fixture() {
  const { t } = useI18n()
  const [mounted, mount] = createSignal(true), [active, activate] = createSignal(true)
  ;(window as any).missionHost = { mount, activate, refresh: () => missionStore.refresh("fixture") }
  return <div style={{ display: "grid", "grid-template-columns": "minmax(0, 1fr) min(370px, 100vw)", height: "100vh" }}>
    <main id="chat"><button id="outside">Outside the panel</button></main>
    <div style={{ display: "flex", "flex-direction": "column", height: "100vh", "min-height": 0 }}>
      <div style={{ height: "40px", "flex-shrink": 0 }}>Tabs</div>
      <div id="tab-body" style={{ flex: "1 1 0%", "overflow-y": "auto", "min-height": 0 }}>
        <div role="tabpanel" style={{ height: "100%", "min-height": 0 }}>
          <Show when={mounted()}><MissionControl instanceId="fixture" activeSessionId={() => null} isActive={active} t={t} /></Show>
        </div>
      </div>
    </div>
  </div>
}
render(() => <ConfigProvider><I18nProvider><Fixture /></I18nProvider></ConfigProvider>, document.getElementById("root")!)
