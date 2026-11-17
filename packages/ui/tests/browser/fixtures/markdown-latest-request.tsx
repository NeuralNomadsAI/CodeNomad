import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { Markdown } from "../../../src/components/markdown"
import { ConfigProvider, highContrastPreference, setHighContrastPreference, setColorSchemePreference, setThemePreference } from "../../../src/stores/preferences"
import { ThemeProvider } from "../../../src/lib/theme"
import { useTheme as useMuiTheme } from "@suid/material/styles"
import Paper from "@suid/material/Paper"
import Typography from "@suid/material/Typography"
import { createCssColorResolver } from "../../../src/lib/css-color"
import { normalizeColorScheme } from "../../../src/lib/theme-scheme"
import "../../../src/index.css"
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
const [streaming, setStreaming] = createSignal(false)
let notifications = 0
let mui: ReturnType<typeof useMuiTheme>
function MuiProbe() {
  mui = useMuiTheme()
  return <Paper id="mui-paper"><Typography id="mui-secondary" color="text.secondary">Secondary text</Typography></Paper>
}
const dispose = render(() => <ConfigProvider><I18nProvider><ThemeProvider>
  <MuiProbe />
  <Markdown part={part()} instanceId="markdown-instance" sessionId="markdown-session" isDark={isDark()}
    disableHighlight={disableHighlight()} streaming={streaming()} onRendered={() => { notifications++ }} />
</ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)

;(window as any).fixture = {
  audit, releaseModule, dispose,
  update(text: string, version: number) { setPart({ id: "markdown-part", type: "text", text, version }) },
  burst(count: number, sameKey = false) {
    for (let index = 1; index <= count; index++) {
      setPart({ ...part(), text: sameKey ? part().text : `**Burst ${index}**`, version: sameKey ? part().version : index })
    }
  },
  setDark, setDisableHighlight, setStreaming,
  contrast: setHighContrastPreference,
  contrastPreference: highContrastPreference,
  async palette(id: string) {
    const scheme = normalizeColorScheme(id)
    await setColorSchemePreference(scheme)
    await setThemePreference(scheme.appearance)
    setDark(scheme.appearance === "dark")
  },
  mui: () => ({ ...mui.palette }),
  codeColors() {
    const canvas = document.createElement("canvas"), context = canvas.getContext("2d")!
    canvas.width = canvas.height = 1
    const hex = (color: string) => {
      context.clearRect(0, 0, 1, 1)
      context.fillStyle = color
      context.fillRect(0, 0, 1, 1)
      return "#" + Array.from(context.getImageData(0, 0, 1, 1).data.slice(0, 3), n => n.toString(16).padStart(2, "0")).join("")
    }
    return {
      background: hex(getComputedStyle(document.querySelector(".markdown-code-block")!).backgroundColor),
      colors: Array.from(document.querySelectorAll<HTMLElement>(".shiki span[style]"), el => hex(getComputedStyle(el).color)),
      mui: { ...mui.palette },
      muiRendered: { background: hex(getComputedStyle(document.getElementById("mui-paper")!).backgroundColor),
        backgroundImage: getComputedStyle(document.getElementById("mui-paper")!).backgroundImage,
        secondary: hex(getComputedStyle(document.getElementById("mui-secondary")!).color) },
    }
  },
  roles() {
    const resolver = createCssColorResolver()
    try {
      return Object.fromEntries((["background", "foreground", "selection", "selectionText"] as const)
        .map(role => [role, resolver.resolve("--surface-canvas", role)]))
    } finally { resolver.dispose() }
  },
  cacheLocal() {
    setPart({ ...part(), renderCache: { text: part().text, html: "<strong>Local cache</strong>", theme: isDark() ? "dark" : "light",
      mode: `${part().version}:raw:wrap` } })
  },
  clearCache: () => clearCacheForSession("markdown-instance", "markdown-session"),
  cached() {
    return getCacheEntry({ instanceId: "markdown-instance", sessionId: "markdown-session", scope: "markdown",
      cacheId: `markdown-part:${document.querySelector(".markdown-body")?.getAttribute("data-markdown-theme")}:${disableHighlight() ? 0 : 1}:0:1`, version: String(part().version) })
  },
  notifications: () => notifications,
  releaseResult(index = 0) { audit.results.splice(index, 1)[0]?.() },
}
