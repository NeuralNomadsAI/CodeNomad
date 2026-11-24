import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import ToolCall from "../../../src/components/tool-call"
import FormRequest from "../../../src/components/form-request"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { applyUiSettings } from "./ui-settings"
import "../../../src/index.css"

const [output, setOutput] = createSignal("## [Native result](https://example.org/article)\nPublished: 2026-09-26T00:00:00Z\n\n<script>literal snippet</script>")
const [answer, setAnswer] = createSignal("")
const form: any = { id: "consent", title: "Web Search", metadata: { kind: "websearch.provider" }, fields: [
  { key: "choice", description: "Allow web search?", type: "string", required: true, custom: false,
    options: [{ value: "allow", label: "Allow via Search Provider" }, { value: "choose", label: "Choose another provider" }, { value: "disable", label: "Disable web search" }] },
] }
await applyUiSettings({ toolInputsVisibility: "hidden", toolCallExpansionDefaults: { preset: "everything", tools: {} } })
render(() => <ConfigProvider><I18nProvider><ThemeProvider><main style={{ width: "min(700px, 100%)" }}>
  <ToolCall instanceId="fixture" sessionId="session" toolCall={{ type: "tool", id: "tool", tool: "websearch",
    state: { status: "completed", input: { query: "native results" }, metadata: { provider: "fixture" }, output: output() } } as any} />
  <FormRequest form={form} onReply={async value => { setAnswer(JSON.stringify(value)) }} onCancel={async () => { setAnswer("cancelled") }} />
  <output>{answer()}</output>
</main></ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
;(window as any).fixture = { setOutput }
