import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import type { PluginControlsSnapshot } from "../../../../server/src/api-types"
import { PluginActivationControls } from "../../../src/components/plugin-activation-controls"
import { ConfigProvider, updatePreferences } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { serverApi } from "../../../src/lib/api-client"
import { serverEvents } from "../../../src/lib/server-events"
import "../../../src/index.css"

const instanceId = "plugin-controls-fixture"
const location = { directory: "/repo" }
const calls: Array<Record<string, unknown>> = []
let reads = 0
const [viewActive, setViewActive] = createSignal(false)
const [workspaceID, setWorkspaceID] = createSignal("session-one")

const active = {
  key: "acme.reviewer",
  id: "acme.reviewer",
  source: { type: "package" as const, target: "@acme/reviewer", version: "1.2.0" },
  features: { server: true as const },
  state: { status: "active" as const },
}
const failed = {
  key: "broken.plugin",
  id: "broken.plugin",
  source: { type: "local" as const, path: "/repo/.opencode/plugins/broken" },
  features: { rpc: true as const },
  state: { status: "failed" as const, error: "Setup failed safely", ref: "err_fixture" },
}
const builtin = {
  key: "opencode.provider.demo",
  id: "opencode.provider.demo",
  source: { type: "builtin" as const },
  features: { server: true as const },
  state: { status: "active" as const },
}

let snapshot: PluginControlsSnapshot = {
  location,
  runtime: [active, failed, builtin],
  configured: {
    sources: [{ target: "@acme/reviewer", scope: "global", path: "/daemon/opencode.jsonc", entryIndex: 0, hasOptions: true }],
    rules: [
      { selector: "*", enabled: true, scope: "global", path: "/daemon/opencode.jsonc", order: 0, entryIndex: 1 },
      { selector: "sleeping.plugin", enabled: false, scope: "project", path: "/repo/.opencode/opencode.jsonc", order: 1, entryIndex: 0 },
    ],
  },
  controls: [
    { id: active.id, runtime: active, effective: "enabled", global: "enabled", project: "default" },
    { id: failed.id, runtime: failed, effective: "enabled", global: "enabled", project: "default" },
    { id: builtin.id, runtime: builtin, effective: "enabled", global: "enabled", project: "default" },
    {
      id: "sleeping.plugin",
      effective: "disabled",
      global: "enabled",
      project: "disabled",
      controllingRule: { selector: "sleeping.plugin", enabled: false, scope: "project", path: "/repo/.opencode/opencode.jsonc", order: 1, entryIndex: 0 },
    },
  ],
  targets: [
    { scope: "global", path: "/daemon/opencode.jsonc", exists: true },
    { scope: "project", path: "/repo/.opencode/opencode.jsonc", exists: true },
  ],
}

const uiConfig = { settings: { locale: "en" } }
serverApi.fetchConfigOwner = async () => uiConfig as any
serverApi.patchConfigOwner = async (_owner, patch) => Object.assign(uiConfig, patch) as any
serverApi.fetchStateOwner = async () => ({} as any)
serverApi.getPluginControls = async (_id, requestedLocation) => {
  reads++
  calls.push({ type: "read", location: requestedLocation.directory })
  return structuredClone(snapshot)
}
serverApi.setPluginActivation = async (_id, request) => {
  calls.push({ type: "mutation", ...request })
  const state = request.enabled ? "enabled" : "disabled"
  const rule = request.enabled ? request.pluginId : `-${request.pluginId}`
  const control = snapshot.controls.find((entry) => entry.id === request.pluginId)!
  control[request.scope] = state
  control.effective = request.scope === "project" || control.project === "default" ? state : control.effective
  const configuredRule = {
    selector: request.pluginId,
    enabled: request.enabled,
    scope: request.scope,
    path: snapshot.targets.find((target) => target.scope === request.scope)!.path,
    order: snapshot.configured.rules.length + 1,
    entryIndex: snapshot.configured.rules.length,
  }
  control.controllingRule = configuredRule
  snapshot.configured.rules.push(configuredRule)
  return {
    snapshot: structuredClone(snapshot),
    rule,
    target: snapshot.targets.find((target) => target.scope === request.scope)!,
    changed: true,
    reloadPending: true,
  }
}

render(() => (
  <ConfigProvider>
    <I18nProvider>
      <ThemeProvider>
        <main style={{ width: "430px", margin: "24px", padding: "12px", "background-color": "var(--surface-secondary)" }}>
          <PluginActivationControls
            instanceId={instanceId}
            location={{ ...location, workspaceID: workspaceID() }}
            active={viewActive()}
          />
        </main>
      </ThemeProvider>
    </I18nProvider>
  </ConfigProvider>
), document.getElementById("root")!)
await updatePreferences({ locale: "en" })

;(window as any).fixture = {
  calls,
  reads: () => reads,
  isActive: viewActive,
  show: () => setViewActive(true),
  hide: () => setViewActive(false),
  switchSession: () => setWorkspaceID((current) => current === "session-one" ? "session-two" : "session-one"),
  activateSleepingPlugin: () => {
    const runtime = {
      key: "sleeping.plugin",
      id: "sleeping.plugin",
      source: { type: "package" as const, target: "sleeping-package", version: "2.0.0" },
      features: { server: true as const },
      state: { status: "active" as const },
    }
    snapshot.runtime.push(runtime)
    snapshot.controls.find((entry) => entry.id === runtime.id)!.runtime = runtime
    ;(serverEvents as any).dispatchBatch([{
      type: "instance.event",
      instanceId,
      event: { id: "event-plugin", created: Date.now(), type: "plugin.updated", data: {}, location },
    }])
  },
  eventBurst: async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let burstReads = 0
    serverApi.getPluginControls = async () => {
      burstReads++
      if (burstReads === 1) await gate
      return structuredClone(snapshot)
    }
    const events = Array.from({ length: 30 }, (_, index) => ({
      type: "instance.event",
      instanceId,
      event: { id: `event-${index}`, created: Date.now(), type: index % 2 ? "plugin.updated" : "config.updated", data: {}, location },
    }))
    ;(serverEvents as any).dispatchBatch(events.slice(0, 1))
    const firstReadDeadline = Date.now() + 2_000
    while (burstReads < 1) {
      if (Date.now() > firstReadDeadline) throw new Error("The first event did not start a refresh")
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    ;(serverEvents as any).dispatchBatch(events.slice(1))
    release()
    const deadline = Date.now() + 2_000
    while (burstReads < 2) {
      if (Date.now() > deadline) throw new Error(`Trailing refresh did not run; observed ${burstReads} read(s)`)
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    return burstReads
  },
}
