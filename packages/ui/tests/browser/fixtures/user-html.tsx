import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import MessagePart from "../../../src/components/message-part"
import MessageTimeline from "../../../src/components/message-timeline"
import { Markdown } from "../../../src/components/markdown"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import "../../../src/index.css"

const html = '<div class="sample-html">outer\n<span title="original">who</span> , message\n{children ?? null}\n</div>'
const code = '<span title="&lt;source&gt;">&amp;</span>'
const body = ["**Markdown still works**", html, "`" + code + "`", "```html\n" + code + "\n```"].join("\n\n")
const malformed = 'Please explain <code><img/src=x onerror="window.htmlExecuted=true"></code> literally\n\ntext <script>if (x<y) z()</script> after'
const [literal, setLiteral] = createSignal(true)
const part = { id: "cached-part", type: "text" as const, text: html, version: 1,
  renderCache: { text: html, html: '<div class="cached-html">old sanitized HTML</div>', theme: "light", mode: "1:escaped:wrap" } }

render(() => <ConfigProvider><I18nProvider><ThemeProvider>
  <section id="user"><MessagePart part={{ type: "text", id: "user", text: body }} messageType="user" instanceId="html" sessionId="session" /></section>
  <section id="assistant"><MessagePart part={{ type: "text", id: "assistant", text: html }} messageType="assistant" instanceId="html" sessionId="session" /></section>
  <section id="malformed"><MessagePart part={{ type: "text", id: "malformed", text: malformed }} messageType="user" instanceId="html" sessionId="session" /></section>
  <section id="pasted"><MessagePart part={{ type: "text", id: "pasted", text: html }} messageType="user" instanceId="html" sessionId="session"
    displayMetadataOverride={{ segments: [{ kind: "pasted", length: html.length }] }} /></section>
  <section id="cache"><Markdown part={part} instanceId="html" sessionId="session" isDark={false} escapeRawHtml literalRawHtml={literal()} /></section>
  <div style={{ height: "160px", width: "50px" }}><MessageTimeline instanceId="html" sessionId="session" segments={[
    { id: "user-preview", messageId: "user-preview", type: "user", label: "User preview", tooltip: html, totalChars: html.length },
    { id: "assistant-preview", messageId: "assistant-preview", type: "assistant", label: "Assistant preview", tooltip: html, totalChars: html.length },
  ]} /></div>
</ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
;(window as any).fixture = { html, code, malformed, literal: setLiteral }
