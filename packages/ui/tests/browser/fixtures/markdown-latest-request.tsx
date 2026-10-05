import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { Markdown } from "../../../src/components/markdown"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { clearCacheForSession, getCacheEntry } from "../../../src/lib/global-cache"
import type { TextPart } from "../../../src/types/message"

let releaseModule!: () => void
const audit = {
  moduleReady: new Promise<void>(resolve => { releaseModule = resolve }),
  moduleWaiting: false,
  calls: [] as Array<{ text: string; theme: string }>,
  pendingChecks: 0,
  holdResults: false,
  results: [] as Array<() => void>,
  retry: () => {},
}
;(window as any).markdownAudit = audit

const [part, setPart] = createSignal<TextPart>({ id: "markdown-part", type: "text", text: "**Initial**", version: 0 })
const [isDark, setDark] = createSignal(false)
const [disableHighlight, setDisableHighlight] = createSignal(true)
let notifications = 0
const dispose = render(() => <ConfigProvider><I18nProvider>
  <Markdown part={part()} instanceId="markdown-instance" sessionId="markdown-session" isDark={isDark()}
    disableHighlight={disableHighlight()} onRendered={() => { notifications++ }} />
</I18nProvider></ConfigProvider>, document.getElementById("root")!)

;(window as any).fixture = {
  audit, releaseModule, dispose,
  update(text: string, version: number) { setPart({ id: "markdown-part", type: "text", text, version }) },
  burst(count: number, sameKey = false) {
    for (let index = 1; index <= count; index++) {
      setPart({ ...part(), text: sameKey ? part().text : `**Burst ${index}**`, version: sameKey ? part().version : index })
    }
  },
  setDark, setDisableHighlight,
  cacheLocal() {
    setPart({ ...part(), renderCache: { text: part().text, html: "<strong>Local cache</strong>", theme: isDark() ? "dark" : "light",
      mode: `${part().version}:raw:wrap` } })
  },
  clearCache: () => clearCacheForSession("markdown-instance", "markdown-session"),
  cached() {
    return getCacheEntry({ instanceId: "markdown-instance", sessionId: "markdown-session", scope: "markdown",
      cacheId: `markdown-part:${isDark() ? "dark" : "light"}:${disableHighlight() ? 0 : 1}:0:1`, version: String(part().version) })
  },
  notifications: () => notifications,
  releaseResult(index = 0) { audit.results.splice(index, 1)[0]?.() },
}
