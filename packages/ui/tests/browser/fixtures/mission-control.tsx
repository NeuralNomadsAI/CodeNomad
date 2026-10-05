import { Show, createSignal } from "solid-js"
import { render } from "solid-js/web"
import MissionControl from "../../../src/components/instance/shell/right-panel/tabs/MissionControl"
import { MissionReader } from "../../../src/components/mission-reader"
import { missionProjectView } from "../../../src/stores/mission-view-state"
import { initializeClientState, flushClientState } from "../../../src/stores/client-state"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider, useI18n } from "../../../src/lib/i18n"
import { serverEvents } from "../../../src/lib/server-events"
import { sdkManager } from "../../../src/lib/sdk-manager"
import { sseManager } from "../../../src/lib/sse-manager"
import { addInstance } from "../../../src/stores/instances"
import { activeSessionId, setSessions } from "../../../src/stores/session-state"
import { missionStore } from "../../../src/stores/missions"
import { applyColorScheme, normalizeColorScheme } from "../../../src/lib/theme-scheme"
import "../../../src/index.css"

await initializeClientState()
function Fixture() {
  const { t } = useI18n()
  const [mounted, setMounted] = createSignal(true)
  const [panelWidth, setPanelWidth] = createSignal("min(370px, 100vw)")
  applyColorScheme(normalizeColorScheme("classic"))
  ;(window as any).missionFixture = {
    flush: flushClientState,
    refresh: () => (serverEvents as any).dispatchBatch([{ type: "instance.event", instanceId: "fixture", event: { type: "rpc.codenomad.missions.changed" } }]),
    mount: setMounted,
    panelWidth: setPanelWidth,
    selectedSession: () => activeSessionId().get("fixture"),
    snapshot: () => missionStore.state("fixture"),
    seedCoordinators: (ids: string[]) => setSessions(previous => new Map(previous).set("fixture", new Map(ids.map(id => [id, {
      id, instanceId: "fixture", parentId: null, title: id, status: "idle", runtimeStatusKnown: true,
      location: { directory: "fixture" }, time: { created: 1, updated: 1 },
    } as any])))),
    seedActor: () => {
      const client: any = { session: { list: async () => { throw new Error("fixture unavailable") } }, form: { list: async () => [] } }
      ;(sdkManager as any).clients.set("fixture:/workspaces/fixture/instance", client)
      addInstance({ id: "fixture", folder: "fixture", port: 0, pid: 0, proxyPath: "", status: "ready", client })
      setSessions(previous => new Map(previous).set("fixture", new Map([["ses_background", {
        id: "ses_background", instanceId: "fixture", parentId: null, title: "Background assistant", agent: "build",
        model: { providerId: "native", modelId: "observed" }, status: "idle", runtimeStatusKnown: true,
        location: { directory: "fixture" }, time: { created: 1, updated: 1 },
      } as any]])))
    },
    event: (event: any) => (sseManager as any).handleEvent("fixture", { id: `ev_${Date.now()}`, created: Date.now(), location: { directory: "fixture" }, ...event }),
  }
  return <div style={{ display: "grid", "grid-template-columns": `minmax(0, 1fr) ${panelWidth()}`, height: "100vh" }}>
    <main class="mission-transcript-surface" style={{ "min-width": 0, overflow: "hidden" }}><p>Chat fixture</p>
      <Show when={missionProjectView("fixture").reader}><MissionReader instanceId="fixture" scope="fixture" /></Show>
    </main>
    <aside style={{ overflow: "auto" }}><Show when={mounted()}><MissionControl instanceId="fixture" activeSessionId={() => "ses_fixture"} t={t} /></Show></aside>
  </div>
}
render(() => <ConfigProvider><I18nProvider><Fixture /></I18nProvider></ConfigProvider>, document.getElementById("root")!)
