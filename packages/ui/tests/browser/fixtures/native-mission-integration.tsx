import { For, Show, createSignal } from "solid-js"
import { render } from "solid-js/web"
import type { SessionInfo, V2Event } from "@opencode/client"
import type { MissionSnapshot } from "../../../../server/src/missions/model"
import type { WorkspaceEventPayload } from "../../../../server/src/api-types"
import MissionControl from "../../../src/components/instance/shell/right-panel/tabs/MissionControl"
import { MissionReader } from "../../../src/components/mission-reader"
import { initializeClientState } from "../../../src/stores/client-state"
import { missionProjectView, updateMissionProjectView } from "../../../src/stores/mission-view-state"
import { isMissionActivityEvent, isMissionChangedEvent, missionStore } from "../../../src/stores/missions"
import { addInstance } from "../../../src/stores/instances"
import { setInstanceMetadata } from "../../../src/stores/instance-metadata"
import { activeParentSessionId, activeSessionId, fetchSessions, sessions, setActiveSessionFromList } from "../../../src/stores/sessions"
import { sdkManager } from "../../../src/lib/sdk-manager"
import { serverEvents } from "../../../src/lib/server-events"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider, useI18n } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import "../../../src/index.css"

export interface NativeMissionCapture {
  version: 1
  transport: "captured-native-fixture"
  rootID: string
  // The client exports the encoded native wire union as V2Event.
  frames: Array<{ label: string; snapshot: MissionSnapshot; sessions: SessionInfo[]; events: V2Event[] }>
}

// Fixture transport only: replay private-run captures, never contact a native daemon/auth bridge.
const capture: NativeMissionCapture = await fetch("/__native_capture").then(response => response.json())
const first = capture.frames.find(frame => frame.label === "initial")!
const coordinator = first.sessions.find(session => session.id === capture.rootID)!
const instanceId = "captured-native-fixture", scope = coordinator.location.directory
await initializeClientState()
const proxyPath = `/workspaces/${instanceId}/instance`
const client = sdkManager.createClient(instanceId, proxyPath, () => true)
const metadata = { project: { id: coordinator.projectID, directory: scope, canonical: scope } }
addInstance({ id: instanceId, folder: scope, port: 0, pid: 0, proxyPath, status: "ready", client,
  metadata })
// Catalog enrichment reads the separate metadata store, not Instance.metadata.
setInstanceMetadata(instanceId, metadata)
await fetchSessions(instanceId, { reset: true })
setActiveSessionFromList(instanceId, capture.rootID)

function Fixture() {
  const { t } = useI18n()
  const [label, setLabel] = createSignal("initial")
  const [transportMode, setTransportMode] = createSignal("initial-read")
  const [replayed, setReplayed] = createSignal(0)
  const snapshot = () => ({ label: label(), transport: capture.transport, transportMode: transportMode(), replayedEvents: replayed(),
    selectedID: activeSessionId().get(instanceId) ?? null, selectedRootID: activeParentSessionId().get(instanceId) ?? null,
    sessions: [...(sessions().get(instanceId)?.values() ?? [])].map(session => ({ id: session.id, parentID: session.parentId })),
    missions: missionStore.state(instanceId).missions, reader: missionProjectView(scope).reader ?? null })
  window.nativeMissionIntegration = {
    snapshot,
    async replay(nextLabel) {
      const frame = capture.frames.find(frame => frame.label === nextLabel)
      if (!frame) throw new Error(`Missing captured frame: ${nextLabel}`)
      const response = await fetch(`/__native_frame?label=${encodeURIComponent(nextLabel)}`, { method: "POST" })
      if (!response.ok) throw new Error(await response.text())
      // Enter the existing CodeNomad publisher; its registered subscribers drive
      // missions.ts invalidation and sse-manager -> sessions.ts native dispatch.
      ;(serverEvents as unknown as { dispatchBatch(events: WorkspaceEventPayload[]): void }).dispatchBatch(
        frame.events.map(event => ({ type: "instance.event", instanceId, event }) as WorkspaceEventPayload))
      setReplayed(value => value + frame.events.length)
      await fetchSessions(instanceId, { reset: true })
      const invalidates = frame.events.some(event => isMissionChangedEvent(event) || isMissionActivityEvent(event) || event.type === "plugin.updated")
      setTransportMode(invalidates ? "captured-event-invalidation" : "explicit-display-refresh-no-captured-invalidation")
      // ponytail: captures without an invalidation use the existing explicit
      // display refresh; never synthesize a missions.changed event.
      if (!invalidates) await missionStore.refresh(instanceId)
      setLabel(nextLabel)
    },
  }
  const navigate = (id: string) => {
    setActiveSessionFromList(instanceId, id)
    updateMissionProjectView(scope, { reader: undefined })
  }
  return <div style={{ display: "grid", "grid-template-columns": "minmax(0, 1fr) 420px", height: "100vh" }}>
    <main class="mission-transcript-surface" style={{ display: "flex", "flex-direction": "column", "min-height": "0", "min-width": "0" }}>
      <header class="window-header"><h1 class="window-title">Captured native fixture transport</h1><output data-testid="frame-label">{label()}</output></header>
      <nav aria-label="Captured native session navigation" style={{ overflow: "auto", "max-height": "220px" }}>
        <For each={[...(sessions().get(instanceId)?.values() ?? [])]}>{session =>
          <button type="button" class="mission-inline-session" data-native-session-id={session.id}
            data-native-parent-id={session.parentId ?? ""} aria-pressed={activeSessionId().get(instanceId) === session.id}
            onClick={() => navigate(session.id)}>{session.title} <code>{session.id}</code></button>
        }</For>
      </nav>
      <Show when={missionProjectView(scope).reader}><MissionReader instanceId={instanceId} scope={scope} /></Show>
      <output data-testid="selected-session">{activeSessionId().get(instanceId)}</output>
    </main>
    <aside class="right-panel" style={{ overflow: "auto", width: "420px", "min-height": "0" }}>
      <MissionControl instanceId={instanceId} isActive={() => true} activeSessionId={() => activeSessionId().get(instanceId) ?? null} t={t} />
    </aside>
  </div>
}

declare global {
  interface Window {
    nativeMissionIntegration: {
      snapshot(): { label: string; transport: string; transportMode: string; replayedEvents: number; selectedID: string | null;
        selectedRootID: string | null; sessions: Array<{ id: string; parentID: string | null }>; missions: MissionSnapshot["missions"];
        reader: ReturnType<typeof missionProjectView>["reader"] | null }
      replay(label: string): Promise<void>
    }
    nativeMissionCopiedText?: string
  }
}
render(() => <ConfigProvider><I18nProvider><ThemeProvider><Fixture /></ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
