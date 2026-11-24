import { Show, createSignal } from "solid-js"
import { render } from "solid-js/web"
import MessageSection from "../../../src/components/message-section"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { applyUiSettings } from "./ui-settings"
import { sdkManager } from "../../../src/lib/sdk-manager"
import { addInstance } from "../../../src/stores/instances"
import { setSessions, setActiveSession } from "../../../src/stores/session-state"
import { sseManager } from "../../../src/lib/sse-manager"
import { loadMessages } from "../../../src/stores/session-api"
import { getRenderTextWindow, MARKDOWN_TEXT_RENDER_CHARACTER_LIMIT, TOOL_OUTPUT_RENDER_CHARACTER_LIMIT } from "../../../src/lib/render-text-window"
import "../../../src/index.css"

// Native API records enter through the real load/normalize/store/display path.
const instanceId = "reveal-instance", model = { providerID: "fixture", id: "fixture" }
const paragraph = (index: number) => `Paragraph ${String(index).padStart(4, "0")}: the subagent reviewed one more rendering path and recorded its evidence.\n\n`
const text = Array.from({ length: 820 }, (_, index) => paragraph(index)).join("") + "TEXT-TAIL-PROOF"
const readOutput = Array.from({ length: 900 }, (_, index) => `read line ${String(index).padStart(4, "0")} ok`).join("\n") + "\nREAD-TAIL-PROOF"
// The reported case: a subagent's final report just over the former 10 000-character bound.
const report = `## Report\n\n${"Verified the transcript bound. ".repeat(350)}`.slice(0, 10_865 - "REPORT-TAIL-PROOF".length) + "REPORT-TAIL-PROOF"
const filler = (session: string, index: number) => ({
  id: `msg_${session}_${String(index).padStart(4, "0")}`, type: "assistant", agent: "build", model,
  time: { created: index + 1, completed: index + 1 },
  content: [{ type: "text", text: `Filler ${index}\n\n${"A previously rendered response.\n\n".repeat(4)}` }],
})
const longMessage = {
  id: "msg_a_long", type: "assistant", agent: "build", model, time: { created: 500, completed: 501 },
  content: [
    { type: "text", text },
    { id: "prt_long_read", type: "tool", name: "read", time: { created: 500, completed: 501 },
      state: { status: "completed", input: { filePath: "/fixture/long.log" }, metadata: {}, content: [{ type: "text", text: readOutput }] } },
    { id: "prt_long_task", type: "tool", name: "task", time: { created: 500, completed: 501 },
      state: { status: "completed", input: { description: "Review", prompt: "Review the transcript bound.", subagent_type: "general" }, metadata: {},
        content: [{ type: "text", text: report }] } },
  ],
}
const messages: Record<string, any[]> = {
  "reveal-a": [...Array.from({ length: 20 }, (_, index) => filler("a", index)), longMessage, ...Array.from({ length: 40 }, (_, index) => filler("a", 600 + index))],
  "reveal-b": [filler("b", 0)],
  // The long text is the latest message, so its reveal line is visible while the list follows the bottom.
  "reveal-c": [filler("c", 0), { id: "msg_c_long", type: "assistant", agent: "build", model, time: { created: 10, completed: 11 }, content: [{ type: "text", text }] }],
}
const client: any = {
  session: { active: async () => ({}), inbox: { list: async () => ({ data: [] }) },
    get: async ({ sessionID }: any) => ({ id: sessionID, location: { directory: "/fixture" }, time: { created: 1, updated: 2 } }) },
  message: { list: async ({ sessionID, cursor }: any) => ({ data: cursor ? [] : [...messages[sessionID]].reverse(), cursor: {} }) },
}
;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
sseManager.getStatuses = () => new Map([[instanceId, "connected"]])
addInstance({ id: instanceId, folder: "/fixture", port: 0, pid: 0, proxyPath: "", status: "ready", client })
setSessions(previous => new Map(previous).set(instanceId, new Map(Object.keys(messages).map(id => [id, {
  id, instanceId, parentId: null, title: id, location: { directory: "/fixture" },
  status: "idle", agent: "build", model: { providerId: "fixture", modelId: "fixture" }, time: { created: 1, updated: 2 },
} as any]))))
setActiveSession(instanceId, "reveal-a")
await applyUiSettings({ toolInputsVisibility: "hidden", toolOutputExpansion: "expanded", diagnosticsExpansion: "collapsed",
  toolCallExpansionDefaults: { preset: "custom", thinking: "collapsed", tools: { read: "expanded", task: "expanded", other: "expanded" } } })
await loadMessages(instanceId, "reveal-a", { force: true })
await loadMessages(instanceId, "reveal-b", { force: true })
await loadMessages(instanceId, "reveal-c", { force: true })
const initialSession = new URLSearchParams(location.search).get("session") ?? "reveal-a"
setActiveSession(instanceId, initialSession)
const [session, setSession] = createSignal(initialSession)
render(() => <ConfigProvider><I18nProvider><ThemeProvider>
  <main style={{ display: "flex", height: "800px", width: "1000px" }}>
    <Show when={session()} keyed>{(id) => <MessageSection instanceId={instanceId} sessionId={id} isActive={true} />}</Show>
  </main>
</ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)

const textWindow = getRenderTextWindow(text, MARKDOWN_TEXT_RENDER_CHARACTER_LIMIT)
;(window as any).fixture = {
  text, readOutput, report,
  textHidden: textWindow.hidden,
  readHidden: getRenderTextWindow(readOutput, TOOL_OUTPUT_RENDER_CHARACTER_LIMIT).hidden,
  // The first paragraph label the bounded text part does not render.
  firstHiddenParagraph: text.slice(textWindow.text.length).match(/Paragraph \d{4}/)![0],
  switchTo: (id: string) => { setActiveSession(instanceId, id); setSession(id) },
}
