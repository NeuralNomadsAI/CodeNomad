// The real InstanceShell (header-windows) with its RightPanel: integrations are reached only from its Status tab.
import "./header-windows"
import { serverApi } from "../../../src/lib/api-client"
import { serverEvents } from "../../../src/lib/server-events"
import { tGlobal } from "../../../src/lib/i18n"
import { integrationBindings, integrations } from "../../../src/stores/integrations"
import { getToastHistory } from "../../../src/lib/notifications"
import { activeSessionId, setSessions } from "../../../src/stores/session-state"
import { getActiveCatalogLocation } from "../../../src/stores/sessions"
import { sdkManager } from "../../../src/lib/sdk-manager"

const id = "header-windows"
// Reconnect exercises the native session hydration path; its wire model uses providerID/id.
const client = (sdkManager as any).clients.get(`${id}:/workspaces/${id}/instance`)
const nativeSession = (value: any) => ({ ...value, model: { providerID: value.model.providerId, id: value.model.modelId } })
const listSessions = client.session.list
const getSession = client.session.get
client.session.list = async (...args: any[]) => {
  const response = await listSessions(...args)
  return { ...response, data: response.data.map(nativeSession) }
}
client.session.get = async (...args: any[]) => nativeSession(await getSession(...args))
client.session.inbox.list = async () => []
let stoppedRelease: (() => void) | undefined
// The plugin-controls snapshot of every Location: the Blender package declared in Global at entry 4.
const source = { scope: "global" as const, entryIndex: 4, target: "@fixture/blender", path: "/config/opencode.jsonc", pluginId: "neuralnomads.blender", hasOptions: false }
const runtime = { key: "blender", id: "neuralnomads.blender", source: { type: "package" as const, target: source.target, version: "1.0.0" }, state: { status: "active" as const }, features: {} }
let pluginReads = 0
serverApi.getPluginControls = async (_instance: string, location: { directory: string }) => {
  pluginReads++
  return { location: { directory: location.directory }, runtime: [runtime],
    configured: { sources: [source], rules: [] },
    controls: [{ id: runtime.id, builtin: false, global: "enabled", project: "default", effective: "enabled", runtime }],
    targets: [{ scope: "global", path: source.path, exists: true, expectedRevision: "a".repeat(64) },
      { scope: "project", path: `${location.directory}/opencode.jsonc`, exists: true, expectedRevision: "b".repeat(64) }],
  } as any
}
const location = () => ({ directory: getActiveCatalogLocation(id).directory })
const dispatch = (type: string, data: unknown = {}, instanceId = id) => (serverEvents as any).dispatchBatch([{ type: "instance.event", instanceId,
  event: { id: `integration-${Date.now()}-${Math.random()}`, created: Date.now(), type, data, location: location() } }])
;(window as any).integrationFixture = {
  refresh: () => integrations.refreshDemanded(id),
  installLabel: () => tGlobal("integrations.installHost.install"),
  event: dispatch,
  burst: () => { for (let index = 0; index < 10; index++) dispatch("rpc.neuralnomads.blender.hosts_changed") },
  reconnect: () => (serverEvents as any).dispatchBatch([{ type: "instance.eventStatus", instanceId: id, status: "connected" }]),
  disconnect: () => (serverEvents as any).dispatchBatch([{ type: "instance.eventStatus", instanceId: id, status: "disconnected" }]),
  transportDisconnect: () => (serverEvents as any).emitTransportStatus("disconnected"),
  transportConnect: () => (serverEvents as any).emitTransportStatus("connected"),
  move: (sessionID: string, directory: string) => (window as any).fixture.moveSession(sessionID, directory),
  open: () => { for (const handler of (serverEvents as any).openHandlers) handler() },
  demandStopped: () => { stoppedRelease = integrations.demand("integration-stopped", "/repo") },
  stop: (workspaceId = "integration-stopped") => { (serverEvents as any).dispatchBatch([{ type: "workspace.stopped", workspaceId }]); if (workspaceId === "integration-stopped") stoppedRelease?.() },
  snapshot: () => integrations.state("integration-stopped", "/repo").status,
  toasts: getToastHistory,
  pluginReads: () => pluginReads,
  /** The binding store's current answer for one conversation of this instance. */
  binding: (sessionID = "session", directory = "/repo") => integrationBindings.state({ instanceId: id, directory, sessionID, integrationId: "blender" }),
  bindingBusy: (sessionID = "session", directory = "/repo") => integrationBindings.busy({ instanceId: id, directory, sessionID, integrationId: "blender" }),
  /** A saved Q8 reattach hint on the displayed (or named) conversation. */
  hint: (integration: string, label: string, sessionID?: string) => setSessions(previous => {
    const next = new Map(previous), values = new Map(next.get(id))
    const target = sessionID ?? activeSessionId().get(id) ?? "session"
    const current = values.get(target)!
    values.set(current.id, { ...current, metadata: { "codenomad.integrationAttachment": { integration, label, attachedAt: 1 } } })
    next.set(id, values); return next
  }),
}
