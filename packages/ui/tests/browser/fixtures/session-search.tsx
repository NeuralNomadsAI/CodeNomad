import { createMemo, createSignal } from "solid-js"
import { render } from "solid-js/web"
import SessionList from "../../../src/components/session-list"
import { ConfigProvider, updatePreferences } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { serverApi } from "../../../src/lib/api-client"
import { sdkManager } from "../../../src/lib/sdk-manager"
import { addInstance } from "../../../src/stores/instances"
import { sessions, setSessions, setSessionPage } from "../../../src/stores/session-state"
import { buildSessionThreadsFromMap } from "../../../src/stores/session-tree"
import { ensureWorktreesLoaded } from "../../../src/stores/worktrees"
import type { Session } from "../../../src/types/session"
import "../../../src/index.css"

const id = "session-search-fixture"
function make(sessionId: string, title: string, directory: string, updated: number, parentId: string | null = null): Session {
  return { id: sessionId, title, instanceId: id, parentId, location: { directory }, status: "idle", agent: "build",
    projectID: "fixture", cost: 0, tokens: {}, time: { created: 1, updated }, model: { providerId: "fixture", modelId: "fixture" } } as Session
}
const items = [
  make("parent", "Parent conversation", "/feature", 1),
  make("child", "Child needle", "/repo", 4, "parent"),
  make("grandchild", "Deep needle", "/feature", 3, "child"),
  make("local", "Local conversation", "/repo", 2),
]
const orphan = make("orphan", "Remote content match", "/feature", 5, "unloaded-parent")
const searches: unknown[] = [], selected: string[] = []
let parentReads = 0
const client: any = { session: {
  list: async (input: any) => {
    searches.push(input)
    const result = input.search === "remote" ? [orphan] : items.filter(item => item.title.toLowerCase().includes(input.search ?? ""))
    return { data: result.filter(item => !input.directory || item.location.directory === input.directory).map(item => ({ ...item, parentID: item.parentId })), cursor: {} }
  },
  get: async () => { parentReads++; throw new Error("Search must not hydrate ancestors") },
} }
;(sdkManager as any).clients.set(`${id}:/workspaces/${id}/instance`, client)
const uiConfig = { settings: { locale: "en" } }
serverApi.fetchConfigOwner = async () => uiConfig as any
serverApi.patchConfigOwner = async (_owner, patch) => Object.assign(uiConfig, patch) as any
serverApi.fetchStateOwner = async () => ({} as any)
serverApi.fetchWorktrees = async () => ({ isGitRepo: true, worktrees: [
  { slug: "root", label: "main", directory: "/repo", kind: "root" },
  { slug: "feature-id", label: "feature", directory: "/feature", kind: "worktree" },
] })
addInstance({ id, folder: "/repo", port: 0, pid: 0, proxyPath: `/workspaces/${id}/instance`, status: "ready", client })
setSessions(previous => new Map(previous).set(id, new Map(items.map(item => [item.id, item]))))
setSessionPage(id, ["parent", "local"], false, true)
await ensureWorktreesLoaded(id)
const [searchMode, setSearchMode] = createSignal(true)
const [active, setActive] = createSignal<string | null>(null)
function Fixture() {
  const threads = createMemo(() => buildSessionThreadsFromMap(sessions().get(id)!, ["parent", "local"]))
  return <ConfigProvider><I18nProvider><div style={{ width: "440px", height: "650px", display: "flex" }}>
    <SessionList instanceId={id} threads={threads()} activeSessionId={active()} onSelect={value => { selected.push(value); setActive(value) }}
      onNew={() => {}} enableFilterBar={searchMode()} showHeader={false} showFooter={false} />
  </div></I18nProvider></ConfigProvider>
}
render(() => <Fixture />, document.getElementById("root")!)
await updatePreferences({ locale: "en" })
;(window as any).fixture = { searches, selected, parentReads: () => parentReads, setSearchMode }
