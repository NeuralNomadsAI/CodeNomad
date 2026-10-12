import { render } from "solid-js/web"
import MessageSection from "../../../src/components/message-section"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { applyUiSettings } from "./ui-settings"
import { sdkManager } from "../../../src/lib/sdk-manager"
import { serverApi } from "../../../src/lib/api-client"
import { addInstance } from "../../../src/stores/instances"
import { setSessions, setActiveSession } from "../../../src/stores/session-state"
import { setSessionSearchOpen } from "../../../src/stores/session-search"
import { sseManager } from "../../../src/lib/sse-manager"
import { loadMessages } from "../../../src/stores/session-api"
import { messageStoreBus } from "../../../src/stores/message-v2/bus"
import type { ClientPart } from "../../../src/types/message"
import "../../../src/index.css"

// One native agent turn with thousands of parts through the real load/normalize/
// store/MessageSection path. Text heights vary so chunk estimates are wrong.
const streaming = new URLSearchParams(location.search).get("scenario") === "streaming"
const instanceId = "virtual-parts-instance", sessionId = "virtual-parts-session", messageId = "virtual-parts-message"
const partCount = 3000, farPart = 1501
const label = (index: number) => `Part ${String(index).padStart(4, "0")}`
const text = (index: number) => `${label(index)}${index === farPart ? " FAR-TARGET" : ""}\n\n${"Body line.\n\n".repeat(index % 4)}`
const content = Array.from({ length: partCount }, (_, index) => index % 3 === 2
  ? { id: `tool-${index}`, type: "tool", name: "read", time: { created: 1, completed: 2 },
      state: { status: "completed", input: { filePath: `/fixture/${label(index)}.ts` }, metadata: {}, content: [{ type: "text", text: label(index) }] } }
  : { type: "text", text: text(index) })
const model = { providerID: "fixture", id: "fixture" }
const messages = [
  { id: "virtual-parts-prompt", type: "user", text: "Run the long task", time: { created: 1 } },
  { id: messageId, type: "assistant", agent: "build", model, time: streaming ? { created: 2 } : { created: 2, completed: 3 }, content },
]
const client: any = {
  session: { active: async () => ({}), inbox: { list: async () => ({ data: [] }) },
    get: async () => ({ id: sessionId, location: { directory: "/fixture" }, time: { created: 1, updated: 2 } }) },
  message: { list: async () => ({ data: [...messages].reverse(), cursor: {} }) },
}
serverApi.querySessionHistory = async (_instanceId, input) => {
  const query = input.query.trim().toLocaleLowerCase()
  const partIndex = content.findIndex((part) => part.type === "text" && part.text.toLocaleLowerCase().includes(query))
  const hits = partIndex < 0 ? [] : [{ sessionID: sessionId, messageID: messageId, role: "assistant" as const, partIndex,
    kind: "text" as const, excerpt: (content[partIndex] as { text: string }).text }]
  return { status: "page" as const, scanned: messages.length, tools: 0, reasoning: 0, skipped: 0, hits, candidates: [], cursor: null }
}
;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
sseManager.getStatuses = () => new Map([[instanceId, "connected"]])
addInstance({ id: instanceId, folder: "/fixture", port: 0, pid: 0, proxyPath: "", status: "ready", client })
setSessions(previous => new Map(previous).set(instanceId, new Map([[sessionId, {
  id: sessionId, instanceId, parentId: null, title: "Long agent turn", location: { directory: "/fixture" },
  status: streaming ? "working" : "idle", agent: "build", model: { providerId: "fixture", modelId: "fixture" }, time: { created: 1, updated: 2 },
} as any]])))
setActiveSession(instanceId, sessionId)
await applyUiSettings({ locale: "en", showMessageTimeline: false, toolInputsVisibility: "hidden", toolOutputExpansion: "expanded",
  toolCallExpansionDefaults: { preset: "custom", thinking: "collapsed", tools: { read: "collapsed", other: "collapsed" } } })
await loadMessages(instanceId, sessionId, { force: true })
render(() => <ConfigProvider><I18nProvider><ThemeProvider>
  <main style={{ display: "flex", height: "800px", width: "1000px" }}>
    <MessageSection instanceId={instanceId} sessionId={sessionId} isActive={true} />
  </main>
</ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)

const store = messageStoreBus.getOrCreate(instanceId)
let appended = partCount
;(window as any).fixture = {
  messageId, partCount, farPart,
  /** Appends text parts to the streaming turn, as native deltas do. */
  append: (count: number) => {
    const record = store.getMessage(messageId)!
    const parts = record.partIds.map((id) => record.parts[id]!.data as ClientPart)
    for (let index = 0; index < count; index++, appended++) {
      parts.push({ id: `${messageId}-text-${appended}`, type: "text", text: text(appended), sessionID: sessionId, messageID: messageId } as ClientPart)
    }
    store.upsertMessage({ id: messageId, sessionId, role: "assistant", status: "streaming", parts })
    return `${messageId}-text-${appended - 1}`
  },
  openSearch: () => setSessionSearchOpen(instanceId, sessionId, true),
}
