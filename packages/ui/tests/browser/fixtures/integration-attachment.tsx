import "./header-windows"
import { createSignal, Show } from "solid-js"
import { render } from "solid-js/web"
import { PluginActivationControls } from "../../../src/components/plugin-activation-controls"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider, tGlobal } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { activeSessionId, sessions, setSessions } from "../../../src/stores/session-state"
import { serverApi } from "../../../src/lib/api-client"
import { serverEvents } from "../../../src/lib/server-events"
import { integrations } from "../../../src/stores/integrations"
import { getToastHistory } from "../../../src/lib/notifications"

const id = "header-windows"
const [plugins, setPlugins] = createSignal(false)
const [directory, setDirectory] = createSignal("/repo")
const [active, setActive] = createSignal(true)
const [sessionless, setSessionless] = createSignal(false)
const [pluginInstance, setPluginInstance] = createSignal(id)
let stoppedRelease: (() => void) | undefined
const root = document.createElement("div")
document.body.append(root)
const source = { scope: "global" as const, entryIndex: 4, target: "@fixture/blender", path: "/config/opencode.jsonc", pluginId: "neuralnomads.blender", hasOptions: false }
const runtime = { key: "blender", id: "neuralnomads.blender", source: { type: "package" as const, target: source.target, version: "1.0.0" }, state: { status: "active" as const }, features: {} }
serverApi.getPluginControls = async () => ({ location: { directory: directory() }, runtime: [runtime],
  configured: { sources: [source], rules: [] },
  controls: [{ id: runtime.id, builtin: false, global: "enabled", project: "default", effective: "enabled", runtime }],
  targets: [{ scope: "global", path: source.path, exists: true }, { scope: "project", path: "/repo/opencode.jsonc", exists: true }],
})
render(() => <ConfigProvider><I18nProvider><ThemeProvider>
  <Show when={plugins()}><div style={{ position: "fixed", top: "80px", left: "10px", width: "360px", "z-index": 100, background: "var(--surface-canvas)" }}>
    <PluginActivationControls instanceId={pluginInstance()} location={{ directory: directory() }}
      active={active()} session={sessionless() ? undefined : sessions().get(id)?.get(activeSessionId().get(id) ?? "")} />
  </div></Show>
</ThemeProvider></I18nProvider></ConfigProvider>, root)
const dispatch = (type: string, data: unknown = {}, instanceId = id) => (serverEvents as any).dispatchBatch([{ type: "instance.event", instanceId,
  event: { id: `integration-${Date.now()}`, created: Date.now(), type, data, location: { directory: directory() } } }])
;(window as any).integrationFixture = {
  plugins: setPlugins,
  directory: setDirectory,
  active: setActive,
  sessionless: setSessionless,
  instance: setPluginInstance,
  installLabel: () => tGlobal("integrations.installHost.install"),
  event: dispatch,
  burst: () => { for (let index = 0; index < 10; index++) dispatch("rpc.neuralnomads.blender.hosts_changed") },
  reconnect: () => (serverEvents as any).dispatchBatch([{ type: "instance.eventStatus", instanceId: id, status: "connected" }]),
  disconnect: () => (serverEvents as any).dispatchBatch([{ type: "instance.eventStatus", instanceId: id, status: "disconnected" }]),
  transportDisconnect: () => (serverEvents as any).emitTransportStatus("disconnected"),
  move: (sessionID: string, directory: string) => (window as any).fixture.moveSession(sessionID, directory),
  open: () => { for (const handler of (serverEvents as any).openHandlers) handler() },
  demandStopped: () => { stoppedRelease = integrations.demand("integration-stopped", "/repo") },
  stop: (workspaceId = "integration-stopped") => { (serverEvents as any).dispatchBatch([{ type: "workspace.stopped", workspaceId }]); stoppedRelease?.() },
  snapshot: () => integrations.state("integration-stopped", "/repo").status,
  toasts: getToastHistory,
  hint: (integration: string, label: string) => setSessions(previous => {
    const next = new Map(previous), values = new Map(next.get(id))
    const current = values.get("session")!
    values.set(current.id, { ...current, metadata: { "codenomad.integrationAttachment": { integration, label, attachedAt: 1 } } })
    next.set(id, values); return next
  }),
}
