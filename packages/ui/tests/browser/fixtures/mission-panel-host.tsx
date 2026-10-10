import { Show, createSignal } from "solid-js"
import { render } from "solid-js/web"
import MissionControl from "../../../src/components/instance/shell/right-panel/tabs/MissionControl"
import { MissionsSettingsSection } from "../../../src/components/settings/missions-settings-section"
import { missionProjectView } from "../../../src/stores/mission-view-state"
import { initializeClientState } from "../../../src/stores/client-state"
import { ConfigProvider } from "../../../src/stores/preferences"
import { getRootClient } from "../../../src/stores/opencode-client"
import { I18nProvider, useI18n } from "../../../src/lib/i18n"
import { addInstance } from "../../../src/stores/instances"
import { activeSettingsSection, settingsOpen } from "../../../src/stores/settings-screen"
import { applyColorScheme, normalizeColorScheme } from "../../../src/lib/theme-scheme"
import "../../../src/index.css"

await initializeClientState()
addInstance({ id: "fixture", folder: "fixture", port: 0, pid: 0, proxyPath: "", status: "ready", client: getRootClient("fixture"),
  metadata: { project: { id: "project", directory: "fixture", canonical: "/fixture" } } })

/** MissionControl inside the same host chain as RightPanel: a fixed-height column whose
 * tab body (`flex-1 overflow-y-auto`) holds a `h-full min-h-0` tab panel. */
function Fixture() {
  const { t } = useI18n()
  const [mounted, setMounted] = createSignal(true)
  applyColorScheme(normalizeColorScheme("classic"))
  ;(window as any).missionHost = {
    mount: setMounted,
    view: () => missionProjectView("fixture"),
    settings: () => ({ open: settingsOpen(), section: activeSettingsSection() }),
  }
  return <div style={{ display: "grid", "grid-template-columns": "minmax(0, 1fr) min(370px, 100vw)", height: "100vh" }}>
    <main id="chat" style={{ "min-width": 0 }}><p>Chat fixture</p>
      <Show when={settingsOpen() && activeSettingsSection() === "missions"}>
        <div id="settings-missions"><MissionsSettingsSection instanceId="fixture" /></div>
      </Show>
    </main>
    <div style={{ display: "flex", "flex-direction": "column", height: "100vh", "min-height": 0 }}>
      <div style={{ height: "40px", "flex-shrink": 0 }}>Tabs</div>
      <div id="tab-body" class="flex-1 overflow-y-auto" style={{ flex: "1 1 0%", "overflow-y": "auto", "min-height": 0 }}>
        <div role="tabpanel" class="h-full min-h-0" style={{ height: "100%", "min-height": 0 }}>
          <Show when={mounted()}><MissionControl instanceId="fixture" activeSessionId={() => null} isActive={() => true} t={t} /></Show>
        </div>
      </div>
    </div>
  </div>
}
render(() => <ConfigProvider><I18nProvider><Fixture /></I18nProvider></ConfigProvider>, document.getElementById("root")!)
