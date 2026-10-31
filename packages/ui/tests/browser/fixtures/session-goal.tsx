import { render } from "solid-js/web"
import { createSignal } from "solid-js"
import { Toaster } from "solid-toast"
import RightPanel from "../../../src/components/instance/shell/right-panel/RightPanel"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider, useI18n } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { sdkManager } from "../../../src/lib/sdk-manager"
import { serverEvents } from "../../../src/lib/server-events"
import { addInstance } from "../../../src/stores/instances"
import { setSessions } from "../../../src/stores/session-state"
import { initializeClientState } from "../../../src/stores/client-state"
import type { Session } from "../../../src/types/session"
import "../../../src/index.css"

// The real right panel, Status tab, goal store and command path (session
// admission included); the native client is a deterministic fake that records
// commands, the goal route is answered by the test and native events are
// dispatched through the real event dispatcher.
const instanceId = "goal-fixture"
const commands: Array<{ sessionID: string; name: string; text: string; delivery?: string }> = []
const failures: string[] = []
let held: Promise<void> | undefined, release: (() => void) | undefined

// Any other native read answers an empty page.
function stub(target: any): any {
  return new Proxy(target, { get(object, property) {
    if (typeof property === "symbol" || property === "then" || property === "toJSON") return object[property]
    if (property in object) {
      const value = object[property]
      return value && typeof value === "object" ? stub(value) : value
    }
    return stub(async () => ({ data: [] }))
  } })
}
const client = stub({
  session: {
    command: async (input: any) => {
      commands.push({ sessionID: input.sessionID, name: input.name, text: input.text, delivery: input.delivery })
      await held
      const failure = failures.shift()
      if (failure) throw Object.assign(new Error(failure), { data: { message: failure } })
    },
    instructions: { entry: { put: async () => ({}), remove: async () => ({}) } },
  },
})
;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
addInstance({ id: instanceId, folder: "/fixture", port: 0, pid: 0, proxyPath: "", status: "ready", client })

const session = (id: string, title: string): Session => ({
  id, instanceId, parentId: null, title, agent: "build", model: { providerId: "fixture", modelId: "fixture" }, status: "idle",
  retry: null, idleSince: null, generationRecovery: null, runtimeStatusKnown: true, version: "1", projectID: "fixture",
  location: { directory: "/fixture" }, cost: 0, tokens: { input: 1200, output: 300, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
})
const sessions = new Map([["ses_goal", session("ses_goal", "Goal")], ["ses_other", session("ses_other", "Other")]])
setSessions(previous => new Map(previous).set(instanceId, sessions))
const [activeSession, setActiveSession] = createSignal<Session | null>(sessions.get("ses_goal")!)

function Fixture() {
  const { t } = useI18n()
  return <div style={{ width: "380px", height: "800px" }}>
    <RightPanel isActive={() => true} t={t} instanceId={instanceId} instance={{ id: instanceId, folder: "/fixture", port: 0, pid: 0, proxyPath: "", status: "ready", client }}
      activeSessionId={() => activeSession()?.id ?? null} activeSession={activeSession} isPhoneLayout={() => false}
      rightDrawerWidth={() => 380} rightDrawerWidthInitialized={() => true}
      onCloseRightDrawer={() => {}} promptInputApi={() => null} setContentEl={() => {}} />
    <Toaster />
  </div>
}

await initializeClientState()
render(() => <ConfigProvider><I18nProvider><ThemeProvider><Fixture /></ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
const dispatch = (payload: unknown) => (serverEvents as any).dispatchBatch([payload])
;(window as any).goalFixture = {
  commands: () => commands.slice(),
  failNext: (message: string) => { failures.push(message) },
  hold: () => { held = new Promise(resolve => { release = resolve }) },
  release: () => { release?.(); held = undefined },
  changed: (sessionID: string, goal: unknown) => dispatch({ type: "instance.event", instanceId, event: {
    id: `evt_${Date.now()}`, type: "rpc.opencode.goal.changed", created: Date.now(), location: { directory: "/fixture" }, data: { sessionID, goal },
  } }),
  reconnect: () => dispatch({ type: "instance.eventStatus", instanceId, status: "connected", generation: 2 }),
  select: (id: string | null) => setActiveSession(id ? sessions.get(id)! : null),
}
