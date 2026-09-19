import { Show } from "solid-js"
import { render } from "solid-js/web"
import SessionView from "../../../src/components/session/session-view"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { sdkManager } from "../../../src/lib/sdk-manager"
import { addInstance } from "../../../src/stores/instances"
import { activeSessionId, sessions, setActiveSession, setProviders } from "../../../src/stores/session-state"
import { fetchSessions } from "../../../src/stores/session-api"
import "../../../src/index.css"

const instanceId = "fork-instance", source = "source"
const model = { providerID: "fixture", id: "fixture" }
const messages: Record<string, any[]> = { source: Array.from({ length: 4 }, (_, i) => i % 2 === 0
  ? { id: `msg_0${i + 1}`, type: "user", text: ["First question", "Second question"][i / 2], time: { created: i + 1 } }
  : { id: `msg_0${i + 1}`, type: "assistant", agent: "build", model, content: [{ type: "text", text: ["First answer", "Second answer"][(i - 1) / 2] }], time: { created: i + 1, completed: i + 1 } }) }
if (location.search.includes("streaming")) delete messages.source[3].time.completed
const requests: any[] = []
let prompts = 0
const info = (id: string) => ({ id, title: "Fork fixture", agent: "build", model, projectID: "fixture", location: { directory: "/fixture" },
  cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 6 } })
const client: any = {
  session: {
    active: async () => ({}), inbox: { list: async () => ({ data: [] }) },
    list: async () => ({ data: [info(source)], cursor: {} }), get: async ({ sessionID }: any) => info(sessionID),
    update: async ({ sessionID }: any) => info(sessionID),
    instructions: { entry: { remove: async () => {}, put: async () => {} } },
    switchAgent: async () => {}, switchModel: async () => {},
    fork: async (input: any) => {
      requests.push(input)
      const original = messages[input.sessionID]
      messages.fork = original.slice(0, input.before ? original.findIndex(m => m.id === input.before) : original.length)
        .map((m, i) => ({ ...m, id: `msg_fork_${i}` }))
      return { ...info("fork"), fork: { sessionID: source, boundary: input.before
        ? { type: "before", messageID: input.before }
        : { type: "through", messageID: original.at(-1).id } } }
    },
    prompt: async () => { prompts++ },
  },
  model: { default: async () => model },
  message: { list: async ({ sessionID, cursor }: any) => ({ data: cursor ? [] : [...messages[sessionID]].reverse(), cursor: {} }) },
}
;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
addInstance({ id: instanceId, folder: "/fixture", port: 0, pid: 0, proxyPath: "", status: "ready", client })
setProviders(prev => new Map(prev).set(instanceId, [{ id: "fixture", name: "Fixture", models: [{ id: "fixture", name: "Fixture", providerId: "fixture", limit: { context: 10000, output: 1000 }, cost: { input: 0, output: 0 } }] }]))
async function boot() {
  await fetchSessions(instanceId)
  setActiveSession(instanceId, source)
  render(() => <ConfigProvider><I18nProvider><ThemeProvider>
    <Show when={activeSessionId().get(instanceId)} keyed>{id =>
      <SessionView sessionId={id} activeSessions={sessions().get(instanceId)!} instanceId={instanceId} instanceFolder="/fixture" escapeInDebounce={false} isActive={true} />
    }</Show>
  </ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
  ;(window as any).fixture = {
    source: () => setActiveSession(instanceId, source),
    snapshot: () => ({ requests, prompts, sourceCount: messages.source.length, fork: messages.fork, active: activeSessionId().get(instanceId) }),
  }
}
void boot()
