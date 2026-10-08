import { Show } from "solid-js"
import { render } from "solid-js/web"
import { MissionReader } from "../../../src/components/mission-reader"
import { initializeClientState } from "../../../src/stores/client-state"
import { missionProjectView, updateMissionProjectView } from "../../../src/stores/mission-view-state"
import { addInstance } from "../../../src/stores/instances"
import { sdkManager } from "../../../src/lib/sdk-manager"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import "../../../src/index.css"

await initializeClientState()
const instanceId = "result-reader", scope = "/fixture"
addInstance({ id: instanceId, folder: scope, port: 0, pid: 0, status: "ready", proxyPath: `/workspaces/${instanceId}/instance`,
  client: sdkManager.createClient(instanceId, `/workspaces/${instanceId}/instance`, () => true),
  metadata: { project: { id: "project", directory: scope, canonical: scope } } })
;(window as any).resultReader = {
  show: (kind: "overview" | "report", itemId?: string) => updateMissionProjectView(scope, {
    reader: { missionId: "mission", kind, itemId },
  }),
  showCurrent: () => updateMissionProjectView(scope, { reader: { missionId: "mission", kind: "report", itemId: "late",
    recurrence: { instanceId, projectID: "project", scheduleID: "schedule", passageID: "passage" } } }),
}
render(() => <ConfigProvider><I18nProvider>
  <main class="mission-transcript-surface" style={{ height: "760px" }}>
    <Show when={missionProjectView(scope).reader}><MissionReader instanceId={instanceId} scope={scope} /></Show>
  </main>
</I18nProvider></ConfigProvider>, document.getElementById("root")!)
