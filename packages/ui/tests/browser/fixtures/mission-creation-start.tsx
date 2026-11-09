import { Show, createSignal } from "solid-js"
import { render } from "solid-js/web"
import { createMissionCreationStart } from "../../../src/components/mission-creation-start"
import { createMissionEditorScheduling } from "../../../src/components/mission-editor-schedule"
import { createMissionScheduleControls } from "../../../src/components/mission-schedule-controls"
import { MissionEditor } from "../../../src/components/mission-editor"
import AlertDialog from "../../../src/components/alert-dialog"
import { newMissionSchedulingDraft } from "../../../src/components/mission-scheduling-data"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { addInstance, updateInstance } from "../../../src/stores/instances"
import { getRootClient } from "../../../src/stores/opencode-client"
import { initializeClientState } from "../../../src/stores/client-state"
import { unifiedScheduleHold, type UnifiedMissionSchedule } from "../../../src/stores/mission-schedules"
import { serverApi } from "../../../src/lib/api-client"
import type { MissionEditorAction, MissionEditorDraft } from "../../../src/stores/mission-editor-state"
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
function RealEditorFixture() {
  updateInstance("fixture", { client: getRootClient("fixture") })
  const [projectID, setProjectID] = createSignal<string>()
  const [editing, setEditing] = createSignal(true), [controlsMounted, mountControls] = createSignal(true)
  const [doc, setDoc] = createSignal<UnifiedMissionSchedule>(), [saved, setSaved] = createSignal(0)
  const action: MissionEditorAction = { kind: "create" }
  const hold = () => unifiedScheduleHold(JSON.stringify(["fixture", projectID(), "/fixture", "msn_created"]))
  const Controls = () => {
    const controls = createMissionScheduleControls({ instanceId: "fixture", get projectID() { return projectID() }, directory: "/fixture",
      document: () => doc()!, active: () => true, enabled: () => true, refreshVersion: () => 0, refresh: () => {}, onDeleted: () => {} })
    return <section aria-label="Created mission controls">
      <output data-held-control>{JSON.stringify(controls.held() ?? null)}</output>
      <button disabled={!controls.held() || controls.busy()} onClick={() => void controls.reconcile()}>Refresh saved request</button>
    </section>
  }
  Object.assign(window, { realCreationStartFixture: {
    discoverProject: () => {
      updateInstance("fixture", { metadata: { project: { id: "project", directory: "/fixture", canonical: "/fixture" } } })
      setProjectID("project")
    }, mountControls, held: hold,
    orphaned: () => unifiedScheduleHold(JSON.stringify(["fixture", undefined, "/fixture", "msn_created"])),
  } })
  return <main style={{ "max-width": "600px", margin: "auto" }}>
    <output data-project>{projectID() ?? "undiscovered"}</output><output data-saved>{saved()}</output>
    <Show when={editing()}><MissionEditor instanceId="fixture" directory="/fixture" viewDirectory="/fixture" projectID={projectID()}
      action={action} active={() => true} onCancel={() => setEditing(false)} onSaved={async (_mission, id) => {
        if (!id) throw new Error("Expected calendar-owned creation")
        const read = await serverApi.fetchMissionSchedule("fixture", id, { directory: "/fixture" })
        if (!read.document) throw new Error("Created Mission unavailable")
        setDoc(read.document); setEditing(false); setSaved(value => value + 1)
      }} /></Show>
    <Show when={!editing() && doc() && controlsMounted()}><Controls /></Show>
    <AlertDialog />
  </main>
}
render(() => <ConfigProvider><I18nProvider>{new URLSearchParams(location.search).has("realEditor")
  ? <ThemeProvider><RealEditorFixture /></ThemeProvider> : <Fixture />}</I18nProvider></ConfigProvider>, document.getElementById("root")!)
