import { createComputed } from "solid-js"
import { render } from "solid-js/web"
import type { V2Event } from "@opencode/client"
import InstanceShell from "../../../src/components/instance/instance-shell2"
import { RIGHT_PANEL_TAB_STORAGE_KEY } from "../../../src/components/instance/shell/storage"
import { initializeClientState, writeClientLayoutValue } from "../../../src/stores/client-state"
import { missionProjectView } from "../../../src/stores/mission-view-state"
import { activeSessionId, clearActiveSession, seedRestoredSessionSelection, setSessionPage, setSessions, setMessagesLoaded } from "../../../src/stores/session-state"
import type { Session } from "../../../src/types/session"
import { addInstance, instances } from "../../../src/stores/instances"
import { ensureWorktreesLoaded } from "../../../src/stores/worktrees"
import { clearSessionCatalogState, refreshSessionCatalog } from "../../../src/stores/session-api"
import { openSessionPreview, showSessionChatFor, getSessionPreview } from "../../../src/stores/session-previews"
import { sdkManager } from "../../../src/lib/sdk-manager"
import { sseManager } from "../../../src/lib/sse-manager"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import "../../../src/index.css"
import { markSessionListsRestored } from "./session-list-restored"

await initializeClientState()
writeClientLayoutValue(RIGHT_PANEL_TAB_STORAGE_KEY, "missions")
const id = "cross-navigation", scope = "/fixture", client = sdkManager.createClient(id, `/workspaces/${id}/instance`, () => true)
addInstance({ id, folder: scope, port: 0, pid: 0, proxyPath: `/workspaces/${id}/instance`, status: "ready", client,
  metadata: { project: { id: "project", directory: scope, canonical: scope } } })
const initial = ["initial", "B"].map(name => ({ id: `ses_${name}`, instanceId: id, parentId: null, title: `Conversation ${name}`,
  agent: "build", model: { providerId: "private", modelId: "private" }, projectID: "project", cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, status: "idle", runtimeStatusKnown: true,
  location: { directory: scope }, time: { created: 1, updated: 1 } } satisfies Session))
setSessions(previous => new Map(previous).set(id, new Map(initial.map(session => [session.id, session]))))
setSessionPage(id, initial.map(session => session.id), false, true)
seedRestoredSessionSelection(id, "ses_initial", "ses_initial")
// Settle restoration only after the simulated first page and selection exist.
markSessionListsRestored(id)
setMessagesLoaded(previous => new Map(previous).set(id, new Set(initial.map(session => session.id))))
await ensureWorktreesLoaded(id)
await openSessionPreview("ses_initial", "https://example.invalid/", scope)
showSessionChatFor("ses_initial", scope)

// Previews are per conversation; follow the one opened for the initial conversation.
const initialPreview = () => getSessionPreview("ses_initial", scope)
const snapshot = () => ({ session: activeSessionId().get(id) ?? null, mode: initialPreview()?.mode ?? null,
  previewSession: initialPreview()?.sessionId, previewUrl: initialPreview()?.targetUrl,
  reader: missionProjectView(scope).reader ?? null })
const history: ReturnType<typeof snapshot>[] = []
function Fixture() {
  createComputed(() => {
    const next = snapshot()
    if (JSON.stringify(next) !== JSON.stringify(history.at(-1))) history.push(next)
  })
  window.missionCrossNavigation = {
    snapshot, history: () => [...history],
    coldCatalogue: async () => {
      // Drain this fixture's read before clearing its display marker. This never
      // cancels a shared read and does not change any product cache policy.
      await refreshSessionCatalog(id, true)
      clearSessionCatalogState(id)
    },
    clearActive: () => clearActiveSession(id),
    created: () => (sseManager as unknown as { handleEvent(instanceId: string, event: V2Event): void }).handleEvent(id, {
      type: "session.created", id: "private-created-A", created: 1, location: { directory: scope },
      durable: { aggregateID: "ses_A", seq: 1, version: 1 },
      data: { sessionID: "ses_A", projectID: "project", location: { directory: scope }, slug: "A", title: "Conversation A", version: "1" },
    }),
  }
  return <div style={{ height: "100vh", display: "flex", "flex-direction": "column" }}>
    <InstanceShell instance={instances().get(id)!} isActiveInstance escapeInDebounce={false} paletteCommands={() => []}
      onExecuteCommand={() => {}} onCloseSession={() => {}} onNewSession={() => {}}
      handleSidebarAgentChange={async () => {}} handleSidebarModelChange={async () => {}} tabBarOffset={0}
      mobileFullscreenMode={false} onEnterMobileFullscreen={() => {}} onExitMobileFullscreen={() => {}} />
  </div>
}
declare global {
  interface Window {
    missionCrossNavigation: {
      snapshot(): ReturnType<typeof snapshot>; history(): ReturnType<typeof snapshot>[]
      coldCatalogue(): Promise<void>; clearActive(): void; created(): void
    }
  }
}
render(() => <ConfigProvider><I18nProvider><ThemeProvider><Fixture /></ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
