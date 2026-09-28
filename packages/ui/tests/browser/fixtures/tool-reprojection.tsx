import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import ToolCall from "../../../src/components/tool-call"
import { ConfigProvider } from "../../../src/stores/preferences"
import { applyUiSettings } from "./ui-settings"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import type { ToolCallPart } from "../../../src/components/tool-call/types"
import "../../../src/index.css"

const output = Array.from({ length: 160 }, (_, i) => `Native tool fixture line ${i}`).join("\n")
const [part, setPart] = createSignal<ToolCallPart>({
  id: "tool-fixture", type: "tool", callID: "call-fixture", tool: "shell", state: { status: "completed", input: {}, output },
})
const [version, setVersion] = createSignal(1)
const originalPart = part()
// The test expands the output by clicking its header, so the fixture pins
// shell tools collapsed instead of depending on the preset defaults.
await applyUiSettings({ toolCallExpansionDefaults: { preset: "custom", thinking: "collapsed", tools: { bash: "collapsed" } } })
render(() => <ConfigProvider><I18nProvider><ThemeProvider>
  <div style={{ width: "650px", padding: "80px 0" }}>
    <ToolCall toolCall={part()} messageId="message-fixture" instanceId="tool-fixture" sessionId="session-fixture" partVersion={version()} />
  </div>
</ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
;(window as any).fixture = {
  reproject: () => { setPart(current => structuredClone(current)); setVersion(v => v + 1) },
  snapshot: () => part(),
  originalOutput: () => originalPart.state.status === "completed" ? originalPart.state.output : undefined,
  changeOutput: () => { setPart(current => ({ ...current, state: { status: "completed", input: {}, output: "Changed native output" } })); setVersion(v => v + 1) },
  mutateOutput: () => { const state = part().state; if (state.status === "completed") state.output = "Versioned in-place output"; setVersion(v => v + 1) },
  fail: () => { setPart(current => ({ ...current, state: { status: "error", input: {}, error: "Changed native error" } })); setVersion(v => v + 1) },
}
