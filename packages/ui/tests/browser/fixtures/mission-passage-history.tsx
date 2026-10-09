import { Show, createSignal } from "solid-js"
import { render } from "solid-js/web"
import { MissionRecurrenceList } from "../../../src/components/mission-recurrence-list"
import { MissionReader } from "../../../src/components/mission-reader"
import { InterruptionDock } from "../../../src/components/interruption-dock"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { initializeClientState } from "../../../src/stores/client-state"
import { addInstance, updateInstance } from "../../../src/stores/instances"
import { missionProjectView, updateMissionProjectView } from "../../../src/stores/mission-view-state"
import { serverEvents } from "../../../src/lib/server-events"
import type { WorkspaceEventPayload } from "../../../../server/src/api-types"
import { MISSION_RECURRENCE_CHANGED_EVENT } from "../../../../server/src/missions/recurrence-events"
import "../../../src/index.css"

await initializeClientState()
addInstance({ id: "fixture", folder: "/fixture", port: 0, pid: 0, proxyPath: "", status: "ready", client: null,
  metadata: { project: { id: "project", directory: "/fixture", canonical: "/fixture" } } })

function Fixture() {
  const [active, activate] = createSignal(true), [projectID, project] = createSignal("project"), [scope, directory] = createSignal("/fixture")
  const [refresh, setRefresh] = createSignal(0)
  const [status, setStatus] = createSignal(false)
  const [readerVisible, setReaderVisible] = createSignal(true)
  let revision = 0
  const dispatch = (type: string, data: Record<string, unknown>, instanceId = "fixture") =>
    (serverEvents as unknown as { dispatchBatch(events: WorkspaceEventPayload[]): void }).dispatchBatch([
      { type: "instance.event", instanceId, event: { type, id: "evt_schedule_changed", created: 1,
        location: { directory: scope() }, data } },
    ])
  window.passageHistory = {
    activate, readerVisible: setReaderVisible, status: setStatus, refresh: () => setRefresh(value => value + 1),
    project: id => { project(id); updateInstance("fixture", { metadata: { project: { id, directory: scope(), canonical: scope() } } }) },
    directory: folder => { directory(folder); updateInstance("fixture", { folder }) },
    invalidate: () => dispatch(MISSION_RECURRENCE_CHANGED_EVENT, { scheduleID: "schedule_fixture", revision: ++revision }),
    scheduleChanged: (scheduleID, revision) => dispatch(MISSION_RECURRENCE_CHANGED_EVENT, { scheduleID, revision }),
    event: dispatch,
  }
  return <div style={{ display: "flex", "flex-wrap": "wrap", gap: "8px" }}>
    <aside class="mission-control" style={{ width: "280px" }}>
      <MissionRecurrenceList instanceId="fixture" projectID={projectID()} scope={scope()} active={active} refresh={refresh()}
        selectedSchedule={missionProjectView(scope()).selectedRecurrence}
        onSelect={id => updateMissionProjectView(scope(), { selectedRecurrence: id === missionProjectView(scope()).selectedRecurrence ? undefined : id })}
        onRead={restoreChat => { if (restoreChat) setStatus(false) }} />
    </aside>
    <main class="mission-transcript-surface" style={{ width: "390px", height: "500px", flex: "none" }}>
      <Show when={readerVisible() && missionProjectView(scope()).reader}><MissionReader instanceId="fixture" scope={scope()} /></Show>
    </main>
    <Show when={!status()}><InterruptionDock instanceId="fixture" sessionId="ses_fixture" active /></Show>
  </div>
}

declare global {
  interface Window {
    passageHistory: { activate(value: boolean): void; readerVisible(value: boolean): void; status(value: boolean): void; refresh(): void; invalidate(): void; project(id: string): void; directory(folder: string): void;
      scheduleChanged(scheduleID: string, revision: number): void; event(type: string, data: Record<string, unknown>, instanceId?: string): void }
  }
}
render(() => <ConfigProvider><I18nProvider><Fixture /></I18nProvider></ConfigProvider>, document.getElementById("root")!)
