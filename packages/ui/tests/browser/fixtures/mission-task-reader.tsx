import { Show, createSignal } from "solid-js"
import { render } from "solid-js/web"
import { MissionReader } from "../../../src/components/mission-reader"
import { MissionTaskTree } from "../../../src/components/mission-task-tree"
import { missionTaskConversation } from "../../../src/components/mission-task-navigation"
import type { MissionTask } from "../../../../server/src/api-types"
import { initializeClientState } from "../../../src/stores/client-state"
import { missionProjectView, updateMissionProjectView } from "../../../src/stores/mission-view-state"
import { missionStore } from "../../../src/stores/missions"
import { addInstance, updateInstance } from "../../../src/stores/instances"
import { activeSessionId, seedRestoredSessionSelection, setSessions, sessions } from "../../../src/stores/session-state"
import { sseManager } from "../../../src/lib/sse-manager"
import type { V2Event } from "@opencode/client"
import { applyOpenCodeDataEvent } from "../../../src/stores/opencode-data"
import { sdkManager } from "../../../src/lib/sdk-manager"
import type { Session } from "../../../src/types/session"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import "../../../src/index.css"

await initializeClientState()
const instanceId = "task-reader", scope = "/fixture", proxyPath = `/workspaces/${instanceId}/instance`
addInstance({ id: instanceId, folder: scope, port: 0, pid: 0, status: "ready", proxyPath,
  client: sdkManager.createClient(instanceId, proxyPath, () => true),
  metadata: { project: { id: "project", directory: scope, canonical: scope } } })
const session = (id: string): Session => ({ id, instanceId, parentId: null, title: id, status: "idle", runtimeStatusKnown: true,
  agent: "mutable-session-agent", model: { providerId: "private", modelId: "mutable-model" }, projectID: "project", cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, location: { directory: scope }, time: { created: 1, updated: 1 } })
setSessions(previous => new Map(previous).set(instanceId, new Map(["actor", "coordinator"].map(id => [id, session(id)]))))
seedRestoredSessionSelection(instanceId, null, "coordinator")

function Fixture() {
  const [mounted, mount] = createSignal(true)
  const mission = () => missionStore.state(instanceId).missions[0]
  const show = (itemId: string) => updateMissionProjectView(scope, { reader: { missionId: "mission", kind: "task", itemId } })
  const reading = (task: MissionTask) => { const reader = missionProjectView(scope).reader; return reader?.kind === "task" && reader.itemId === task.id }
  ;(window as any).taskReader = {
    show, refresh: () => missionStore.refresh(instanceId),
    mount,
    conversation: (id: string) => seedRestoredSessionSelection(instanceId, null, id),
    reconnect: () => applyOpenCodeDataEvent(instanceId, scope, { id: "reconnected", type: "server.connected", created: 2, data: {} } as V2Event),
    directory: (folder: string) => updateInstance(instanceId, { folder }),
    removeActor: () => setSessions(previous => new Map(previous).set(instanceId, new Map([["coordinator", session("coordinator")]]))),
    deleteActor: () => (sseManager as unknown as { handleEvent(instanceId: string, event: V2Event): void }).handleEvent(instanceId, {
      id: "deleted-actor", type: "session.deleted", created: 2, location: { directory: scope }, data: { sessionID: "actor" },
      durable: { aggregateID: "actor", seq: 2, version: 1 },
    } as V2Event),
    snapshot: () => ({ view: missionProjectView(scope), active: activeSessionId().get(instanceId),
      actor: sessions().get(instanceId)?.get("actor"), parent: sessions().get(instanceId)?.get("native-parent") }),
  }
  void missionStore.ensure(instanceId)
  return <div style={{ display: "grid", "grid-template-columns": "minmax(0, 1fr) 390px", height: "800px" }}>
    <main class="mission-transcript-surface">
      <textarea id="draft" /><div id="transcript" style={{ height: "70px", overflow: "auto" }}><div style={{ height: "500px" }}>Retained transcript</div></div>
      <Show when={mounted() && missionProjectView(scope).reader}><MissionReader instanceId={instanceId} scope={scope} /></Show>
    </main>
    <aside class="mission-control" style={{ overflow: "auto" }}><Show when={mission()}>{value =>
      <MissionTaskTree mission={value()} instanceId={instanceId} activity={missionStore.state(instanceId).activity?.missions[0]?.actors}
        reading={reading} onRead={task => show(task.id)} onRecoveryAdmitted={() => missionStore.refresh(instanceId)}
        conversation={task => missionTaskConversation(value(), task, missionStore.state(instanceId).activity?.missions[0]?.family)}
        onOpenConversation={id => { (window as any).openedConversations = [...(window as any).openedConversations ?? [], id] }} />
    }</Show></aside>
  </div>
}
render(() => <ConfigProvider><I18nProvider><Fixture /></I18nProvider></ConfigProvider>, document.getElementById("root")!)
