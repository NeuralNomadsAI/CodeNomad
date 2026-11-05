import { Show, createSignal } from "solid-js"
import { render } from "solid-js/web"
import type { PluginConfigScope, PluginControlsSnapshot } from "../../../../server/src/api-types"
import { PluginActivationControls } from "../../../src/components/plugin-activation-controls"
import { ConfigProvider, updatePreferences } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { serverApi } from "../../../src/lib/api-client"
import { serverEvents } from "../../../src/lib/server-events"
import { sdkManager } from "../../../src/lib/sdk-manager"
import { getToastHistory } from "../../../src/lib/notifications"
import "../../../src/index.css"

const instanceId = "plugin-controls-fixture"
const location = { directory: "/repo" }
const calls: Array<Record<string, unknown>> = []
;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, { plugin: {
  check: async (input: any) => {
    calls.push({ type: "check", ...input })
    for (const entry of snapshot.runtime) {
      if (entry.source.type === "package" && entry.source.target === input.target) entry.source.outdated = true
    }
    return { data: [] }
  },
  update: async (input: any) => {
    calls.push({ type: "update", ...input })
    snapshot.runtime = snapshot.runtime.filter(entry => entry.source.type !== "package" || !input.targets.includes(entry.source.target))
    const runtime = { key: "recovered.plugin", id: "recovered.plugin", source: { type: "package" as const, target: input.targets[0], version: "2.0.0" }, features: {}, state: { status: "active" as const } }
    snapshot.runtime.push(runtime)
    snapshot.controls.push({ id: runtime.id, runtime, builtin: false, effective: "default", global: "default", project: "default" })
  },
} })
let reads = 0
let mutationGate: Promise<void> | undefined
let releaseMutation: (() => void) | undefined
let failMutation = false
let readGate: Promise<void> | undefined
let releaseRead: (() => void) | undefined
const [viewActive, setViewActive] = createSignal(false)
const [mounted, setMounted] = createSignal(true)
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
      { selector: "opencode.prompt.identity", enabled: false, scope: "global", path: "/daemon/opencode.jsonc", order: 0, entryIndex: 2 },
      { selector: "sleeping.plugin", enabled: false, scope: "project", path: "/repo/.opencode/opencode.jsonc", order: 1, entryIndex: 0 },
    ],
  },
  controls: [
    { id: active.id, runtime: active, builtin: false, effective: "enabled", global: "enabled", project: "default" },
    { id: failed.id, runtime: failed, builtin: false, effective: "default", global: "default", project: "default" },
    { id: builtin.id, runtime: builtin, builtin: true, effective: "enabled", global: "enabled", project: "default" },
    { id: "opencode.prompt.identity", builtin: true, effective: "disabled", global: "disabled", project: "default" },
    {
      id: "sleeping.plugin",
      builtin: false,
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

let uiConfig = { settings: { locale: "en" } }
serverApi.fetchConfigOwner = async () => structuredClone(uiConfig) as any
serverApi.patchConfigOwner = async (_owner, patch: any) => {
  uiConfig = { ...uiConfig, ...patch, settings: { ...uiConfig.settings, ...patch.settings } }
  return structuredClone(uiConfig) as any
}
serverApi.fetchStateOwner = async () => ({} as any)
serverApi.getPluginControls = async (_id, requestedLocation) => {
  reads++
  calls.push({ type: "read", location: requestedLocation.directory })
  await readGate
  return structuredClone(snapshot)
}
serverApi.setPluginActivation = async (_id, request) => {
  calls.push({ type: "mutation", ...request })
  await mutationGate
  if (failMutation) {
    failMutation = false
    throw new Error("Isolated mutation failure")
  }
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
          <Show when={mounted()}><PluginActivationControls
            instanceId={instanceId}
            location={{ ...location, workspaceID: workspaceID() }}
            active={viewActive()}
          /></Show>
        </main>
      </ThemeProvider>
    </I18nProvider>
  </ConfigProvider>
), document.getElementById("root")!)
await updatePreferences({ locale: "en" })

;(window as any).fixture = {
  calls,
  reads: () => reads,
  clearSystemConfiguration: () => { snapshot.configured.sources = []; snapshot.configured.rules = [] },
  systemPlugins: (mode: "active" | "disabled" | "disabled-active" | "disabled-failed" | "failed" | "failed-no-id" | "unconfirmed" | "source-only", scope: PluginConfigScope = "project", ordinary = true) => {
    snapshot.controls = ordinary ? [snapshot.controls[0]] : []
    snapshot.runtime = ordinary ? [active] : []
    snapshot.configured.sources = []
    snapshot.configured.rules = []
    // An ordinary local plugin can share the bundled plugin's filename.
    if (ordinary) {
      const runtime = { ...active, key: "codenomad.third-party", id: "codenomad.third-party", source: { type: "local" as const, path: "/user/codenomad-design/index.js" } }
      snapshot.runtime.push(runtime)
      snapshot.controls.push({ id: runtime.id, runtime, builtin: false, global: "default", project: "default", effective: "default" })
    }
    const runtime = {
      key: "system-design", id: mode === "failed-no-id" ? undefined : "codenomad.design",
      managedBy: "codenomad" as const,
      source: { type: "package" as const, target: "@codenomad/design@1.0.0" }, features: {},
      state: mode === "failed" || mode === "failed-no-id" || mode === "disabled-failed"
        ? { status: "failed" as const, error: "Native system plugin failed safely", ref: "err_system_native" }
        : { status: "active" as const },
    }
    if (["active", "disabled-active", "disabled-failed", "failed", "failed-no-id"].includes(mode)) snapshot.runtime.push(runtime)
    if (mode !== "failed-no-id" && mode !== "source-only") {
      const rule = { selector: "*", enabled: false, scope,
        ...(scope === "virtual" ? {} : { path: scope === "global" ? "/daemon/opencode.jsonc" : scope === "project" ? "/repo/.opencode/opencode.jsonc" : "/ancestor/opencode.jsonc" }),
        order: 0, entryIndex: 0 }
      snapshot.controls.push({ id: "codenomad.design", managedBy: "codenomad", builtin: false,
        runtime: ["active", "disabled-active", "disabled-failed", "failed"].includes(mode) ? runtime : undefined,
        effective: mode.startsWith("disabled") ? "disabled" : "default", global: "default", project: "default",
        controllingRule: mode.startsWith("disabled") ? rule : undefined })
      if (mode.startsWith("disabled")) snapshot.configured.rules.push(rule)
    }
    snapshot.configured.sources.push({ target: runtime.source.target, pluginId: runtime.id, managedBy: "codenomad", scope: "global", path: "/daemon/opencode.jsonc", entryIndex: 0, hasOptions: false })
    if (mode === "source-only") snapshot.configured.sources[0].pluginId = undefined
    if (mode === "active") {
      // Runtime without a control, and a correlated declaration without an ID,
      // exercise the two other ordinary row paths independently.
      const packageOnly = { ...runtime, key: "system-extra", id: undefined, source: { type: "package" as const, target: "@codenomad/extra" } }
      snapshot.runtime.push(packageOnly)
      snapshot.configured.sources.push({ target: packageOnly.source.target, managedBy: "codenomad", scope: "global", entryIndex: 1, hasOptions: false })
    }
  },
  activateSystemPlugin: () => {
    const runtime = { key: "system-design", id: "codenomad.design", managedBy: "codenomad" as const,
      source: { type: "package" as const, target: "@codenomad/design@1.0.0" }, features: {}, state: { status: "active" as const } }
    snapshot.runtime = snapshot.runtime.filter(entry => entry.managedBy !== "codenomad")
    snapshot.runtime.push(runtime)
    const control = snapshot.controls.find(entry => entry.id === runtime.id)
    if (control) { control.runtime = runtime; control.effective = "enabled" }
    ;(serverEvents as any).dispatchBatch([{ type: "instance.event", instanceId,
      event: { id: `system-active-${Date.now()}`, created: Date.now(), type: "plugin.updated", data: {}, location } }])
  },
  systemLocalFailure: (attached: boolean) => {
    const runtime = { key: "native-local-failure", managedBy: "codenomad" as const,
      source: { type: "local" as const, path: "/daemon/plugins/codenomad-design.js" }, features: {},
      state: { status: "failed" as const, error: "Native system plugin failed safely", ref: "err_system_native" } }
    snapshot.runtime = [runtime]
    snapshot.controls = attached ? [{ id: "codenomad.design", managedBy: "codenomad", runtime, builtin: false,
      global: "default", project: "default", effective: "default" }] : []
    snapshot.configured.sources = [{ target: runtime.source.path, managedBy: "codenomad", pluginId: attached ? "codenomad.design" : undefined,
      scope: "global", path: "/daemon/opencode.jsonc", entryIndex: 0, hasOptions: false }]
    snapshot.configured.rules = []
  },
  ordinaryLocalFailure: () => {
    snapshot.controls = []
    snapshot.runtime = ["/thirdparty/plugin.ts", "/daemon/plugins/codenomad-design.js"].map(path => ({ key: path,
      source: { type: "local", path }, features: {},
      state: { status: "failed", error: "Unproven local plugin load failed", ref: "err_local_native" } }))
    snapshot.configured.sources = snapshot.runtime.map((entry, entryIndex) => ({ target: entry.key, scope: "global", entryIndex, hasOptions: false }))
    snapshot.configured.rules = []
  },
  failedPackagesOnly: () => {
    snapshot.controls = []
    snapshot.configured.sources = []
    snapshot.runtime = ["opencode-ponytail", "opencode-gemini-auth@latest", "opencode-ponytail"].map((target, index) => ({
      key: `failed-${index}`, source: { type: "package", target }, features: {},
      state: { status: "failed", error: "Package failed before exporting a plugin ID" },
    }))
  },
  isActive: viewActive,
  show: () => setViewActive(true),
  hide: () => setViewActive(false),
  unmount: () => setMounted(false),
  remount: () => setMounted(true),
  toastHistory: () => getToastHistory(),
  holdRead: () => { readGate = new Promise<void>((resolve) => { releaseRead = resolve }) },
  releaseRead: () => { releaseRead?.(); readGate = undefined },
  invalidate: () => (serverEvents as any).dispatchBatch([{
    type: "instance.event",
    instanceId,
    event: { id: `event-refresh-${Date.now()}`, created: Date.now(), type: "plugin.updated", data: {}, location },
  }]),
  holdMutation: () => { mutationGate = new Promise<void>((resolve) => { releaseMutation = resolve }) },
  releaseMutation: () => { releaseMutation?.(); mutationGate = undefined },
  failMutation: () => { failMutation = true },
  setLocale: (locale: "en" | "fr" | "he") => updatePreferences({ locale }),
  setLongDetails: () => {
    const id = "company.integration.identical-prefix.production"
    const source = "/repo/.opencode/plugins/a-long-distinct-entrypoint/index.ts"
    const error = "Setup failed: a-long-actionable-diagnostic-ending-with-recovery-instructions"
    const control = snapshot.controls.find((entry) => entry.id === active.id)!
    control.id = id
    control.runtime = { ...active, id, source: { type: "local", path: source } }
    snapshot.controls.push({ ...control, id: "company.integration.identical-prefix.staging" })
    snapshot.controls.find((entry) => entry.id === failed.id)!.runtime = { ...failed, state: { ...failed.state, error } }
    return { id, source, error }
  },
  setNarrow: () => {
    const main = document.querySelector("main") as HTMLElement | null
    if (main) {
      main.style.width = "240px"
      main.style.margin = "8px"
      main.style.padding = "8px"
    }
  },
  setTargets: (scopes: Array<"global" | "project">) => {
    snapshot.targets = snapshot.targets.filter((target) => scopes.includes(target.scope))
  },
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
