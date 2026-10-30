import { Show, createSignal } from "solid-js"
import { render } from "solid-js/web"
import SessionView from "../../../src/components/session/session-view"
import RightPanel from "../../../src/components/instance/shell/right-panel/RightPanel"
import type { PromptInputApi } from "../../../src/components/prompt-input/types"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider, useI18n } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { sdkManager } from "../../../src/lib/sdk-manager"
import { serverEvents } from "../../../src/lib/server-events"
import { addInstance, setActiveInstanceId } from "../../../src/stores/instances"
import { activeSessionId, sessions, setActiveParentSession, setProviders } from "../../../src/stores/session-state"
import { fetchAgents, hydrateRestoredSessionChain } from "../../../src/stores/session-api"
import { updateSessionAgent } from "../../../src/stores/session-actions"
import { applyUiSettings } from "./ui-settings"
import "../../../src/index.css"

// The Design companion against an isolated OpenCode runtime (scripts/test-design-companion-ui.mjs):
// the native client, transcript, composer, right panel, extension bridge and API 4 channel are
// real; only workspace chrome is seeded and native events arrive through the fixture stream.
await applyUiSettings({ locale: "en" })
const params = new URLSearchParams(location.search)
const instanceId = "design-ui"
const sessionId = params.get("session")!
const directory = params.get("directory")!
const proxyPath = `/workspaces/${instanceId}/instance`
const client = sdkManager.createClient(instanceId, proxyPath)
addInstance({ id: instanceId, folder: directory, port: 0, pid: 0, proxyPath, status: "ready", client })
setActiveInstanceId(instanceId)
setProviders(prev => new Map(prev).set(instanceId, [{ id: "fixture", name: "Fixture", defaultModelId: "vision", models: [
  { id: "vision", name: "Fixture vision", providerId: "fixture", limit: { context: 100000, output: 1000 }, cost: { input: 0, output: 0 } },
] }]))
// Like the app, history loads once the native event stream is connected; events wait for the
// session's own read, as the app's session list precedes them.
let eventsReady = false, buffered: unknown[] | undefined = []
const dispatch = (event: unknown) => (serverEvents as any).dispatchBatch([{ type: "instance.event", instanceId, event }])
const connected = new Promise<void>(resolve => {
  const events = new EventSource("/fixture-events")
  events.onmessage = message => {
    eventsReady = true
    const event = JSON.parse(message.data)
    if (buffered) buffered.push(event)
    else dispatch(event)
    resolve()
  }
  window.addEventListener("pagehide", () => events.close(), { once: true })
})
await connected
await fetchAgents(instanceId, { directory }, true)
await hydrateRestoredSessionChain(instanceId, [sessionId])
setActiveParentSession(instanceId, sessionId)
for (const event of buffered.splice(0)) dispatch(event)
buffered = undefined

const [apis, setApis] = createSignal<Record<string, PromptInputApi | null>>({})
const active = () => activeSessionId().get(instanceId) ?? null
const promptApi = () => { const id = active(); return id ? apis()[id] ?? null : null }

function Fixture() {
  const { t } = useI18n()
  return <div style={{ display: "flex", height: "100dvh", width: "100vw" }}>
    <div style={{ flex: "1", "min-width": "0", display: "flex" }}>
      <Show when={active()} keyed>{id =>
        <SessionView sessionId={id} activeSessions={sessions().get(instanceId)!} instanceId={instanceId} instanceFolder={directory}
          escapeInDebounce={false} isActive={true} onAgentChange={agentId => updateSessionAgent(instanceId, id, agentId)} onModelChange={async () => {}}
          registerSessionPromptApi={(id, api) => setApis(current => ({ ...current, [id]: api }))} />
      }</Show>
    </div>
    <div class="session-shell-panels" style={{ width: "460px", position: "relative" }}>
      <RightPanel instanceId={instanceId} instance={{ id: instanceId, folder: directory, status: "ready", client: null, port: 0, pid: 0, proxyPath } as any}
        isActive={() => true} t={t} activeSessionId={active} activeSession={() => null} isPhoneLayout={() => false}
        rightDrawerWidth={() => 460} rightDrawerWidthInitialized={() => true} onCloseRightDrawer={() => {}} promptInputApi={promptApi} setContentEl={() => {}} />
    </div>
  </div>
}
;(window as any).fixture = {
  eventsReady: () => eventsReady,
  sessions: () => JSON.parse(JSON.stringify([...(sessions().get(instanceId)?.values() ?? [])])),
  snapshot: () => ({ active: active(),
    draft: (document.querySelector("textarea.prompt-input") as HTMLTextAreaElement | null)?.value ?? null,
    focused: document.activeElement?.classList.contains("prompt-input") === true }),
}
render(() => <ConfigProvider><I18nProvider><ThemeProvider><Fixture /></ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
