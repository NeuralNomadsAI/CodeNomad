import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import ToolCall from "../../../src/components/tool-call"
import VirtualFollowList, { type VirtualFollowListApi } from "../../../src/components/virtual-follow-list"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import type { ToolCallPart } from "../../../src/components/tool-call/types"
import "../../../src/index.css"

const output = Array.from({ length: 160 }, (_, i) => `Shell output line ${i}`).join("\n")
const [items, setItems] = createSignal(Array.from({ length: 30 }, (_, i): ToolCallPart => ({
  id: `tool-${i}`, type: "tool", callID: `call-${i}`, tool: "shell",
  state: { status: "completed", input: {}, output },
})))
let api: VirtualFollowListApi | undefined
function Transcript() {
  return <VirtualFollowList items={items} getKey={item => item.id}
    registerApi={value => { api = value }}
    renderItem={item => <div style={{ width: "650px", padding: "30px 0" }}>
      <ToolCall toolCall={item} messageId={`message-${item.id}`} instanceId="scroll-fixture"
        sessionId="session-fixture" onContentRendered={() => api?.notifyContentRendered()} />
    </div>} />
}
render(() => <ConfigProvider><I18nProvider><ThemeProvider>
  <Transcript />
</ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
;(window as any).fixture = {
  bottom: () => api?.scrollToBottom({ immediate: true }),
  top: () => api?.scrollToTop({ immediate: true }),
  append: () => setItems(items => [...items, { ...items[0], id: `tool-${items.length}`, callID: `call-${items.length}` }]),
  snapshot: () => ({ outerFollow: api?.getAutoScroll(), outerTop: api?.getScrollElement()?.scrollTop }),
}
