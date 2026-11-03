import { createMemo, createSignal } from "solid-js"
import { render } from "solid-js/web"
import SessionList from "../../../src/components/session-list"
import SessionView from "../../../src/components/session/session-view"
import { ConfigProvider, updatePreferences } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { serverApi } from "../../../src/lib/api-client"
import { sdkManager } from "../../../src/lib/sdk-manager"
import { sseManager } from "../../../src/lib/sse-manager"
import { addInstance } from "../../../src/stores/instances"
import { sessions, setActiveSession, setProviders, setSessionPage, setSessions, withSession } from "../../../src/stores/session-state"
import { buildSessionThreadsFromMap } from "../../../src/stores/session-tree"
import type { Session } from "../../../src/types/session"
import "../../../src/index.css"

// Real session list, conversation view and native event dispatcher; only HTTP is fake.
const id = "session-status-clear-fixture"
const model = { providerID: "fixture", id: "fixture" }
let time = 100
function make(sessionId: string, updated: number, state: Partial<Session> = {}, parentId: string | null = null): Session {
  return {
    id: sessionId, title: sessionId, instanceId: id, parentId, location: { directory: "/repo" }, status: "idle", agent: "build",
    retry: null, idleSince: null, generationRecovery: null, runtimeStatusKnown: true, version: "1",
    projectID: "fixture", cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated, idle: 10 }, model: { providerId: "fixture", modelId: "fixture" }, ...state,
  } as Session
}
const interrupted = { generationRecovery: "interrupted", outcome: "interrupted", idleSince: null } as const
const roots = ["viewed", "idle-a", "interrupted-b", "working-c", "permission-d", "question-d", "idle-e", "parent-f", "parent-g"]
const items = [
  make("viewed", 9),
  make("idle-a", 8, { idleSince: 5 }),
  make("interrupted-b", 7, interrupted),
  make("working-c", 6, { status: "working" }),
  make("permission-d", 5, { pendingPermission: true }),
  make("question-d", 4.5, { pendingForm: true }),
  make("idle-e", 4, { idleSince: 5 }),
  make("parent-f", 3),
  make("f-1", 3, { idleSince: 5 }, "parent-f"),
  make("f-2", 3, interrupted, "parent-f"),
  make("parent-g", 2),
  make("g-1", 2, interrupted, "parent-g"),
  ...Array.from({ length: 24 }, (_, index) => make(`extra-${index}`, 1 - index)),
]
roots.push(...items.filter(item => item.id.startsWith("extra-")).map(item => item.id))
const client: any = {
  session: { active: async () => ({}), inbox: { list: async () => ({ data: [] }) },
    get: async ({ sessionID }: any) => sessions().get(id)?.get(sessionID),
    instructions: { entry: { remove: async () => {}, put: async () => {} } },
  },
  model: { default: async () => ({ data: model }) },
  message: { list: async () => ({ data: [], cursor: {} }) },
}
let uiConfig = { settings: { locale: "en" } }
serverApi.fetchConfigOwner = async () => uiConfig as any
serverApi.patchConfigOwner = async (_owner, patch: any) => {
  uiConfig = { ...uiConfig, ...patch, settings: { ...uiConfig.settings, ...patch.settings } }
  return uiConfig as any
}
serverApi.fetchStateOwner = async () => ({} as any)
serverApi.fetchWorktrees = async () => ({ isGitRepo: false, worktrees: [] })
;(sdkManager as any).clients.set(`${id}:/workspaces/${id}/instance`, client)
addInstance({ id, folder: "/repo", port: 0, pid: 0, proxyPath: `/workspaces/${id}/instance`, status: "ready", client })
setSessions(previous => new Map(previous).set(id, new Map(items.map(item => [item.id, item]))))
setProviders(prev => new Map(prev).set(id, [{ id: "fixture", name: "Fixture", models: [{ id: "fixture", name: "Fixture", providerId: "fixture", limit: { context: 10000, output: 1000 }, cost: { input: 0, output: 0 } }] }]))
setSessionPage(id, roots, false, true)
setActiveSession(id, "viewed")
const [active, setActive] = createSignal("viewed")
const selected: string[] = []
function Fixture() {
  const threads = createMemo(() => buildSessionThreadsFromMap(sessions().get(id)!, roots))
  return <ConfigProvider><I18nProvider><ThemeProvider><div style={{ display: "flex", height: "520px" }}>
    <div style={{ width: "440px", display: "flex" }}>
      <SessionList instanceId={id} threads={threads()} activeSessionId={active()}
        onSelect={value => { selected.push(value); setActive(value); setActiveSession(id, value) }}
        onNew={() => {}} enableFilterBar={false} showHeader={false} showFooter={false} />
    </div>
    <div style={{ flex: "1", display: "flex", "min-width": "0" }}>
      <SessionView sessionId={active()} activeSessions={sessions().get(id)!} instanceId={id} instanceFolder="/repo" escapeInDebounce={false} isActive={true} />
    </div>
  </div></ThemeProvider></I18nProvider></ConfigProvider>
}
render(() => <Fixture />, document.getElementById("root")!)
await updatePreferences({ locale: "en", keepUnseenSubagentIdleStatus: true })
;(window as any).fixture = {
  selected,
  session: (sessionId: string) => sessions().get(id)?.get(sessionId),
  // A refresh, reconnect or rehydration republishes the same native facts as a new object.
  refresh: (sessionId: string) => setSessions(previous => {
    const next = new Map(previous), entries = new Map(next.get(id))
    const current = entries.get(sessionId)!
    entries.set(sessionId, { ...current, generationRecovery: "interrupted", outcome: "interrupted", time: { ...current.time } })
    next.set(id, entries)
    return next
  }),
  // A new native interruption: the run starts, then OpenCode reports it interrupted.
  interrupt: (sessionID: string) => {
    for (const type of ["session.execution.started", "session.execution.interrupted"]) {
      ;(sseManager as any).handleEvent(id, {
        id: `evt_clear_${++time}`, type, created: time, location: { directory: "/repo" },
        durable: { aggregateID: sessionID, seq: time, version: 1 },
        data: { sessionID, ...(type.endsWith("interrupted") ? { reason: "user" } : {}) },
      })
    }
  },
  pending: (sessionId: string, field: "pendingPermission" | "pendingForm", value: boolean) => withSession(id, sessionId, session => { session[field] = value }),
  status: (sessionId: string, status: Session["status"]) => withSession(id, sessionId, session => { session.status = status }),
  idle: (sessionId: string) => withSession(id, sessionId, session => { session.idleSince = Date.now() }),
}
