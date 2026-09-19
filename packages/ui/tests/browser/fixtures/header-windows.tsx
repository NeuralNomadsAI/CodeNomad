import { render } from "solid-js/web"
import InstanceShell from "../../../src/components/instance/instance-shell2"
import { ConfigProvider, updatePreferences } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { serverApi } from "../../../src/lib/api-client"
import { sdkManager } from "../../../src/lib/sdk-manager"
import { addInstance, instances } from "../../../src/stores/instances"
import { setSessions, setActiveSession, setActiveParentSession, setSessionPage, setProviders } from "../../../src/stores/session-state"
import { ensureWorktreesLoaded } from "../../../src/stores/worktrees"
import "../../../src/index.css"

const id = "header-windows", sessionId = "session"
const session: any = { id: sessionId, instanceId: id, parentId: null, title: "Fixture conversation", location: { directory: "/repo" },
  projectID: "fixture", cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 }, agent: "build", status: "idle", model: { providerId: "fixture", modelId: "fixture" } }
const client: any = {
  session: { list: async () => ({ data: [session], cursor: {} }), active: async () => ({}), get: async () => session, inbox: { list: async () => ({ data: [] }) } },
  message: { list: async () => ({ data: [{ id: "hello", type: "user", text: "Fixture message", time: { created: 1 } }], cursor: {} }) },
  model: { default: async () => ({ data: { providerID: "fixture", id: "fixture" } }) },
  file: { status: async () => ({ data: [] }) },
}
;(sdkManager as any).clients.set(`${id}:/workspaces/${id}/instance`, client)
let config = { settings: { locale: "en" } }
serverApi.fetchConfigOwner = async () => config as any
serverApi.patchConfigOwner = async (_owner, patch: any) => (config = { ...config, ...patch, settings: { ...config.settings, ...patch.settings } }) as any
serverApi.fetchStateOwner = async () => ({} as any)
serverApi.fetchWorktrees = async () => ({ isGitRepo: true, worktrees: [{ slug: "root", directory: "/repo", kind: "root" }] })
addInstance({ id, folder: "/repo", port: 0, pid: 0, proxyPath: `/workspaces/${id}/instance`, status: "ready", client })
setSessions(previous => new Map(previous).set(id, new Map([[sessionId, session]])))
setProviders(previous => new Map(previous).set(id, [{ id: "fixture", name: "Fixture", models: [] }]))
setActiveSession(id, sessionId)
setActiveParentSession(id, sessionId)
setSessionPage(id, [sessionId], false, true)
await ensureWorktreesLoaded(id)
let executions = 0
render(() => <ConfigProvider><I18nProvider><ThemeProvider>
  <div style={{ height: "100vh", display: "flex", "flex-direction": "column" }}>
    <button id="outside">Outside target</button>
    <InstanceShell instance={instances().get(id)!} isActiveInstance={true} escapeInDebounce={false}
      paletteCommands={() => [{ id: "fixture", label: "Fixture command", description: "Execute the fixture", category: "System", action: () => {} }]}
      onExecuteCommand={() => { executions++ }} onCloseSession={() => {}} onNewSession={() => {}}
      handleSidebarAgentChange={async () => {}} handleSidebarModelChange={async () => {}} tabBarOffset={0}
      mobileFullscreenMode={false} onEnterMobileFullscreen={() => {}} onExitMobileFullscreen={() => {}} />
  </div>
</ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
await updatePreferences({ locale: "en" })
;(window as any).fixture = {
  executions: () => executions,
  showInfo: () => setActiveSession(id, "info"),
  setLocale: (locale: "en" | "he") => updatePreferences({ locale }),
}
