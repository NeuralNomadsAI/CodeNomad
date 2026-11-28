import { createMemo } from "solid-js"
import { render } from "solid-js/web"
import SessionList from "../../../src/components/session-list"
import { ConfigProvider, updatePreferences } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { serverApi } from "../../../src/lib/api-client"
import { serverEvents } from "../../../src/lib/server-events"
import { OpenCode } from "@opencode/client"
import { buildInstanceBaseUrl, createInstanceFetch, sdkManager } from "../../../src/lib/sdk-manager"
import { addInstance } from "../../../src/stores/instances"
import { setInstanceMetadata } from "../../../src/stores/instance-metadata"
import { activeSessionId, getInstanceSessionIndicatorStatusCached, getSessionListError, getSessionThreads, setActiveSession, setSessions, setSessionStatus } from "../../../src/stores/session-state"
import { createClientSession } from "../../../src/types/session"
import { fetchSessions } from "../../../src/stores/session-api"
import { ensureWorktreesLoaded } from "../../../src/stores/worktrees"
import "../../../src/index.css"

// Two project tabs over one native service. Each client answers like its
// workspace proxy: a session located elsewhere is refused with 403.
const workspaces = { a: "/projects/a", b: "/projects/b" } as const
type Tab = keyof typeof workspaces
const make = (id: string, directory: string, parentID?: string) => ({ id, parentID, title: id, agent: "build",
  projectID: directory, location: { directory }, model: { providerID: "fixture", id: "fixture" }, cost: 0, tokens: {},
  time: { created: 1, updated: 1 } })
const native = new Map<string, any>([
  make("moving", workspaces.a), make("moving-child", workspaces.a, "moving"), make("staying", workspaces.a),
  make("staying-child", workspaces.a, "staying"), make("resident", workspaces.b),
].map(row => [row.id, row]))
// "?moved": a fresh page after the conversation already moved to project b.
if (new URL(location.href).searchParams.has("moved")) Object.assign(native.get("moving"), { location: { directory: workspaces.b }, projectID: workspaces.b })
const owns = (tab: Tab, row: any) => row.location.directory === workspaces[tab]
const instanceId = (tab: Tab) => `external-move-${tab}`
// Reads of a session located elsewhere go through the real instance adapter
// to the routed workspace proxy, which refuses them.
const proxied = (tab: Tab) => {
  const baseUrl = buildInstanceBaseUrl(`/workspaces/${instanceId(tab)}/instance`, location.origin)
  return OpenCode.make({ baseUrl, fetch: createInstanceFetch(baseUrl) })
}
const client = (tab: Tab): any => ({ session: {
  list: async (input: any) => ({ cursor: {}, data: [...native.values()].map(row => structuredClone(row)).filter(row =>
    (input.project ? row.projectID === input.project : row.location.directory === input.directory)
    && (input.parentID !== null || !row.parentID)) }),
  get: async ({ sessionID }: any, options?: any) => {
    const row = native.get(sessionID)
    return row && !owns(tab, row) ? proxied(tab).session.get({ sessionID }, options) : structuredClone(row)
  },
  active: async () => ({}),
} })
serverApi.fetchWorktrees = async (id: string) => {
  const tab = (Object.keys(workspaces) as Tab[]).find(key => instanceId(key) === id)!
  return { isGitRepo: true, worktrees: [{ slug: "root", directory: workspaces[tab], kind: "root" }] } as any
}
const config = { settings: { locale: "en" } }
serverApi.fetchConfigOwner = async () => config as any
serverApi.patchConfigOwner = async (_owner, patch) => Object.assign(config, patch) as any
serverApi.fetchStateOwner = async () => ({} as any)
for (const tab of Object.keys(workspaces) as Tab[]) {
  const id = instanceId(tab), sessionClient = client(tab)
  ;(sdkManager as any).clients.set(`${id}:/workspaces/${id}/instance`, sessionClient)
  addInstance({ id, folder: workspaces[tab], port: 0, pid: 0, proxyPath: `/workspaces/${id}/instance`, status: "ready", client: sessionClient })
  setInstanceMetadata(id, { project: { id: workspaces[tab], canonical: workspaces[tab] } as any })
  await ensureWorktreesLoaded(id)
  await fetchSessions(id, { reset: true }).catch(() => undefined)
}
if (native.get("moving").location.directory === workspaces.a) setActiveSession(instanceId("a"), "moving")

let sequence = 10
/** A native move outside CodeNomad: only the session itself changes location.
 * The relay delivers it to every tab owning its old or new location. */
const move = (sessionID: string, directory: string) => {
  const row = native.get(sessionID), from = row.location.directory, created = ++sequence
  row.location = { directory }
  row.projectID = directory
  const event = { id: `evt_move_${created}`, type: "session.moved", created, location: { directory: from },
    data: { sessionID, projectID: directory, location: { directory } }, durable: { aggregateID: sessionID, seq: created, version: 1 } }
  const recipients = (Object.keys(workspaces) as Tab[]).filter(tab => workspaces[tab] === from || workspaces[tab] === directory)
  ;(serverEvents as any).dispatchBatch(recipients.map(tab => ({ type: "instance.event", instanceId: instanceId(tab), event })))
}

function Tab(props: { tab: Tab }) {
  const id = instanceId(props.tab)
  const threads = createMemo(() => getSessionThreads(id))
  return <section aria-label={`Project ${props.tab}`} style={{ width: "420px", height: "600px", display: "flex" }}>
    <SessionList instanceId={id} threads={threads()} activeSessionId={activeSessionId().get(id) ?? null}
      onSelect={value => setActiveSession(id, value)} onNew={() => {}} showHeader={false} showFooter={false} />
  </section>
}
render(() => <ConfigProvider><I18nProvider><div style={{ display: "flex", gap: "8px" }}>
  <Tab tab="a" /><Tab tab="b" />
</div></I18nProvider></ConfigProvider>, document.getElementById("root")!)
await updatePreferences({ locale: "en" })
/** Tab A receives a working child of "staying", as from a live event. */
const holdChild = (directory: string) => {
  const id = instanceId("a"), row = make("busy-child", directory, "staying")
  native.set(row.id, row)
  setSessions(previous => new Map(previous).set(id, new Map(previous.get(id)).set(row.id,
    createClientSession(row as any, id, "build", { providerId: "fixture", modelId: "fixture" }))))
  setSessionStatus(id, row.id, "working")
}
;(window as any).fixture = { move, holdChild,
  childActivity: (sessionId: string) => document.querySelector(`[data-session-id="${sessionId}"] .session-item-expander`)?.getAttribute("data-child-activity") ?? null,
  indicator: (tab: Tab) => getInstanceSessionIndicatorStatusCached(instanceId(tab)),
  selected: (tab: Tab) => activeSessionId().get(instanceId(tab)) ?? null,
  listError: (tab: Tab) => getSessionListError(instanceId(tab)) ?? null }
