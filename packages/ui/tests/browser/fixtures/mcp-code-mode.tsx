import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { McpCodeModeControls } from "../../../src/components/mcp-code-mode-controls"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { serverApi } from "../../../src/lib/api-client"
import { serverEvents } from "../../../src/lib/server-events"
import { applyUiSettings } from "./ui-settings"
import "../../../src/index.css"
const [directory, setDirectory] = createSignal("/a")
const [active, setActive] = createSignal(true)
let mode: boolean | null = null, fail = false, reads = 0, release: (() => void) | undefined, defer = false
const writes: any[] = []
serverApi.getMcpCodeMode = async (_id, directory) => {
  reads++
  const captured = mode
  if (defer) { defer = false; await new Promise<void>(resolve => { release = resolve }) }
  return [{ server: directory === "/a" ? "fixture" : "other", effective: captured !== false, scopes: [{ scope: "global", path: "/global", mode: captured }] }]
}
serverApi.setMcpCodeMode = async (_id, payload) => { writes.push(payload); if (fail) { fail = false; throw new Error("fixture failure") }; mode = payload.mode }
await applyUiSettings({})
render(() => <ConfigProvider><I18nProvider><ThemeProvider><main style={{ width: "340px" }}><McpCodeModeControls instanceId="mcp" directory={directory()} active={active()} /></main></ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
;(window as any).fixture = { writes, reads: () => reads, setDirectory, setActive, fail: () => { fail = true }, defer: () => { defer = true }, release: () => release?.(),
  refresh: () => (serverEvents as any).dispatch({ type: "instance.event", instanceId: "mcp", event: { type: "config.updated", data: {} } }) }
