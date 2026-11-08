import { createMemo, createSignal } from "solid-js"
import { render } from "solid-js/web"
import SessionList from "../../../src/components/session-list"
import { ConfigProvider, updatePreferences } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { serverApi } from "../../../src/lib/api-client"
import { serverEvents } from "../../../src/lib/server-events"
import { sdkManager } from "../../../src/lib/sdk-manager"
import { addInstance } from "../../../src/stores/instances"
import { activeSessionId, getSessionThreads, sessions, setActiveSession, setSessions, setSessionPage } from "../../../src/stores/session-state"
import { createClientSession } from "../../../src/types/session"
import { ensureWorktreesLoaded } from "../../../src/stores/worktrees"
import "../../../src/index.css"

const id = "session-archives-fixture"
const make = (sessionId: string, parentID?: string) => ({ id: sessionId, parentID, title: sessionId, agent: "build", projectID: "fixture",
  location: { directory: "/repo" }, model: { providerID: "fixture", id: "fixture" }, cost: 0, tokens: {}, time: { created: 1, updated: 1 } })
const native = new Map<string, any>(["keep", "done", "old", "child"].map(key => [key, make(key, key === "child" ? "done" : undefined)]))
native.get("old").time.archived = 10
const writes: unknown[] = [], lists: unknown[] = []
let sequence = 10, failWrite = false
const event = (sessionID: string, archived: boolean) => {
  const row = native.get(sessionID), created = ++sequence
  row.time = { created: 1, updated: created, ...(archived ? { archived: created } : {}) }
  ;(serverEvents as any).dispatchBatch([{ type: "instance.event", instanceId: id, event: {
    id: `evt_${crypto.randomUUID()}`, type: archived ? "session.archived" : "session.unarchived", created,
    location: { directory: "/repo" }, data: { sessionID }, durable: { aggregateID: sessionID, seq: sequence, version: 1 },
  } }])
}
const client: any = { session: {
  list: async (input: any) => { lists.push(input); return { data: [...native.values()].filter(row =>
    (input.parentID !== null || !row.parentID) && (!input.search || row.title.includes(input.search))), cursor: {} } },
  get: async ({ sessionID }: any) => structuredClone(native.get(sessionID)),
  active: async () => ({}),
  update: async (input: any) => { writes.push(input); if (failWrite) throw new Error("Fixture write refused"); event(input.sessionID, input.archived) },
} }
;(sdkManager as any).clients.set(`${id}:/workspaces/${id}/instance`, client)
const config = { settings: { locale: "en" } }
serverApi.fetchConfigOwner = async () => config as any
serverApi.patchConfigOwner = async (_owner, patch) => Object.assign(config, patch) as any
serverApi.fetchStateOwner = async () => ({} as any)
serverApi.fetchWorktrees = async () => ({ isGitRepo: false, worktrees: [] })
addInstance({ id, folder: "/repo", port: 0, pid: 0, proxyPath: `/workspaces/${id}/instance`, status: "ready", client })
setSessions(previous => new Map(previous).set(id, new Map([...native.values()].map(row => [row.id,
  createClientSession(row, id, "build", { providerId: "fixture", modelId: "fixture" })]))))
setSessionPage(id, ["keep", "done", "old"], false, true)
setActiveSession(id, "keep")
await ensureWorktreesLoaded(id)
const [filter, setFilter] = createSignal(false)
function Fixture() {
  const threads = createMemo(() => getSessionThreads(id))
  return <ConfigProvider><I18nProvider><div style={{ width: "680px", height: "650px", display: "flex" }}>
    <SessionList instanceId={id} threads={threads()} activeSessionId={activeSessionId().get(id) ?? null}
      onSelect={value => setActiveSession(id, value)} onNew={() => {}} enableFilterBar={filter()} showHeader={false} showFooter={false} />
  </div></I18nProvider></ConfigProvider>
}
render(() => <Fixture />, document.getElementById("root")!)
await updatePreferences({ locale: "en" })
;(window as any).fixture = { writes, lists, event, setFilter, fail: (value: boolean) => { failWrite = value },
  flags: () => [...native].map(([key, value]) => [key, value.time.archived]),
  selected: () => activeSessionId().get(id), current: () => sessions().get(id)?.get("done") }
