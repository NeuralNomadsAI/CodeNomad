import { Show } from "solid-js"
import { render } from "solid-js/web"
import InstanceShell from "../../../src/components/instance/instance-shell2"
import { ConfigProvider, updatePreferences } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { serverApi } from "../../../src/lib/api-client"
import { sdkManager } from "../../../src/lib/sdk-manager"
import { addInstance, instances, updateInstance, removeInstance, setActiveInstanceId } from "../../../src/stores/instances"
import { activeSessionId, clearActiveParentSession, getSessionDraftPrompt, sessions, setAgents, setProviders, setSessionPage, setSessions } from "../../../src/stores/session-state"
import { initialServerCapabilities } from "../../../../server/src/opencode/servers/capabilities"
import { alertDialogState } from "../../../src/stores/alerts"
import { markSessionListsRestored } from "./session-list-restored"
import "../../../src/index.css"

const id = "actions-first", directory = "/repo"
const calls: string[] = []
let release = () => {}, creates = 0
let instructionsStarted = 0, holdInstructions = false, releaseInstructions = (_error?: boolean) => {}
const info = { id: "created", agent: "build", model: { providerID: "p", id: "m" }, location: { directory }, time: { created: 1, updated: 1 } }
const client: any = {
  session: { list: async () => ({ data: [], cursor: {} }), active: async () => ({}), get: async () => info,
    inbox: { list: async () => [] },
    create: async () => { creates++; await new Promise<void>(done => { release = done }); return info },
    switchAgent: async () => {}, switchModel: async () => {},
    instructions: { entry: { put: async () => {
      if (!holdInstructions) return
      instructionsStarted++
      await new Promise<void>((resolve, reject) => { releaseInstructions = error => error ? reject(new Error("Known native refusal")) : resolve() })
    }, remove: async () => {} } },
    prompt: async (input: any) => { calls.push("prompt"); return { id: input.id } },
  },
  agent: { list: async () => ({ data: [{ id: "build", name: "build", mode: "primary", model: { providerID: "p", id: "m" } }, { id: "plan", name: "plan", mode: "primary" }] }) },
  provider: { list: async () => ({ data: [{ id: "p", name: "p" }] }) },
  model: { default: async () => ({ data: { providerID: "p", id: "m" } }), list: async () => ({ data: [{ id: "m", providerID: "p", name: "m", cost: [{}], limit: {}, variants: [] }] }) },
  command: { list: async () => ({ data: [] }) }, skill: { list: async () => ({ data: [] }) },
  message: { list: async () => ({ data: [], cursor: {} }) },
}
serverApi.fetchConfigOwner = async () => ({ settings: { locale: "en" } }) as any
serverApi.fetchStateOwner = async () => ({}) as any
serverApi.patchStateOwner = async (_owner, value) => value as any
serverApi.readInstanceData = async () => ({ messageHistory: [], agentModelSelections: {} })
serverApi.writeInstanceData = async () => {}
const capabilities = initialServerCapabilities({ kind: "explicit", id: "A", label: "A", origin: "http://127.0.0.1:1" }, 1)
for (const name of ["sessions", "chat", "events"] as const) capabilities.features[name] = { state: "available", reason: { code: "contractVerified" }, evidence: "nativeContract" }
function open(generation = 1) {
  ;(sdkManager as any).clients.set(`${id}:/workspaces/${id}/instance`, client)
  addInstance({ id, folder: directory, client, status: "ready", proxyPath: "", port: 0, pid: 0,
    binding: { serverId: "A", directory }, capabilities: { ...capabilities, generation } })
  setSessions(previous => new Map(previous).set(id, new Map()))
  setAgents(previous => new Map(previous).set(id, [{ id: "build", name: "build", mode: "primary", description: "", model: { providerId: "p", modelId: "m" } }]))
  setProviders(previous => new Map(previous).set(id, [{ id: "p", name: "p", models: [{ id: "m", name: "m", providerId: "p" }] }]))
  clearActiveParentSession(id)
  setSessionPage(id, [], false, true)
  markSessionListsRestored(id)
  setActiveInstanceId(id)
}
open()
let heldInstance = instances().get(id)!
const shellInstance = () => {
  heldInstance = instances().get(id) ?? heldInstance
  return heldInstance
}
render(() => <ConfigProvider><I18nProvider><ThemeProvider><Show when={instances().has(id)}>
  <InstanceShell instance={shellInstance()} isActiveInstance escapeInDebounce={false} paletteCommands={() => []}
    onExecuteCommand={() => {}} onCloseSession={() => {}} onNewSession={() => {}}
    handleSidebarAgentChange={async () => {}} handleSidebarModelChange={async () => {}} tabBarOffset={0}
    mobileFullscreenMode={false} onEnterMobileFullscreen={() => {}} onExitMobileFullscreen={() => {}} />
</Show></ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
await updatePreferences({ locale: "en" })
;(window as any).firstPrompt = {
  creates: () => creates, release: () => release(), calls: () => calls, alert: alertDialogState,
  holdInstructions: () => { holdInstructions = true }, instructionsStarted: () => instructionsStarted,
  releaseInstructions: (error?: boolean) => releaseInstructions(error),
  selected: () => activeSessionId().get(id) ?? null,
  draft: () => getSessionDraftPrompt(id, "__no_session_draft__"),
  created: () => sessions().get(id)?.has("created") ?? false,
  rotate: () => updateInstance(id, { capabilities: { ...capabilities, generation: 2 } }),
  close: () => removeInstance(id, { authoritative: false }), reuse: () => open(2),
}
