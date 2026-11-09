import { createSignal, For } from "solid-js"
import { render } from "solid-js/web"
import InstanceTab from "../../../src/components/instance-tab"
import { ConfigProvider, preferences, preferencesForBackend } from "../../../src/stores/preferences"
import { I18nProvider, preloadLocaleMessages } from "../../../src/lib/i18n"
import { createBackendRegistry } from "../../../src/stores/backend-registry"
import { backendEvents } from "../../../src/lib/backend-events"
import { backends, localBackend, createRemoteBackendClient } from "../../../src/lib/backend-client"
import type { Instance } from "../../../src/types/instance"
import { refreshWorkspaceList, createInstance, closeWorkspace, releaseRestoreCreatedInstance, instances } from "../../../src/stores/instances"
import { attachInstanceTab, closeInstanceTab } from "../../../src/stores/app-tabs"
import { openInstanceTabIds } from "../../../src/stores/app-tab-membership"

const [enabled, setEnabled] = createSignal<unknown>(false)
const profiles = ["a", "b"].map(id => ({ id, name: id, baseUrl: `http://${id}.test`, skipTlsVerify: false,
  createdAt: "", updatedAt: "" }))
const events = backendEvents, opens: string[] = []
const settled: string[] = []
const created: string[] = []
events.on("workspace.created", event => { if (event.type === "workspace.created") created.push(event.workspace.id) })
const [frames, setFrames] = createSignal<string[]>([])
events.on("workspace.removed", event => {
  if (event.type === "workspace.removed") setFrames(previous => [...previous, event.workspaceId])
})
events.onOpen(id => {
  if (id !== "local") opens.push(id)
})
const registry = createBackendRegistry({ enabled, profiles: () => profiles, events,
  createClient: id => {
    const client = createRemoteBackendClient(id, { bindRelayAuthority: true })
    const read = client.api.fetchWorkspaces
    client.api.fetchWorkspaces = async signal => {
      const result = await read(signal)
      settled.push(id)
      return result
    }
    return client
  },
  loadWorkspaces: (client, signal) => refreshWorkspaceList(client.id, client.api, signal),
})
const instance = { id: "local-project", folder: "/local", status: "starting", client: null, port: 0, pid: 0 } as Instance
await preferencesForBackend("local").ensureLoaded()
await preloadLocaleMessages(preferences().locale)
render(() => <ConfigProvider><I18nProvider>
  <InstanceTab instance={instance} active={true} onSelect={() => {}} onClose={() => {}} onRename={() => {}} />
  <output data-state-a>{registry.state("a")}</output><output data-state-b>{registry.state("b")}</output>
  <output data-frames>{frames().join(",")}</output>
  <For each={[...instances().values()].filter(instance => instance.backendId && openInstanceTabIds().has(instance.id))}>{remote =>
    <InstanceTab instance={remote} active={false} onSelect={() => {}} onClose={() => closeInstanceTab(remote.id)} onRename={() => {}} />
  }</For>
</I18nProvider></ConfigProvider>, document.getElementById("root")!)
;(window as any).registryFixture = {
  setEnabled, ensure: (id: string) => registry.ensure(id).then(Boolean), dispose: registry.dispose,
  restart: (id: string) => backends.get(id)?.events.restart(),
  snapshot: () => ({ opens: [...opens], settled: [...settled], created: [...created], ids: [...backends.keys()], frames: frames() }),
  localRead: () => localBackend.api.fetchServerMeta(),
  open: (id: string) => {
    preferences().multiBackend = true
    const original = crypto.randomUUID
    Object.defineProperty(crypto, "randomUUID", { configurable: true, value: () => "11111111-1111-4111-8111-111111111111" })
    try { return createInstance("/same", undefined, { backend: backends.get(id)!, signal: new AbortController().signal,
      onCreateCommit: instanceId => attachInstanceTab(instanceId, { source: "restore" }),
    }) }
    finally { Object.defineProperty(crypto, "randomUUID", { configurable: true, value: original }) }
  },
  close: closeWorkspace,
  closeTab: closeInstanceTab,
  tabs: () => [...openInstanceTabIds()],
  release: releaseRestoreCreatedInstance,
  workspaces: () => [...instances().keys()],
}
