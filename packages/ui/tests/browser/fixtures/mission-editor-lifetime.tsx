import { Show, createComputed, createSignal } from "solid-js"
import { render } from "solid-js/web"
import type { WorkspaceEventPayload } from "../../../../server/src/api-types"
import MissionControl from "../../../src/components/instance/shell/right-panel/tabs/MissionControl"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider, useI18n } from "../../../src/lib/i18n"
import { initializeClientState } from "../../../src/stores/client-state"
import { addInstance, instances, updateInstance } from "../../../src/stores/instances"
import { missionStore } from "../../../src/stores/missions"
import { missionProjectView } from "../../../src/stores/mission-view-state"
import { uncertainMissionCreation } from "../../../src/stores/mission-creation-drafts"
import { serverEvents } from "../../../src/lib/server-events"
import "../../../src/index.css"

await initializeClientState()
for (const id of ["fixture", "other"]) addInstance({ id, folder: "/fixture", port: 0, pid: 0, proxyPath: "", status: "ready", client: null,
  metadata: { project: { id: "project", directory: "/fixture", canonical: "/fixture" } } })

function Fixture() {
  const { t } = useI18n()
  const [mounted, mount] = createSignal(true), [active, activate] = createSignal(true), [instanceId, instance] = createSignal("fixture")
  const selectedHistory: Array<string | undefined> = []
  createComputed(() => {
    const selected = missionProjectView(instances().get(instanceId())!.folder).selected
    if (selectedHistory.at(-1) !== selected) selectedHistory.push(selected)
  })
  window.missionEditorLifetime = {
    mount, activate, instance,
    directory: folder => updateInstance(instanceId(), { folder }),
    project: id => updateInstance(instanceId(), { metadata: { project: { id, directory: "/fixture", canonical: "/fixture" } } }),
    invalidate: () => (serverEvents as unknown as { dispatchBatch(events: WorkspaceEventPayload[]): void }).dispatchBatch([
      { type: "instance.event", instanceId: instanceId(), event: { type: "rpc.codenomad.missions.changed", id: "private-changed", created: 1,
        location: { directory: instances().get(instanceId())!.folder }, data: {} } },
    ]),
    invalidateRecurrence: (scheduleID = "rec_fixture") => (serverEvents as unknown as { dispatchBatch(events: WorkspaceEventPayload[]): void }).dispatchBatch([
      { type: "instance.event", instanceId: instanceId(), event: { type: "rpc.codenomad.missions.scheduleChanged", id: "calendar-changed", created: 1,
        location: { directory: instances().get(instanceId())!.folder }, data: { scheduleID, revision: 1 } } },
    ]),
    state: id => missionStore.state(id),
    held: () => uncertainMissionCreation(JSON.stringify([instanceId(), instances().get(instanceId())!.folder, instances().get(instanceId())!.metadata?.project?.id])),
    selectedHistory: () => [...selectedHistory],
  }
  return <aside style={{ width: "370px", height: "100vh", overflow: "auto" }}>
    <Show when={mounted()}><MissionControl instanceId={instanceId()} isActive={active} activeSessionId={() => "ses_fixture"} t={t} /></Show>
  </aside>
}

declare global {
  interface Window {
    missionEditorLifetime: {
      mount(value: boolean): void
      activate(value: boolean): void
      instance(value: string): void
      directory(value: string): void
      project(value: string): void
      invalidate(): void
      invalidateRecurrence(scheduleID?: string): void
      state(id: string): ReturnType<typeof missionStore.state>
      held(): ReturnType<typeof uncertainMissionCreation>
      selectedHistory(): Array<string | undefined>
    }
  }
}
render(() => <ConfigProvider><I18nProvider><Fixture /></I18nProvider></ConfigProvider>, document.getElementById("root")!)
