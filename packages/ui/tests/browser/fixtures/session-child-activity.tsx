import { createMemo, createSignal } from "solid-js"
import { render } from "solid-js/web"
import SessionList from "../../../src/components/session-list"
import { ConfigProvider, updatePreferences } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { serverApi } from "../../../src/lib/api-client"
import { addInstance } from "../../../src/stores/instances"
import {
  sessions, setActiveSession, setSessionPage, setSessionPendingPermission, setSessionStatus, setSessions,
} from "../../../src/stores/session-state"
import { buildSessionThreadsFromMap } from "../../../src/stores/session-tree"
import type { Session } from "../../../src/types/session"
import "../../../src/index.css"

const id = "session-child-activity-fixture"
function make(sessionId: string, title: string, updated: number, parentId: string | null = null): Session {
  return { id: sessionId, title, instanceId: id, parentId, location: { directory: "/repo" }, status: "idle", agent: "build",
    projectID: "fixture", cost: 0, tokens: {}, time: { created: 1, updated }, model: { providerId: "fixture", modelId: "fixture" } } as Session
}
// "Work" is the conversation being viewed; "Other" owns busy subsessions elsewhere in the list.
const items = [
  make("work", "Work conversation", 3),
  make("work-child", "Work helper", 3, "work"),
  make("other", "Other conversation", 2),
  make("other-child", "Other helper", 2, "other"),
  make("other-grandchild", "Other nested helper", 2, "other-child"),
]
const uiConfig = { settings: { locale: "en" } }
serverApi.fetchConfigOwner = async () => uiConfig as any
serverApi.patchConfigOwner = async (_owner, patch) => Object.assign(uiConfig, patch) as any
serverApi.fetchStateOwner = async () => ({} as any)
serverApi.fetchWorktrees = async () => ({ isGitRepo: false, worktrees: [] })
addInstance({ id, folder: "/repo", port: 0, pid: 0, proxyPath: `/workspaces/${id}/instance`, status: "ready", client: {} as any })
setSessions(previous => new Map(previous).set(id, new Map(items.map(item => [item.id, item]))))
setSessionPage(id, ["work", "other"], false, true)
setActiveSession(id, "work")
const [active, setActive] = createSignal<string | null>("work")
function Fixture() {
  const threads = createMemo(() => buildSessionThreadsFromMap(sessions().get(id)!, ["work", "other"]))
  return <ConfigProvider><I18nProvider><div style={{ width: "440px", height: "500px", display: "flex" }}>
    <SessionList instanceId={id} threads={threads()} activeSessionId={active()} onSelect={value => { setActive(value); setActiveSession(id, value) }}
      onNew={() => {}} enableFilterBar={false} showHeader={false} showFooter={false} />
  </div></I18nProvider></ConfigProvider>
}
render(() => <Fixture />, document.getElementById("root")!)
await updatePreferences({ locale: "en" })
;(window as any).fixture = {
  status: (sessionId: string, status: Session["status"]) => setSessionStatus(id, sessionId, status),
  permission: (sessionId: string, pending: boolean) => setSessionPendingPermission(id, sessionId, pending),
}
