import { Show } from "solid-js"
import { render } from "solid-js/web"
import SessionView from "../../../src/components/session/session-view"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { sdkManager } from "../../../src/lib/sdk-manager"
import { addInstance, setActiveInstanceId } from "../../../src/stores/instances"
import { activeSessionId, getSessionListIds, sessions, setActiveParentSession, setProviders } from "../../../src/stores/session-state"
import { fetchAgents, fetchSessions, hydrateRestoredSessionChain } from "../../../src/stores/session-api"
import { updateSessionAgent, updateSessionModel } from "../../../src/stores/session-actions"
import { openImagesConversation } from "../../../src/stores/images-conversation"
import { applyUiSettings } from "./ui-settings"
import "../../../src/index.css"

// The real session view, composer and Images conversation action; the native
// client is a deterministic fake and the host route is answered by the test.
await applyUiSettings({ locale: "en" })
const instanceId = "images-instance"
const state = { designPresent: true, prompts: 0, switchAgent: [] as any[], switchModel: [] as any[] }
const mark = { "codenomad.companion": "images" }
const infos: Record<string, any> = {
  ses_work: { agent: "build", model: { providerID: "fixture", id: "native" }, title: "Work" },
  ses_images: { agent: "design", model: { providerID: "fixture", id: "chosen" }, title: "Images", metadata: mark },
  ses_images_new: { agent: "design", model: { providerID: "fixture", id: "chosen" }, title: "Images", metadata: mark },
  ses_images_build: { agent: "build", model: { providerID: "fixture", id: "chosen" }, title: "Images", metadata: mark },
  ses_unmarked_design: { agent: "design", model: { providerID: "fixture", id: "chosen" }, title: "Designing" },
}
const info = (id: string) => ({ id, projectID: "fixture", location: { directory: "/fixture" }, cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 }, ...infos[id] })
const agent = (id: string) => ({ id, name: id[0]!.toUpperCase() + id.slice(1), mode: "primary", description: "" })
const client: any = {
  session: {
    active: async () => ({}), inbox: { list: async () => ({ data: [] }) },
    list: async () => ({ data: [info("ses_work")], cursor: {} }), get: async ({ sessionID }: any) => info(sessionID),
    update: async ({ sessionID }: any) => info(sessionID),
    instructions: { entry: { remove: async () => {}, put: async () => {} } },
    switchAgent: async (input: any) => { state.switchAgent.push(input); infos[input.sessionID].agent = input.agent },
    switchModel: async (input: any) => { state.switchModel.push(input) },
    prompt: async () => { state.prompts++; return {} },
  },
  agent: {
    list: async () => ({ data: [agent("build"), ...(state.designPresent ? [agent("design")] : [])] }),
    get: async ({ agentID }: any) => ({ data: agent(agentID) }),
  },
  model: { default: async () => ({ data: { providerID: "fixture", id: "native" } }) },
  message: { list: async () => ({ data: [], cursor: {} }) },
}
;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
addInstance({ id: instanceId, folder: "/fixture", port: 0, pid: 0, proxyPath: "", status: "ready", client })
setActiveInstanceId(instanceId)
// CodeNomad's choice (the provider default) differs from the native default model.
setProviders(prev => new Map(prev).set(instanceId, [{ id: "fixture", name: "Fixture", defaultModelId: "chosen", models: [
  { id: "native", name: "Native", providerId: "fixture", limit: { context: 10000, output: 1000 }, cost: { input: 0, output: 0 } },
  { id: "chosen", name: "Chosen", providerId: "fixture", limit: { context: 10000, output: 1000 }, cost: { input: 0, output: 0 } },
] }]))

await fetchSessions(instanceId)
setActiveParentSession(instanceId, "ses_work")
await fetchAgents(instanceId, { directory: "/fixture" }, true)
render(() => <ConfigProvider><I18nProvider><ThemeProvider>
  <Show when={activeSessionId().get(instanceId)} keyed>{id =>
    <SessionView sessionId={id} activeSessions={sessions().get(instanceId)!} instanceId={instanceId} instanceFolder="/fixture"
      escapeInDebounce={false} isActive={true} onAgentChange={agentId => updateSessionAgent(instanceId, id, agentId)} onModelChange={async () => {}} />
  }</Show>
</ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)

;(window as any).fixture = {
  open: (mode: "open" | "new") => openImagesConversation(instanceId, mode),
  show: async (id: string) => { await hydrateRestoredSessionChain(instanceId, [id]); setActiveParentSession(instanceId, id) },
  setDesignPresent: async (present: boolean) => { state.designPresent = present; await fetchAgents(instanceId, { directory: "/fixture" }, true) },
  // The user picks another model through the real selector action.
  changeModel: async (id: string, model: string) => {
    infos[id].model = { providerID: "fixture", id: model }
    await updateSessionModel(instanceId, id, { providerId: "fixture", modelId: model })
  },
  snapshot: () => ({ ...state, active: activeSessionId().get(instanceId), listed: getSessionListIds(instanceId),
    model: sessions().get(instanceId)?.get(activeSessionId().get(instanceId)!)?.model,
    focused: document.activeElement?.classList.contains("prompt-input") === true }),
}
