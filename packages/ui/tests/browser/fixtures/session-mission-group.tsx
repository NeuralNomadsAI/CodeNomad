import { createMemo, createSignal } from "solid-js"
import { render } from "solid-js/web"
import SessionList from "../../../src/components/session-list"
import { ConfigProvider, updatePreferences } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { serverApi } from "../../../src/lib/api-client"
import { sdkManager } from "../../../src/lib/sdk-manager"
import { addInstance } from "../../../src/stores/instances"
import { getVisibleSessionIds, sessions, setSessions, setSessionPage } from "../../../src/stores/session-state"
import { buildSessionThreadsFromMap } from "../../../src/stores/session-tree"
import { flushClientState, initializeClientState } from "../../../src/stores/client-state"
import type { Session } from "../../../src/types/session"
import "../../../src/index.css"

const id = "session-mission-group-fixture"
function make(sessionId: string, title: string, updated: number, parentId: string | null = null, mission?: { missionID: string; kind: string }): Session {
  return { id: sessionId, title, instanceId: id, parentId, location: { directory: "/repo" }, status: "idle", agent: "build",
    projectID: "fixture", cost: 0, tokens: {}, time: { created: 1, updated }, model: { providerId: "fixture", modelId: "fixture" },
    ...(mission ? { metadata: { "codenomad.mission": { version: 1, role: "fixture", ...mission } } } : {}) } as Session
}
const items = [
  make("user-a", "My own conversation", 10),
  make("user-a-child", "Ordinary subagent", 9, "user-a"),
  make("coord", "Mission coordinator: Livrer une application", 5, null, { missionID: "msn_1", kind: "coordinator" }),
  make("task", "Mission · implementer: Build the UI", 6, null, { missionID: "msn_1", kind: "actor" }),
  make("task-child", "Native helper", 4, "task"),
  make("coord2", "Mission coordinator: Second objective", 3, null, { missionID: "msn_2", kind: "coordinator" }),
  make("orphan-task", "Mission · reviewer: Orphaned task", 2, null, { missionID: "msn_3", kind: "actor" }),
]
const roots = ["user-a", "coord", "task", "coord2", "orphan-task"]
const client: any = { session: {
  list: async (input: any) => ({ data: items.filter(item => item.title.toLowerCase().includes(input.search ?? ""))
    .map(item => ({ ...item, parentID: item.parentId })), cursor: {} }),
  get: async () => { throw new Error("unexpected read") },
} }
;(sdkManager as any).clients.set(`${id}:/workspaces/${id}/instance`, client)
const uiConfig = { settings: { locale: "en" } }
serverApi.fetchConfigOwner = async () => uiConfig as any
serverApi.patchConfigOwner = async (_owner, patch) => Object.assign(uiConfig, patch) as any
serverApi.fetchStateOwner = async () => ({} as any)
serverApi.fetchWorktrees = async () => ({ isGitRepo: false, worktrees: [] })
addInstance({ id, folder: "/repo", port: 0, pid: 0, proxyPath: `/workspaces/${id}/instance`, status: "ready", client })
setSessions(previous => new Map(previous).set(id, new Map(items.map(item => [item.id, item]))))
setSessionPage(id, roots, false, true)
// Layout persistence uses the native client-state host stubbed by the test.
await initializeClientState()
const [searchMode, setSearchMode] = createSignal(false)
const [active, setActive] = createSignal<string | null>(null)
function patch(sessionId: string, value: Partial<Session>) {
  setSessions(previous => {
    const next = new Map(previous), instance = new Map(next.get(id))
    instance.set(sessionId, { ...instance.get(sessionId)!, ...value })
    return next.set(id, instance)
  })
}
function Fixture() {
  const threads = createMemo(() => buildSessionThreadsFromMap(sessions().get(id)!, roots))
  return <ConfigProvider><I18nProvider><div style={{ width: "440px", height: "650px", display: "flex" }}>
    <SessionList instanceId={id} threads={threads()} activeSessionId={active()} onSelect={setActive}
      onNew={() => {}} enableFilterBar={searchMode()} showHeader={false} showFooter={false} />
  </div></I18nProvider></ConfigProvider>
}
render(() => <Fixture />, document.getElementById("root")!)
await updatePreferences({ locale: "en" })
;(window as any).fixture = { setSearchMode, setActive, patch, visible: () => getVisibleSessionIds(id), flush: flushClientState }
