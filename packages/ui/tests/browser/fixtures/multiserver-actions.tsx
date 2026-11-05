import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import SessionView from "../../../src/components/session/session-view"
import { ConfigProvider, updatePreferences } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { sdkManager } from "../../../src/lib/sdk-manager"
import { serverApi } from "../../../src/lib/api-client"
import { addInstance, updateInstance } from "../../../src/stores/instances"
import { setActiveSession, setProviders, setAgents, setSessions, sessions } from "../../../src/stores/session-state"
import { updateSessionAgent, updateSessionModel } from "../../../src/stores/session-actions"
import { getAttachments } from "../../../src/stores/attachments"
import { fetchCommands } from "../../../src/stores/commands"
import { messageStoreBus } from "../../../src/stores/message-v2/bus"
import "../../../src/index.css"

serverApi.fetchConfigOwner = async () => ({}) as any
serverApi.fetchStateOwner = async () => ({}) as any
serverApi.patchStateOwner = async (_owner, patch) => patch as any
const [selected, select] = createSignal("A")
const calls: { target: string; method: string; input: any }[] = []
const clients = new Map<string, any>()
let blocked = "", release: (() => void) | undefined
let gate = Promise.resolve()
const record = (target: string, method: string) => async (input: any) => {
  calls.push({ target, method, input })
  if (blocked === method) await gate
  return { id: input?.id }
}
for (const id of ["A", "B", "local-shared"]) {
  const model = { providerID: "p", id: "m" }
  const info = { id: "same", title: "Same session", location: { directory: "/same/" }, agent: "build", model,
    parentId: null, status: "idle", time: { created: 1, updated: 1 } }
  const client: any = {
    session: {
      instructions: { entry: { put: record(id, "instruction"), remove: record(id, "voice") } },
      prompt: record(id, "prompt"), command: record(id, "command"), shell: record(id, "shell"),
      switchAgent: record(id, "agent"), switchModel: record(id, "model"), active: async () => ({}),
      get: async () => info, inbox: { list: async () => ({ data: [] }) },
    },
    agent: { list: async () => ({ data: [{ id: "build", name: "build", mode: "primary" }, { id: "plan", name: "plan", mode: "primary" }] }) },
    provider: { list: async () => ({ data: [{ id: "p", name: "p" }] }) },
    model: { list: async () => ({ data: [{ ...model, name: "m", limit: {}, cost: [{}], variants: [] }] }), default: async () => ({ data: model }) },
    command: { list: async () => ({ data: [{ name: "review", description: "Native review" }] }) },
    skill: { list: async () => ({ data: [{ id: "skill", name: `Skill ${id}`, description: "Native skill" }] }) },
    message: { list: async () => { await record(id, "messages")({}); return { data: [], cursor: {} } } },
  }
  clients.set(id, client)
  ;(sdkManager as any).clients.set(`${id}:/workspaces/${id}/instance`, client)
  addInstance({ id, folder: "/same/", port: 0, pid: 0, proxyPath: "", status: "ready", client,
    binding: { serverId: id, directory: "/same/" }, capabilities: { generation: 1 } as any })
  setSessions(previous => new Map(previous).set(id, new Map([["same", { ...info, instanceId: id, model: { providerId: "p", modelId: "m" } } as any]])))
  setAgents(previous => new Map(previous).set(id, [{ id: "build", name: "build", mode: "primary", description: "Native agent" }]))
  setProviders(previous => new Map(previous).set(id, [{ id: "p", name: "p", models: [{ id: "m", name: "m", providerId: "p" }] }]))
  await fetchCommands(id, client, { directory: "/same/" })
  setActiveSession(id, "same")
}
render(() => <ConfigProvider><I18nProvider><ThemeProvider>
  <SessionView instanceId={selected()} sessionId="same" activeSessions={sessions().get(selected())!}
    instanceFolder="/same/" escapeInDebounce={false} isActive
    onAgentChange={agent => updateSessionAgent(selected(), "same", agent)}
    onModelChange={model => updateSessionModel(selected(), "same", model)} />
</ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
await updatePreferences({ locale: "en" })
;(window as any).fixture = {
  select,
  calls: () => calls,
  attachments: () => getAttachments(selected(), "same"),
  block(method: string) { blocked = method; gate = new Promise<void>(done => { release = done }) },
  release() { blocked = ""; release?.() },
  rotate() { updateInstance(selected(), { capabilities: { generation: 2 } as any }) },
  historical() { messageStoreBus.getOrCreate(selected()).setMessageWindow("same", { kind: "history", nativeOrder: "desc", nativeCurrent: () => true, resumeCursor: "old", newerCursors: ["latest"] }) },
}
