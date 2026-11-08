import { render } from "solid-js/web"
import { createSignal, Show } from "solid-js"
import type { BackendClient } from "../../../src/lib/backend-client"
import type { Instance } from "../../../src/types/instance"
import type { WorkspaceDescriptor } from "../../../../server/src/api-types"
import "../../../src/index.css"

const { serverApi } = await import("../../../src/lib/api-client")
const host = { environmentVariables: { SHARED: "host-secret", HOST_ONLY: "host-only", HOST_MASK: "host-mask" }, secureEnvVars: ["SHARED", "HOST_MASK"] }
const remote = { environmentVariables: { SHARED: "remote-secret", REMOTE_ONLY: "remote-only", HOST_MASK: "remote-public" }, secureEnvVars: ["SHARED"] }
serverApi.fetchConfigOwner = (async owner => owner === "server" ? host : { settings: { locale: "en" } }) as any
serverApi.fetchStateOwner = (async () => ({})) as any
let reloads = 0
const ready = { state: "ready", serviceState: "ready" }
serverApi.fetchOpenCodeUpdateStatus = (async () => ready) as any
serverApi.reloadOpenCodeConfiguration = (async () => { reloads++; return ready }) as any
let release!: () => void
const loading = new Promise<void>(resolve => { release = resolve })
const { backends, createBackendClient } = await import("../../../src/lib/backend-client")
const { backendEvents } = await import("../../../src/lib/backend-events")
const backend = createBackendClient({ id: "infoRemote", baseUrl: "https://info.invalid", fetcher: async input => {
  if (new URL(String(input)).pathname.endsWith("/config/server")) { await loading; return Response.json(remote) }
  return Response.json({})
} })
;(backends as Map<string, BackendClient>).set(backend.id, backend)
backendEvents.attach(backend.id, backend.events)
const [{ ConfigProvider, preferencesForBackend }, { I18nProvider }, { default: InstanceInfo },
  { default: AlertDialog }, store] = await Promise.all([
  import("../../../src/stores/preferences"), import("../../../src/lib/i18n"), import("../../../src/components/instance-info"),
  import("../../../src/components/alert-dialog"), import("../../../src/stores/instances"),
])
await preferencesForBackend("local").ensureLoaded()
const descriptor: WorkspaceDescriptor = { id: "same", path: "/repo", name: "repo", status: "starting", proxyPath: "/workspaces/same", createdAt: "", updatedAt: "" }
const refresh = () => store.refreshWorkspaceList(backend.id, { fetchWorkspaces: async () => [descriptor] })
await refresh()
const coldEnvironment = structuredClone(store.instances().get("infoRemote~same")!.environmentVariables)
const local: Instance = { id: "same", folder: "/repo", port: 0, pid: 0, status: "ready", client: {} as any, environmentVariables: { ...host.environmentVariables, LOCAL_SNAPSHOT: "kept" } }
// Deliberately stale instance data must never override the selected server's preferences.
const other: Instance = { ...local, id: "infoRemote~same", backendId: backend.id }
const [current, setCurrent] = createSignal(local)
const [visible, setVisible] = createSignal(true)
render(() => <ConfigProvider><I18nProvider>
  <section data-owner="local"><InstanceInfo instance={local} showReloadButton /></section>
  <section data-owner="remote"><InstanceInfo instance={other} showReloadButton /></section>
  <section data-owner="changing"><Show when={visible()}><InstanceInfo instance={current()} showReloadButton /></Show></section>
  <AlertDialog />
</I18nProvider></ConfigProvider>, document.getElementById("root")!)
;(window as any).fixture = {
  coldEnvironment,
  get reloads() { return reloads },
  selectRemote() { setCurrent(other) },
  selectLocal() { setCurrent(local) },
  hide() { setVisible(false) },
  async loadRemote() {
    release()
    await preferencesForBackend(backend.id).ensureLoaded()
    // Exercise reconciliation of an instance already carrying another owner's stale values.
    store.updateInstance(other.id, { environmentVariables: host.environmentVariables })
    await refresh()
    return store.instances().get(other.id)!.environmentVariables
  },
}
