import { render } from "solid-js/web"
import type { PluginControlsSnapshot } from "../../../../server/src/api-types"
import RightPanel from "../../../src/components/instance/shell/right-panel/RightPanel"
import AlertDialog from "../../../src/components/alert-dialog"
import { ConfigProvider, updatePreferences } from "../../../src/stores/preferences"
import { I18nProvider, useI18n } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { serverApi } from "../../../src/lib/api-client"
import { sdkManager } from "../../../src/lib/sdk-manager"
import { serverEvents } from "../../../src/lib/server-events"
import { getToastHistory } from "../../../src/lib/notifications"
import { addInstance, instances } from "../../../src/stores/instances"
import { activeSessionId, sessions, setActiveSession, setSessions } from "../../../src/stores/session-state"
import { initializeClientState, readClientLayoutValue } from "../../../src/stores/client-state"
import { RIGHT_PANEL_CUSTOMIZATION_STORAGE_KEY } from "../../../src/components/instance/shell/storage"
import type { Session } from "../../../src/types/session"
import "../../../src/index.css"

const instanceId = "integration-status", directory = "/repo"
const globalPath = "/config/opencode.jsonc", projectPath = "/repo/.opencode/opencode.jsonc"
const session = (id: string, title: string): Session => ({
  id, instanceId, parentId: null, title, agent: "build", model: { providerId: "fixture", modelId: "fixture" }, status: "idle", retry: null,
  idleSince: null, generationRecovery: null, runtimeStatusKnown: true, version: "1", projectID: "fixture", location: { directory },
  cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 },
})
const runtime = (id: string, target: string, extra: Record<string, unknown> = {}) => ({
  key: id, id: `neuralnomads.${id}`, features: { rpc: true as const }, state: { status: "active" as const },
  source: { type: "package" as const, target, version: "0.1.0", ...extra },
})
/** Blender (entry 2) and Gaffer (entry 3) declared in Global and loaded; a third-party plugin (entry 1). */
export const baseSnapshot = (): PluginControlsSnapshot => {
  const blender = runtime("blender", "@neuralnomads/opencode-blender@^0.1")
  const gaffer = runtime("gaffer", "@neuralnomads/opencode-gaffer@^0.1")
  const other = { ...runtime("other", "opencode-other"), id: "other.plugin", key: "other" }
  return {
    location: { directory },
    runtime: [other, blender, gaffer],
    configured: { rules: [], sources: [
      { target: "opencode-other", scope: "global", path: globalPath, entryIndex: 1, hasOptions: false, pluginId: "other.plugin" },
      { target: blender.source.target, scope: "global", path: globalPath, entryIndex: 2, hasOptions: false, pluginId: blender.id },
      { target: gaffer.source.target, scope: "global", path: globalPath, entryIndex: 3, hasOptions: false, pluginId: gaffer.id },
    ] },
    controls: [other, blender, gaffer].map(entry => ({ id: entry.id, runtime: entry, builtin: false, effective: "default" as const, global: "default" as const, project: "default" as const })),
    targets: [{ scope: "global", path: globalPath, exists: true, expectedRevision: "a".repeat(64) }, { scope: "project", path: projectPath, exists: true, expectedRevision: "b".repeat(64) }],
  }
}
let snapshot = baseSnapshot()
let snapshotReads = 0
const mutations: unknown[] = []
serverApi.fetchConfigOwner = async () => ({ settings: { locale: "en" } }) as any
serverApi.patchConfigOwner = async (_owner, patch: any) => ({ settings: { locale: "en", ...patch.settings } }) as any
serverApi.fetchStateOwner = async () => ({} as any)
serverApi.getPluginControls = async () => { snapshotReads++; return structuredClone(snapshot) }
serverApi.setPluginActivation = async (_id: string, request: any) => {
  mutations.push(request)
  const control = snapshot.controls.find(item => item.id === request.pluginId)!
  control[request.scope as "global" | "project"] = request.enabled ? "enabled" : "disabled"
  control.effective = control.global === "disabled" ? "disabled" : "enabled"
  return { snapshot: structuredClone(snapshot), rule: request.pluginId, target: snapshot.targets[0]!, changed: true, reloadPending: true } as any
}

const packageRequests: any[] = []
const client: any = { plugin: {
  check: async (input: any) => { packageRequests.push({ action: "check", ...input }); return { data: [] } },
  update: async (input: any) => { packageRequests.push({ action: "update", ...input }); return { data: [] } },
} }
;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
addInstance({ id: instanceId, folder: directory, port: 0, pid: 0, proxyPath: `/workspaces/${instanceId}/instance`, status: "ready", client } as any)
setSessions(previous => new Map(previous).set(instanceId, new Map([["first", session("first", "First conversation")], ["second", session("second", "Second conversation")]])))
setActiveSession(instanceId, "first")

function Fixture() {
  const { t } = useI18n()
  const active = () => sessions().get(instanceId)?.get(activeSessionId().get(instanceId) ?? "") ?? null
  return <div style={{ width: "380px", height: "900px", display: "flex", "flex-direction": "column" }}>
    <AlertDialog />
    <RightPanel isActive={() => true} t={t} instanceId={instanceId} instance={instances().get(instanceId)!}
      activeSessionId={() => active()?.id ?? null} activeSession={active} isPhoneLayout={() => false}
      rightDrawerWidth={() => 380} rightDrawerWidthInitialized={() => true}
      onCloseRightDrawer={() => {}} promptInputApi={() => null} setContentEl={() => {}} />
  </div>
}

await initializeClientState()
render(() => <ConfigProvider><I18nProvider><ThemeProvider><Fixture /></ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
await updatePreferences({ locale: new URLSearchParams(location.search).get("locale") ?? "en" })
const event = (type: string, data: unknown = {}) => (serverEvents as any).dispatchBatch([{ type: "instance.event", instanceId,
  event: { id: `event-${Math.random()}`, created: Date.now(), type, data, location: { directory } } }])

;(window as any).integrationStatus = {
  event,
  reconnect: () => (serverEvents as any).dispatchBatch([{ type: "instance.eventStatus", instanceId, status: "connected" }]),
  snapshotReads: () => snapshotReads,
  mutations: () => mutations,
  packageRequests: () => packageRequests,
  customization: () => JSON.parse(readClientLayoutValue(RIGHT_PANEL_CUSTOMIZATION_STORAGE_KEY) ?? "{}"),
  toasts: getToastHistory,
  /** Replaces the plugin inventory, then notifies like OpenCode does. */
  plugins: (next: PluginControlsSnapshot) => { snapshot = next; event("plugin.updated") },
  base: baseSnapshot,
  select: (id: string | null) => setActiveSession(instanceId, id ?? "info"),
  hint: (integration: string, label: string) => setSessions(previous => {
    const next = new Map(previous), values = new Map(next.get(instanceId))
    const current = values.get("first")!
    values.set("first", { ...current, metadata: { "codenomad.integrationAttachment": { integration, label, attachedAt: 1 } } } as any)
    next.set(instanceId, values); return next
  }),
}
