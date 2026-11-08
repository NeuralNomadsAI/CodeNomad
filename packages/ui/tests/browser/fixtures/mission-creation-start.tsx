import { Show, createSignal } from "solid-js"
import { render } from "solid-js/web"
import { createMissionCreationStart } from "../../../src/components/mission-creation-start"
import { createMissionEditorScheduling } from "../../../src/components/mission-editor-schedule"
import { createMissionScheduleControls } from "../../../src/components/mission-schedule-controls"
import AlertDialog from "../../../src/components/alert-dialog"
import { newMissionSchedulingDraft } from "../../../src/components/mission-scheduling-data"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { addInstance } from "../../../src/stores/instances"
import { initializeClientState } from "../../../src/stores/client-state"
import { unifiedScheduleHold, type UnifiedMissionSchedule } from "../../../src/stores/mission-schedules"
import { serverApi } from "../../../src/lib/api-client"
import type { MissionEditorDraft } from "../../../src/stores/mission-editor-state"
import type { MissionEditorConfiguration } from "../../../src/stores/mission-schedule-editor-holds"
import "../../../src/index.css"

await initializeClientState()
addInstance({ id: "fixture", folder: "/fixture", port: 0, pid: 0, proxyPath: "", status: "ready", client: null })
function Fixture() {
  const [mounted, mount] = createSignal(true), [active, activate] = createSignal(true)
  const [saved, setSaved] = createSignal(0), [doc, setDoc] = createSignal<UnifiedMissionSchedule>()
  const captureView = () => { const before = active(); return () => active() && before }
  const Editor = () => {
    const captureStart = createMissionCreationStart({ instanceId: "fixture", projectID: "project", directory: "/fixture",
      active, captureView, refresh: () => {} })
    const schedule = createMissionEditorScheduling({ instanceId: "fixture", directory: "/fixture", action: { kind: "create" },
      scope: () => "creation-fixture", owner: () => "owner", active, captureView, onLoad: () => {},
      captureDraft: () => ({ objective: "Inspect changes", notes: "", template: "custom", scheduling: newMissionSchedulingDraft() }) as MissionEditorDraft,
      onSaved: () => setSaved(value => value + 1) })
    let continuation: ReturnType<typeof captureStart>
    Object.assign(window, { creationStartFixture: {
      mount, activate,
      save: async (configuration: MissionEditorConfiguration, requested = true) => {
        continuation = captureStart(requested)
        await schedule.save(configuration, "create-original", async document => { setDoc(document); await continuation(document) })
      },
      repeat: async () => { if (doc()) await continuation(doc()!) },
      reconcile: schedule.reconcile,
      refresh: async () => { const read = await serverApi.fetchMissionSchedule("fixture", "msn_created", { directory: "/fixture" }); setDoc(read.document ?? undefined) },
      held: () => unifiedScheduleHold(JSON.stringify(["fixture", "project", "/fixture", "msn_created"])),
    } })
    return <span data-editor-hold>{schedule.held()?.state}</span>
  }
  const Controls = () => {
    const controls = createMissionScheduleControls({ instanceId: "fixture", projectID: "project", directory: "/fixture",
      document: () => doc()!, active, enabled: () => true, refreshVersion: () => 0, refresh: () => {}, onDeleted: () => {} })
    return <button onClick={() => void controls.reconcile()}>Refresh saved request</button>
  }
  return <><output data-saved>{saved()}</output><Show when={mounted()}><Editor /></Show>
    <Show when={doc()}><Controls /></Show><AlertDialog /></>
}
render(() => <ConfigProvider><I18nProvider><Fixture /></I18nProvider></ConfigProvider>, document.getElementById("root")!)
