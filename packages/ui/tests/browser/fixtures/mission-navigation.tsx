import { Show, createSignal } from "solid-js"
import { render } from "solid-js/web"
import type { V2Event } from "@opencode/client"
import MissionControl from "../../../src/components/instance/shell/right-panel/tabs/MissionControl"
import { MissionReader } from "../../../src/components/mission-reader"
import { initializeClientState } from "../../../src/stores/client-state"
import { missionProjectView } from "../../../src/stores/mission-view-state"
import { addInstance, instances, updateInstance } from "../../../src/stores/instances"
import { activeSessionId, clearActiveSession, seedRestoredSessionSelection, setSessions } from "../../../src/stores/session-state"
import type { Session } from "../../../src/types/session"
import { sdkManager } from "../../../src/lib/sdk-manager"
import { sseManager } from "../../../src/lib/sse-manager"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider, useI18n } from "../../../src/lib/i18n"
import "../../../src/index.css"
import { markSessionListsRestored } from "./session-list-restored"

await initializeClientState()
markSessionListsRestored("fixture", "replacement")
for (const id of ["fixture", "replacement"]) {
  const proxyPath = `/workspaces/${id}/instance`
  const client = sdkManager.createClient(id, proxyPath, () => true)
  addInstance({ id, folder: "/fixture", port: 0, pid: 0, status: "ready", proxyPath, client,
    metadata: { project: { id: "project", directory: "/fixture", canonical: "/fixture" } } })
}
function seed(instanceId: string, ids: string[]) {
  const entries = ids.map(id => [id, { id, instanceId, parentId: null, title: id, status: "idle", runtimeStatusKnown: true,
    agent: "build", model: { providerId: "private", modelId: "private" }, projectID: "project", cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    location: { directory: "/fixture" }, time: { created: 1, updated: 1 } } satisfies Session] as const)
  setSessions(previous => new Map(previous).set(instanceId, new Map(entries)))
}
seed("fixture", ["ses_B"]); seed("replacement", ["ses_A", "ses_B"])
seedRestoredSessionSelection("fixture", null, "ses_B"); seedRestoredSessionSelection("replacement", null, "ses_B")

function Fixture() {
  const { t } = useI18n()
  const [mounted, mount] = createSignal(true), [active, activate] = createSignal(true), [instanceId, instance] = createSignal("fixture")
  const [reveals, reveal] = createSignal(0)
  const scope = () => instances().get(instanceId())!.folder
  window.missionNavigation = {
    mount, activate, instance,
    directory: folder => updateInstance(instanceId(), { folder }),
    project: id => updateInstance(instanceId(), { metadata: { project: { id, directory: scope(), canonical: scope() } } }),
    clearActive: () => clearActiveSession(instanceId()),
    created: (id, target = "fixture") => (sseManager as unknown as { handleEvent(instanceId: string, event: V2Event): void }).handleEvent(target, {
      type: "session.created", id: `private-${id}`, created: 1, location: { directory: instances().get(target)!.folder },
      data: { sessionID: id, projectID: "project", slug: id, location: { directory: instances().get(target)!.folder },
        title: id, version: "1", metadata: {} }, durable: { aggregateID: id, seq: 1, version: 1 },
    }),
    snapshot: () => ({ instanceId: instanceId(), scope: scope(), selectedSession: activeSessionId().get(instanceId()) ?? null,
      view: missionProjectView(scope()), reveals: reveals() }),
  }
  return <div style={{ display: "grid", "grid-template-columns": "minmax(0,1fr) 390px", height: "100vh" }}>
    <main class="mission-transcript-surface" style={{ "min-width": 0, overflow: "hidden" }}><p>Private chat surface</p><Show when={missionProjectView(scope()).reader}><MissionReader instanceId={instanceId()} scope={scope()} /></Show>
      <output data-testid="navigation-state">{JSON.stringify(window.missionNavigation.snapshot())}</output></main>
    <aside style={{ overflow: "auto" }}><Show when={mounted()}><MissionControl instanceId={instanceId()} isActive={active}
      activeSessionId={() => activeSessionId().get(instanceId()) ?? null} t={t} onRevealConversation={() => reveal(value => value + 1)} /></Show></aside>
  </div>
}
declare global {
  interface Window {
    missionNavigation: {
      mount(value: boolean): void; activate(value: boolean): void; instance(value: string): void
      directory(value: string): void; project(value: string): void; clearActive(): void
      created(id: string, instanceId?: string): void
      snapshot(): { instanceId: string; scope: string; selectedSession: string | null; view: ReturnType<typeof missionProjectView>; reveals: number }
    }
  }
}
render(() => <ConfigProvider><I18nProvider><Fixture /></I18nProvider></ConfigProvider>, document.getElementById("root")!)
