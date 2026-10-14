import { Show, createSignal } from "solid-js"
import { render } from "solid-js/web"
import MissionControl from "../../../src/components/instance/shell/right-panel/tabs/MissionControl"
import { MissionReader } from "../../../src/components/mission-reader"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider, useI18n } from "../../../src/lib/i18n"
import { initializeClientState } from "../../../src/stores/client-state"
import { addInstance } from "../../../src/stores/instances"
import { addFormToQueue } from "../../../src/stores/forms"
import { missionProjectView } from "../../../src/stores/mission-view-state"
import { serverEvents } from "../../../src/lib/server-events"
import { sdkManager } from "../../../src/lib/sdk-manager"
import { setSessions } from "../../../src/stores/session-state"
import "../../../src/index.css"
import { markSessionListsRestored } from "./session-list-restored"

await initializeClientState()
markSessionListsRestored("fixture")
addInstance({ id: "fixture", folder: "/fixture", port: 0, pid: 0, proxyPath: "/workspaces/fixture/instance", status: "ready",
  client: sdkManager.createClient("fixture", "/workspaces/fixture/instance", () => true),
  metadata: { project: { id: "project", directory: "/fixture", canonical: "/fixture" } } })
setSessions(previous => new Map(previous).set("fixture", new Map(["ses_task", "ses_coordinator"].map(id => [id, {
  id, instanceId: "fixture", parentId: id === "ses_task" ? "ses_coordinator" : null, title: id, status: "idle", runtimeStatusKnown: true,
  agent: "build", model: { providerId: "fixture", modelId: "fixture" }, projectID: "project", cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, location: { directory: "/fixture" }, time: { created: 1, updated: 1 },
}]))))
addFormToQueue("fixture", { id: "form_child", sessionID: "ses_child", location: { directory: "/fixture" }, title: "Real child request",
  tool: { name: "question" }, fields: [], time: { created: 1 } } as never)
function Fixture() {
  const { t } = useI18n()
  const [active, activate] = createSignal(true)
  Object.assign(window, { passageFixture: { activate, settled: () => {
    (serverEvents as any).dispatchBatch([{ type: "instance.event", instanceId: "fixture", event: {
      type: "rpc.codenomad.missions.scheduleChanged", id: "native-settlement", created: 2, location: { directory: "/fixture" },
      data: { scheduleID: "rec_current", revision: 3 } } }])
  }, invalidate: (type = "session.status") => {
    (serverEvents as any).dispatchBatch([{ type: "instance.event", instanceId: "fixture", event: {
      type, id: "native-event", created: 1, location: { directory: "/fixture" }, data: {} } }])
  } } })
  return <main style={{ display: "flex", height: "100vh" }}>
    <aside style={{ width: "390px", overflow: "auto" }}><MissionControl instanceId="fixture" isActive={active} activeSessionId={() => "ses_existing"} t={t} /></aside>
    <div class="mission-transcript-surface"><Show when={missionProjectView("/fixture").reader}><MissionReader instanceId="fixture" scope="/fixture" /></Show></div>
  </main>
}
render(() => <ConfigProvider><I18nProvider><Fixture /></I18nProvider></ConfigProvider>, document.getElementById("root")!)
