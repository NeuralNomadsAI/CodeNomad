import { render } from "solid-js/web"
import { createSignal } from "solid-js"
import AlertDialog from "../../../src/components/alert-dialog"
import type { PluginControlsSnapshot, PluginRuntimeInventoryEntry } from "../../../../server/src/api-types"
import { PluginActivationControls } from "../../../src/components/plugin-activation-controls"
import { ConfigProvider, updatePreferences } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { serverApi } from "../../../src/lib/api-client"
import { serverEvents } from "../../../src/lib/server-events"
import { HttpResponseError } from "../../../src/lib/retryable-file-search"
import { getToastHistory } from "../../../src/lib/notifications"
import "../../../src/index.css"

const instanceId = "plugin-sources-fixture"
const location = { directory: "/repo" }
const calls: Array<Record<string, unknown>> = []
const globalPath = "/daemon/opencode.jsonc", projectPath = "/repo/.opencode/opencode.jsonc"
let nextError: { status: number; code?: string } | undefined
let loseRemovalResponse = false
const [active, setActive] = createSignal(true)

const snapshot: PluginControlsSnapshot = {
  location, runtime: [], controls: [],
  configured: { rules: [{ selector: "-kept.rule", enabled: false, scope: "global", path: globalPath, order: 0, entryIndex: 0 }], sources: [] },
  targets: [{ scope: "global", path: globalPath, exists: true, expectedRevision: "a".repeat(64) }, { scope: "project", path: projectPath, exists: true, expectedRevision: "b".repeat(64) }],
}

let uiConfig = { settings: { locale: "en" } }
serverApi.fetchConfigOwner = async () => structuredClone(uiConfig) as any
serverApi.patchConfigOwner = async (_owner, patch: any) => {
  uiConfig = { ...uiConfig, ...patch, settings: { ...uiConfig.settings, ...patch.settings } }
  return structuredClone(uiConfig) as any
}
serverApi.fetchStateOwner = async () => ({} as any)
serverApi.getPluginControls = async () => { calls.push({ type: "read" }); return structuredClone(snapshot) }
serverApi.addPluginSource = async (_id, request) => {
  calls.push({ type: "add", ...request })
  if (!snapshot.targets.some(target => target.scope === request.scope)) {
    throw new HttpResponseError("OpenCode configuration scope is unavailable", 503, null, undefined, { error: "unavailable" })
  }
  if (nextError) {
    const error = nextError
    nextError = undefined
    throw new HttpResponseError("refused", error.status, null, error.code, { error: "refused", code: error.code })
  }
  // The daemon reports the declaration on the following read, but has not loaded it yet.
  const path = request.scope === "global" ? globalPath : projectPath
  const entryIndex = snapshot.configured.sources.filter(source => source.path === path).length + 1
  snapshot.configured.sources.push({ target: request.spec, scope: request.scope, path, entryIndex, hasOptions: false })
  return { scope: request.scope, spec: request.spec, reloadPending: true }
}
serverApi.removePluginSource = async (_id, request) => {
  calls.push({ type: "remove", ...request })
  snapshot.configured.sources = snapshot.configured.sources.filter(source => !(source.scope === request.scope && source.target === request.target && source.entryIndex === request.entryIndex))
  if (loseRemovalResponse) { loseRemovalResponse = false; throw new Error("Response lost after commit") }
  return { scope: request.scope, spec: request.target, reloadPending: true }
}

render(() => (
  <ConfigProvider><I18nProvider><ThemeProvider>
    <main style={{ width: "430px", margin: "24px", padding: "12px", "background-color": "var(--surface-secondary)" }}>
      <PluginActivationControls instanceId={instanceId} location={location} active={active()} />
      <AlertDialog />
    </main>
  </ThemeProvider></I18nProvider></ConfigProvider>
), document.getElementById("root")!)
await updatePreferences({ locale: "en" })

const notify = () => (serverEvents as any).dispatchBatch([{
  type: "instance.event", instanceId,
  event: { id: `event-${Math.random()}`, created: Date.now(), type: "plugin.updated", data: {}, location },
}])

;(window as any).fixture = {
  calls,
  toasts: getToastHistory,
  setActive,
  loseRemovalResponse: () => { loseRemovalResponse = true },
  changeRevision: () => { snapshot.targets[0]!.expectedRevision = "c".repeat(64); notify() },
  disconnect: () => (serverEvents as any).dispatchBatch([{ type: "instance.eventStatus", instanceId, status: "disconnected" }]),
  unload: (target: string) => {
    snapshot.runtime = snapshot.runtime.filter(entry => entry.source.type !== "package" || entry.source.target !== target)
    snapshot.controls = snapshot.controls.filter(control => control.runtime?.source.type !== "package" || control.runtime.source.target !== target)
    notify()
  },
  failNextAdd: (status: number, code?: string) => { nextError = { status, code } },
  dropProjectTarget: () => { snapshot.targets = snapshot.targets.filter(target => target.scope !== "project"); notify() },
  notify,
  /** OpenCode reports the target: loaded with a version (and a pending update), or failed with a ref. */
  report: (target: string, outcome: "active" | "failed", options: { id?: string; gui?: boolean } = {}) => {
    const runtime: PluginRuntimeInventoryEntry = {
      key: options.id ?? `package:${target}`, ...(options.id ? { id: options.id } : {}),
      source: { type: "package", target, version: "1.0.0", outdated: true },
      features: { server: true, ...(options.gui ? { gui: true as const } : {}) },
      state: outcome === "active" ? { status: "active" } : { status: "failed", error: "Plugin failed to load", ref: "err_fixture01" },
    }
    snapshot.runtime.push(runtime)
    if (options.id) {
      snapshot.controls.push({ id: options.id, runtime, builtin: false, effective: "default", global: "default", project: "default" })
      for (const source of snapshot.configured.sources) if (source.target === target) source.pluginId = options.id
    }
    notify()
  },
}
