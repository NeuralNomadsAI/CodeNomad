import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import MessageItem from "../../../src/components/message-item"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { loadSpeechCapabilities } from "../../../src/stores/speech"
import { applyUiSettings } from "./ui-settings"
import "../../../src/index.css"

const [record, setRecord] = createSignal<any>({ id: "actions", role: "assistant", status: "complete", createdAt: 1 })
const [text, setText] = createSignal("initial text")
const [completed, setCompleted] = createSignal<number>()
const [technical, setTechnical] = createSignal<any[]>([])
const [pending, setPending] = createSignal<any>()
await applyUiSettings({ locale: "en" })
render(() => <ConfigProvider><I18nProvider><ThemeProvider><MessageItem
  record={record()} parts={[{ id: "text", type: "text", text: text() }]}
  messageInfo={{ role: "assistant", time: { created: 1, completed: completed() } } as any}
  instanceId="actions" sessionId="actions" onFork={() => {}} onRevert={() => {}}
  pendingPrompt={pending()} onPendingPromptEdit={() => {}} onPendingPromptRemove={() => {}}
  onPendingPromptDeliveryChange={() => {}} showTechnicalCleanup={true} technicalCleanupParts={technical}
/></ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
;(window as any).streamActionState = {
  record: (patch: object) => setRecord(current => ({ ...current, ...patch })),
  text: setText, completed: setCompleted, pending: setPending,
  technical: (types: string[]) => setTechnical(types.map((type, index) => ({ type, messageId: "actions", partId: String(index) }))),
  capabilities: () => loadSpeechCapabilities(true),
}
