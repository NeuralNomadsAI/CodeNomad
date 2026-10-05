import { render } from "solid-js/web"
import { createSignal } from "solid-js"
import { useViewMenu } from "../../../src/lib/native/view-menu"
import { useAppLifecycle } from "../../../src/lib/hooks/use-app-lifecycle"
import InstanceShell from "../../../src/components/instance/instance-shell2"
import { ConfigProvider, updatePreferences } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { promptInputHeight } from "../../../src/components/prompt-input/height-state"
import { serverApi } from "../../../src/lib/api-client"
import { sdkManager } from "../../../src/lib/sdk-manager"
import { runtimeEnv } from "../../../src/lib/runtime-env"
import { sseManager } from "../../../src/lib/sse-manager"
import { getFormQueue } from "../../../src/stores/forms"
import { focusInterruption } from "../../../src/stores/interruption-navigation"
import { addInstance, addPendingForm, addPermissionToQueue, instances } from "../../../src/stores/instances"
import { setSessions, setActiveSession, setActiveParentSession, clearActiveParentSession, setSessionPage, setProviders, setSessionStatus, activeSessionId, setSessionInfoByInstance } from "../../../src/stores/session-state"
import { ensureWorktreesLoaded } from "../../../src/stores/worktrees"
import { initializeClientState, readClientLayoutValue } from "../../../src/stores/client-state"
import "../../../src/index.css"

// Optional, synchronous test-only marks; no observer is installed on native pages.
const bootStage = (phase: string) => (window as any).__headerFixtureBoot?.mark(phase)
bootStage("imports-complete")
if (new URLSearchParams(location.search).has("drawerWidth")) await initializeClientState()
const id = "header-windows", sessionId = "session"
let interrupts = 0
const session: any = { id: sessionId, instanceId: id, parentId: null, title: "Fixture conversation", location: { directory: "/repo" },
  projectID: "fixture", cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 }, agent: "build", status: "idle", model: { providerId: "fixture", modelId: "fixture" } }
const fixtureSessions = new Map([[sessionId, session]])
const replies: any[] = []
let eventTime = 100
const emit = (type: string, data: unknown) => (sseManager as any).handleEvent(id, {
  id: `fixture-event-${++eventTime}`, type, created: eventTime, location: { directory: "/repo" }, data,
})
const client: any = {
  session: { list: async () => ({ data: [...fixtureSessions.values()], cursor: {} }), active: async () => ({}),
    get: async ({ sessionID }: any) => fixtureSessions.get(sessionID), inbox: { list: async () => ({ data: [] }) }, interrupt: async () => { interrupts++ },
    form: { reply: async (input: any) => { replies.push(input); emit("form.replied", { sessionID: input.sessionID, id: input.formID, answer: input.answer }) } },
  },
  form: { list: async () => ({ data: getFormQueue(id) }) },
  permission: { reply: async (input: any) => { replies.push(input) } },
  message: { list: async () => ({ data: [{ id: "hello", type: "user", text: "Fixture message", time: { created: 1 } }], cursor: {} }) },
  model: { default: async () => ({ data: { providerID: "fixture", id: "fixture" } }) },
  file: { status: async () => ({ data: [] }) },
}
;(sdkManager as any).clients.set(`${id}:/workspaces/${id}/instance`, client)
let config = { settings: { locale: "en" } }
serverApi.fetchConfigOwner = async () => config as any
serverApi.patchConfigOwner = async (_owner, patch: any) => (config = { ...config, ...patch, settings: { ...config.settings, ...patch.settings } }) as any
serverApi.fetchStateOwner = async () => ({} as any)
serverApi.fetchPermissionReceipts = async () => ({ receipts: [] })
serverApi.listWorkspaceFiles = async () => []
serverApi.fetchSessionOutline = async () => ({ status: "outline", total: 1,
  entries: [{ id: "hello", seq: 0, type: "user", tools: 0, reasoning: 0 }],
  checkpoints: [{ after: -1, through: 0, digest: "0".repeat(64), changed: true }], cursor: null,
})
serverApi.fetchWorktrees = async () => ({ isGitRepo: true, worktrees: [{ slug: "root", directory: "/repo", kind: "root" }] })
addInstance({ id, folder: "/repo", port: 0, pid: 0, proxyPath: `/workspaces/${id}/instance`, status: "ready", client })
setSessions(previous => new Map(previous).set(id, new Map([[sessionId, session]])))
setProviders(previous => new Map(previous).set(id, [{ id: "fixture", name: "Fixture", models: [] }]))
setActiveSession(id, sessionId)
setActiveParentSession(id, sessionId)
setSessionPage(id, [sessionId], false, true)
bootStage("worktrees-before")
await ensureWorktreesLoaded(id)
bootStage("worktrees-after")
let executions = 0
const escapeStates: boolean[] = []
const [menuInstance, setMenuInstance] = createSignal<string | undefined>(id)
let viewAction: (action: string) => boolean
const [immersive, setImmersive] = createSignal(false)
const [active, setActive] = createSignal(true)
function Fixture() {
  viewAction = useViewMenu(menuInstance)
  const [escapeInDebounce, setEscapeInDebounce] = createSignal(false)
  useAppLifecycle({
    setEscapeInDebounce: value => { escapeStates.push(value); setEscapeInDebounce(value) },
    handleNewInstanceRequest: () => {}, handleCloseActiveTab: async () => {},
    handleNewSession: async () => {}, handleCloseSession: async () => {},
    showFolderSelection: () => false, setShowFolderSelection: () => {},
    getActiveInstance: () => instances().get(id) ?? null,
    getActiveSessionIdForInstance: () => activeSessionId().get(id) ?? null,
  })
  return (
  <div style={{ height: "100vh", display: "flex", "flex-direction": "column" }}>
    <button id="outside">Outside target</button>
    <InstanceShell instance={instances().get(id)!} isActiveInstance={active()} escapeInDebounce={escapeInDebounce()}
      paletteCommands={() => [{ id: "fixture", label: "Fixture command", description: "Execute the fixture", category: "System", action: () => {} }]}
      onExecuteCommand={() => { executions++ }} onCloseSession={() => {}} onNewSession={() => {}}
      handleSidebarAgentChange={async () => {}} handleSidebarModelChange={async () => {}} tabBarOffset={0}
      mobileFullscreenMode={immersive()} onEnterMobileFullscreen={() => setImmersive(true)} onExitMobileFullscreen={() => setImmersive(false)} />
  </div>
  )
}
bootStage("render-before")
render(() => <ConfigProvider><I18nProvider><ThemeProvider><Fixture /></ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
bootStage("render-after")
bootStage("preferences-before")
await updatePreferences({ locale: "en" })
bootStage("preferences-after")
;(window as any).fixture = {
  runtimeEnv, replies, setImmersive, setActive,
  readLayout: readClientLayoutValue,
  addSession: (sid: string, parentId: string | null = null) => {
    fixtureSessions.set(sid, { ...session, id: sid, parentId, title: `Fixture ${sid}` })
    setSessions(previous => new Map(previous).set(id, new Map(fixtureSessions)))
    setSessionPage(id, [...fixtureSessions.keys()], false, true)
  },
  selectSession: (sid: string | null) => { if (sid === null) clearActiveParentSession(id); else { setActiveParentSession(id, sid); setActiveSession(id, sid) } },
  selectedSession: () => activeSessionId().get(id) ?? null,
  focusRequest: (sid?: string, requestId?: string) => focusInterruption(id, sid, requestId),
  nativeQuestion: (sid = sessionId, formId = `question-${sid}`, long = false) => emit("form.created", {
    sessionID: sid, form: { id: formId, sessionID: sid, location: { directory: "/repo" }, title: "Questions", metadata: { kind: "question" },
      fields: [{ key: "q0", type: "string", title: long ? "Choose the deployment approach for the mobile browser release" : "Approach",
        description: long ? "Explain the deployment approach and the acceptance checks for the mobile browser release. ".repeat(25) : `Which approach for ${sid}?`, required: true }],
      state: { status: "pending" } },
  }),
  pendingForms: () => getFormQueue(id).map(form => form.id),
  askQuestion: () => addPendingForm(id, {
    id: "dock-question", sessionID: sessionId, title: "Questions", metadata: { kind: "question" },
    fields: [{ key: "q0", type: "string", title: "Approach", description: "Which approach?", required: true }],
    state: { status: "pending" },
  }),
  queuePermission: (sid = sessionId, requestId = "dock-permission") => addPermissionToQueue(id, {
    id: requestId, sessionID: sid, action: "bash", resources: ["git status"], metadata: {},
  }),
  viewAction: (action: string) => viewAction(action),
  menuInstance: setMenuInstance,
  setPreferences: updatePreferences,
  executions: () => executions,
  showInfo: () => setActiveSession(id, "info"),
  showSession: () => setActiveSession(id, sessionId),
  setContext: (used: number, available: number) => setSessionInfoByInstance(previous => new Map(previous).set(id,
    new Map([[sessionId, { actualUsageTokens: used, contextAvailableTokens: available } as any]]))),
  setLocale: (locale: "en" | "he") => updatePreferences({ locale }),
  setWorking: () => setSessionStatus(id, sessionId, "working", { force: true }),
  setIdle: () => setSessionStatus(id, sessionId, "idle", { force: true }),
  escapeStates: () => escapeStates,
  interrupts: () => interrupts,
  promptHeight: promptInputHeight,
}
bootStage("published")
