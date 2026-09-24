import { Show, createSignal } from "solid-js"
import { render } from "solid-js/web"
import { Toaster } from "solid-toast"
import { OpenCode } from "@opencode/client"
import SessionView from "../../../src/components/session/session-view"
import { ConfigProvider, updatePreferences } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { sdkManager } from "../../../src/lib/sdk-manager"
import { addInstance, setActiveInstanceId } from "../../../src/stores/instances"
import { activeSessionId, sessions, setSessions, setActiveSession, setProviders } from "../../../src/stores/session-state"
import { fetchSessions } from "../../../src/stores/session-api"
import { getAttachments } from "../../../src/stores/attachments"
import { serverApi } from "../../../src/lib/api-client"
import "../../../src/index.css"

const instanceId = "upload-instance"
const params = new URLSearchParams(location.search)
const directory = params.get("directory") || "/remote/workspace"
serverApi.fetchConfigOwner = async () => ({ settings: { locale: params.get("locale") || "en" } }) as any
serverApi.fetchStateOwner = async () => ({}) as any
serverApi.patchConfigOwner = async (_owner, patch) => patch as any
const [active, setActive] = createSignal(true)
const [mounted, setMounted] = createSignal(true)
const model = { providerID: "fixture", id: "fixture" }
const native = OpenCode.make({ baseUrl: location.origin })
const info = (id: string) => ({ id, title: id, agent: "build", model, projectID: "fixture", location: { directory },
  cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 } })
const client: any = {
  session: {
    active: async () => ({}), inbox: { list: async () => ({ data: [] }) },
    list: async () => ({ data: [info("source"), info("other")], cursor: {} }), get: async ({ sessionID }: any) => info(sessionID),
    update: async ({ sessionID }: any) => info(sessionID),
    instructions: { entry: { remove: async () => {}, put: async () => {} } },
    switchAgent: async () => {}, switchModel: async () => {}, prompt: native.session.prompt,
  },
  model: { default: async () => model },
  message: { list: async () => ({ data: [], cursor: {} }) },
}
;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
addInstance({ id: instanceId, folder: directory, port: 0, pid: 0, proxyPath: "", status: "ready", client })
setActiveInstanceId(instanceId)
setProviders(prev => new Map(prev).set(instanceId, [{ id: "fixture", name: "Fixture", models: [{ id: "fixture", name: "Fixture", providerId: "fixture", limit: { context: 10000, output: 1000 }, cost: { input: 0, output: 0 } }] }]))
await fetchSessions(instanceId)
setActiveSession(instanceId, "source")
render(() => <ConfigProvider><I18nProvider><ThemeProvider>
  <Show when={mounted()}>
    <SessionView sessionId={activeSessionId().get(instanceId)!} activeSessions={sessions().get(instanceId)!} instanceId={instanceId} instanceFolder={directory} escapeInDebounce={false} isActive={active()} />
  </Show>
  <button id="outside" style={{ position: "fixed", top: "8px", right: "8px" }}>Outside composer</button>
  <Toaster />
</ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
await updatePreferences({ locale: (params.get("locale") || "en") as any })
;(window as any).fixture = {
  switch: (id: string) => setActiveSession(instanceId, id),
  active: setActive,
  mounted: setMounted,
  move: (directory: string) => setSessions(previous => {
    const next = new Map(previous), list = new Map(next.get(instanceId))
    const id = activeSessionId().get(instanceId)!
    list.set(id, { ...list.get(id)!, location: { directory } })
    next.set(instanceId, list)
    return next
  }),
  attachments: (id = "source") => getAttachments(instanceId, id).map(item => ({ ...item,
    source: item.source.type === "file" ? { ...item.source, data: item.source.data && Array.from(item.source.data) } : item.source,
  })),
}
