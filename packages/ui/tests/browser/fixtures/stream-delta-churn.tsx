// Streams real native session events (session.text.*) through the real
// sseManager dispatcher, stores and SessionView, so a test can observe exactly
// which DOM a single streaming delta touches in a settled transcript.
import { Show, createSignal } from "solid-js"
import { render } from "solid-js/web"
import SessionView from "../../../src/components/session/session-view"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { sdkManager } from "../../../src/lib/sdk-manager"
import { addInstance } from "../../../src/stores/instances"
import { sessions, setSessions, setActiveSession, setProviders } from "../../../src/stores/session-state"
import { sseManager } from "../../../src/lib/sse-manager"
import "../../../src/index.css"

const instanceId = "stream-delta-fixture"
const sessionId = "active"
const model = { providerID: "fixture", id: "fixture" }
let sequence = 1000
let assistantCounter = 0
const [visible, show] = createSignal(true)

const client: any = {
  session: {
    active: async () => ({}), inbox: { list: async () => [] },
    form: { list: async () => [] },
    get: async ({ sessionID }: any) => ({ id: sessionID, title: sessionID,
      location: { directory: "/fixture" }, time: { created: 1, updated: 1 } }),
    instructions: { entry: { remove: async () => {}, put: async () => {} } },
  },
  model: { default: async () => ({ data: model }) },
  permission: { list: async () => [] },
  message: { list: async () => ({ data: [], cursor: {} }) },
}
;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
addInstance({ id: instanceId, folder: "/fixture", port: 0, pid: 0, proxyPath: "", status: "ready", client })
setSessions(previous => new Map(previous).set(instanceId, new Map([[sessionId, {
  id: sessionId, instanceId, parentId: null, title: "stream delta", agent: "build", model: { providerId: "fixture", modelId: "fixture" },
  status: "idle", retry: null, idleSince: null, generationRecovery: null, runtimeStatusKnown: true,
  version: "1", projectID: "fixture", location: { directory: "/fixture" }, cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 },
}]])))
setProviders(previous => new Map(previous).set(instanceId, [{ id: "fixture", name: "Fixture", models: [
  { id: "fixture", name: "Fixture", providerId: "fixture", limit: { context: 1_000_000, output: 1_000_000 }, cost: { input: 0, output: 0 } },
] }]))
setActiveSession(instanceId, sessionId)
render(() => <ConfigProvider><I18nProvider><ThemeProvider><Show when={visible()}>
  <SessionView sessionId={sessionId} activeSessions={sessions().get(instanceId)!} instanceId={instanceId}
    instanceFolder="/fixture" escapeInDebounce={false} isActive={true} />
</Show></ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)

const encode = (type: string, data: Record<string, unknown>) =>
  JSON.parse(JSON.stringify({ id: `event_${++sequence}`, type, created: sequence, location: { directory: "/fixture" },
    data: { sessionID: sessionId, ...data } })) // parse round-trip matches the SSE delivery boundary
const dispatch = (event: unknown) => (sseManager as any).handleEvent(instanceId, event)

/** A settled streaming reply of `count` deltas; the last delta is NOT sent. */
const seedStream = (count: number, chunk: string, settle = false) => {
  const mid = `msg_${++assistantCounter}`
  dispatch(encode("session.step.started", { assistantMessageID: mid, agent: "build", model: { id: "fixture", providerID: "fixture" }, started: Date.now() }))
  dispatch(encode("session.text.started", { assistantMessageID: mid, ordinal: 0 }))
  let text = ""
  for (let index = 0; index < count - 1; index++) { text += chunk; dispatch(encode("session.text.delta", { assistantMessageID: mid, ordinal: 0, delta: chunk })) }
  if (settle) dispatch(encode("session.text.ended", { assistantMessageID: mid, ordinal: 0, text: text + chunk }))
  return mid
}

;(window as any).streamDeltaFixture = {
  seed: () => ({
    settled: Array.from({ length: 3 }, (_, index) => seedStream(8, `Settled reply ${index + 1}. `, true)),
    streaming: seedStream(40, "x".repeat(80)),
  }),
  delta: (mid: string) => dispatch(encode("session.text.delta", { assistantMessageID: mid, ordinal: 0, delta: "x".repeat(80) })),
}
