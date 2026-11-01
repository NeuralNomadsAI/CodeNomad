import { render } from "solid-js/web"
import PromptInput from "../../../src/components/prompt-input"
import MessageSection from "../../../src/components/message-section"
import { addInstance, setActiveInstanceId } from "../../../src/stores/instances"
import { setSessions, setActiveSession } from "../../../src/stores/session-state"
import { loadMessages } from "../../../src/stores/session-api"
import { sendMessage } from "../../../src/stores/session-actions"
import { sseManager } from "../../../src/lib/sse-manager"
import { serverApi } from "../../../src/lib/api-client"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { sdkManager } from "../../../src/lib/sdk-manager"
import { applyUiSettings } from "./ui-settings"
import "../../../src/index.css"

// The real composer sends through the real send action into the real transcript;
// the fake native client records what the model would receive.
const instanceId = "pasted-fence"
const sessionId = "ses_fence"
const prompts: Array<{ text: string }> = []
const client = {
  skill: { list: async () => ({ data: [] }) },
  session: {
    active: async () => ({}),
    inbox: { list: async () => ({ data: [] }) },
    instructions: { entry: { put: async () => ({}) } },
    switchAgent: async () => ({}),
    switchModel: async () => ({}),
    prompt: async (input: { text: string }) => { prompts.push({ text: input.text }); return {} },
  },
  message: { list: async () => ({ data: [], cursor: {} }) },
}
;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
addInstance({ id: instanceId, folder: "/fixture", port: 0, pid: 0, proxyPath: `/workspaces/${instanceId}/instance`, status: "ready", client: client as any })
setActiveInstanceId(instanceId)
setSessions(previous => new Map(previous).set(instanceId, new Map([[sessionId, {
  id: sessionId, instanceId, parentId: null, title: "Pasted fence", location: { directory: "/fixture" },
  status: "idle", agent: "", model: { providerId: "", modelId: "" }, time: { created: 1, updated: 2 },
} as any]])))
setActiveSession(instanceId, sessionId)
sseManager.getStatuses = () => new Map([[instanceId, "connected"]])
serverApi.fetchPermissionReceipts = async () => ({ receipts: [] })
await applyUiSettings({ showMessageTimeline: false, locale: "en" })
await loadMessages(instanceId, sessionId, { force: true })
render(() => <ConfigProvider><I18nProvider><ThemeProvider><main style={{ width: "min(800px, 100%)" }}>
  <div style={{ height: "520px", display: "flex" }}>
    <MessageSection instanceId={instanceId} sessionId={sessionId} isActive={true} />
  </div>
  <PromptInput instanceId={instanceId} sessionId={sessionId} instanceFolder="/fixture" isActive={true}
    onSend={async (prompt, attachments) => { await sendMessage(instanceId, sessionId, prompt, attachments) }} />
</main></ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
;(window as any).fixture = { prompts }
