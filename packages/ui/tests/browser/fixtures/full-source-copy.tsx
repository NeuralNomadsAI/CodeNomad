import { render } from "solid-js/web"
import MessageSection from "../../../src/components/message-section"
import TranscriptFilters from "../../../src/components/transcript-filters"
import { transcriptPresetPatch } from "../../../src/components/transcript-visibility"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { applyUiSettings } from "./ui-settings"
import { sdkManager } from "../../../src/lib/sdk-manager"
import { addInstance } from "../../../src/stores/instances"
import { setSessions, setActiveSession } from "../../../src/stores/session-state"
import { sseManager } from "../../../src/lib/sse-manager"
import { loadMessages } from "../../../src/stores/session-api"
import "../../../src/index.css"

const scenario = new URLSearchParams(location.search).get("scenario")
const toolDisclosureScenario = scenario === "tool-group-disclosure"
const instanceId = "full-source-instance", sessionId = "full-source-session", messageId = "full-source-message"
const filePath = "/fixture/example.ts"
const diagnostics = { [filePath]: Array.from({ length: scenario === "diagnostics-long" ? 1 : 137 }, (_, index) => ({
  message: scenario === "diagnostics-long"
    ? `Long diagnostic: ${"完整 diagnostic text ".repeat(250)}END-DIAGNOSTIC`
    : `Diagnostic ${String(index).padStart(3, "0")} 完整`,
  severity: 1, range: { start: { line: index, character: 2 } },
})) }
const todos = Array.from({ length: 237 }, (_, index) => ({
  id: `todo-${index}`, content: `Task ${String(index).padStart(3, "0")} 完整`, status: "pending", priority: "medium",
}))
const error = `Error start: ${"Original error 完整\n".repeat(900)}END-ERROR`
const textParts = Array.from({ length: 1237 }, (_, index) => ({
  type: "text", text: `Paragraph ${String(index).padStart(4, "0")} 完整.\n\n`,
}))
const input = { filePath, payload: `INPUT-START ${"Untruncated input 完整 ".repeat(1200)} INPUT-END`, nested: { retained: true } }
const output = "Distinct output: this is not the tool input"
const patchFiles = [
  { file: "new.txt", source: "new.txt", status: "added" },
  { file: "old.txt", source: "old.txt", status: "deleted" },
  { file: "right/shared.ts", source: "old/previous.ts", status: "modified", addition: "renamedAfter" },
  { file: "left/shared.ts", source: "left/shared.ts", status: "modified", addition: "modifiedAfter" },
  { file: "src/Foo.ts", source: "src/foo.ts", status: "modified" },
].map(({ file, source, status, addition }) => ({
  file, status, additions: Number(Boolean(addition)), deletions: Number(Boolean(addition)),
  patch: `Index: /fixture/${source}\n===================================================================\n--- /fixture/${source}\n+++ /fixture/${source}\n`
    + (addition ? `@@ -1,1 +1,1 @@\n-before\n+${addition}\n` : ""),
}))
const name = scenario === "patch" ? "patch" : scenario === "todo" ? "todowrite" : scenario === "error" || scenario === "input" ? "read" : "edit"
const tool = {
  id: "full-source-tool", type: "tool", name, time: { created: 1, completed: 2 },
  state: scenario === "error"
    ? { status: "error", input: { filePath }, error: { type: "unknown", message: error } }
    : { status: "completed", input: scenario === "patch" ? {} : scenario === "input" ? input : { filePath },
        metadata: scenario === "patch" ? { files: patchFiles } : scenario === "todo" ? { todos } : scenario === "input" ? {} : { diagnostics },
        content: [{ type: "text", text: scenario === "patch" ? "Success. Updated the following files:\nA new.txt\nD old.txt\nM right/shared.ts\nM left/shared.ts\nM src/Foo.ts" : scenario === "input" ? output : "Tool completed" }] },
}
// A tool inside the omitted range proves derived projections follow the reveal.
const hiddenTool = { id: "hidden-range-tool", type: "tool", name: "read", time: { created: 1, completed: 2 },
  state: { status: "completed", input: { filePath: "/fixture/hidden-range.ts" }, metadata: {}, content: [{ type: "text", text: "hidden range" }] } }
// Consecutive reads at the start of the omitted range form a collapsed exploration group.
const reads = (prefix: string, count = 3) => Array.from({ length: count }, (_, index) => ({ ...hiddenTool, id: `${prefix}-read-${index}`,
  state: { ...hiddenTool.state, input: { filePath: `/fixture/${prefix}-${index}.ts` } } }))
const groupReads = reads("group")
const shellCalls = ["git status --short", "git diff --stat", "git log -1 --oneline"].map((command, index) => ({
  ...hiddenTool, id: `group-shell-${index}`, name: "bash",
  state: { ...hiddenTool.state, input: { command, description: command }, content: [{ type: "text", text: "Command completed" }] },
}))
// Native API records enter through the real load/normalize/store/display path.
const message = { id: messageId, type: "assistant", agent: "build", model: { providerID: "fixture", id: "fixture" },
  time: { created: 1, completed: 2 },
  content: scenario === "parts" ? [...textParts.slice(0, 600), hiddenTool, ...textParts.slice(600)]
    : scenario === "parts-group" ? [...textParts.slice(0, 500), ...groupReads, ...textParts.slice(500)]
    // The head ends with one read; revealed reads merge into its group.
    : scenario === "parts-merge" ? [...textParts.slice(0, 499), ...reads("merge"), ...textParts.slice(499)]
    // More than one reveal step: revealed text merges into the head row and a placeholder remains.
    : scenario === "parts-long" ? Array.from({ length: 2237 }, (_, index) => ({ type: "text", text: `Paragraph ${String(index).padStart(4, "0")} 完整.\n\n` }))
    // A tail of hidden reads renders short, so the placeholder is visible while following the bottom.
    : scenario === "parts-short-tail" ? [...textParts.slice(0, 1000), ...reads("tail", 499), textParts[1000]]
    // The head ends with a two-read group the test expands before revealing two more.
    : scenario === "parts-merge-expanded" ? [...textParts.slice(0, 498), ...reads("expanded", 4), ...textParts.slice(498)]
    : toolDisclosureScenario ? [...shellCalls.slice(0, 2), tool]
    : [tool] }
const groupTime = Date.UTC(2026, 10, 10, 9, 30)
const messages = scenario === "tool-groups" ? [
  { ...message, id: "group-answer", time: { created: groupTime + 4000, completed: groupTime + 5000 },
    content: [{ type: "text", text: "I reviewed the files and checked the working tree. No further changes are needed." }] },
  { ...message, id: "group-second", time: { created: groupTime + 3000, completed: groupTime + 4000 }, content: [groupReads[2], ...shellCalls] },
  { ...message, time: { created: groupTime + 1000, completed: groupTime + 3000 }, content: groupReads.slice(0, 2) },
  { id: "group-prompt", type: "user", time: { created: groupTime }, text: "Review the pending changes and summarize the result." },
] : [message]
const requests: string[] = []
const client: any = {
  session: { active: async () => ({}), inbox: { list: async () => ({ data: [] }) },
    get: async () => ({ id: sessionId, location: { directory: "/fixture" }, time: { created: 1, updated: 2 } }) },
  message: { list: async () => { requests.push(sessionId); return { data: messages, cursor: {} } } },
}
;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
sseManager.getStatuses = () => new Map([[instanceId, "connected"]])
addInstance({ id: instanceId, folder: "/fixture", port: 0, pid: 0, proxyPath: "", status: "ready", client })
setSessions(previous => new Map(previous).set(instanceId, new Map([[sessionId, {
  id: sessionId, instanceId, parentId: null, title: "Full source copy", location: { directory: "/fixture" },
  status: "idle", agent: "build", model: { providerId: "fixture", modelId: "fixture" }, time: { created: 1, updated: 2 },
} as any]])))
setActiveSession(instanceId, sessionId)
await applyUiSettings({ showMessageTimeline: scenario === "parts", toolInputsVisibility: scenario === "input" ? "expanded" : "hidden", toolOutputExpansion: "expanded",
  diagnosticsExpansion: "collapsed",
  toolCallExpansionDefaults: { preset: "custom", thinking: "collapsed", tools: { patch: "expanded", edit: "expanded",
    read: scenario === "parts-short-tail" ? "hidden" : scenario === "tool-groups" ? "collapsed" : "expanded",
    bash: "collapsed", other: "expanded" } },
  ...(toolDisclosureScenario ? transcriptPresetPatch("minimal") : {}),
})
await loadMessages(instanceId, sessionId, { force: true })
render(() => <ConfigProvider><I18nProvider><ThemeProvider>
  {(scenario === "tool-groups" || toolDisclosureScenario) && <header style={{ display: "flex", "justify-content": "end", width: "1000px" }}><TranscriptFilters /></header>}
  <main style={{ display: "flex", height: scenario === "tool-groups" ? "500px" : "800px", width: "1000px" }}>
    <MessageSection instanceId={instanceId} sessionId={sessionId} isActive={true} />
  </main>
</ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
// Expected payloads are the original inputs, never bounded renderer projections.
;(window as any).fixture = { diagnostics, todos, error, textParts, input, output, patchFiles, sessionId, messageId, requests }
