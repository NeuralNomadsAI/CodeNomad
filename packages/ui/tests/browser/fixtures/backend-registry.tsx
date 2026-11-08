import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import InstanceTab from "../../../src/components/instance-tab"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { createBackendRegistry } from "../../../src/stores/backend-registry"
import { BackendEvents } from "../../../src/lib/backend-events"
import { backends, localBackend } from "../../../src/lib/backend-client"
import type { Instance } from "../../../src/types/instance"
import { refreshWorkspaceList } from "../../../src/stores/instances"

const [enabled, setEnabled] = createSignal<unknown>(false)
const profiles = ["a", "b"].map(id => ({ id, name: id, baseUrl: `http://${id}.test`, skipTlsVerify: false,
  createdAt: "", updatedAt: "" }))
const events = new BackendEvents(), opens: string[] = []
const [frames, setFrames] = createSignal<string[]>([])
events.on("workspace.removed", event => {
  if (event.type === "workspace.removed") setFrames(previous => [...previous, event.workspaceId])
})
events.onOpen(id => {
  const client = backends.get(id)!
  void refreshWorkspaceList(id, client.api, events.signal(id)).then(() => { opens.push(id) })
})
const registry = createBackendRegistry({ enabled, profiles: () => profiles, events,
  loadWorkspaces: (client, signal) => refreshWorkspaceList(client.id, client.api, signal),
})
const instance = { id: "local-project", folder: "/local", status: "starting", client: null, port: 0, pid: 0 } as Instance
render(() => <ConfigProvider><I18nProvider>
  <InstanceTab instance={instance} active={true} onSelect={() => {}} onClose={() => {}} onRename={() => {}} />
  <output data-state-a>{registry.state("a")}</output><output data-state-b>{registry.state("b")}</output>
  <output data-frames>{frames().join(",")}</output>
</I18nProvider></ConfigProvider>, document.getElementById("root")!)
;(window as any).registryFixture = {
  setEnabled, ensure: (id: string) => registry.ensure(id).then(Boolean), dispose: registry.dispose,
  restart: (id: string) => backends.get(id)?.events.restart(),
  snapshot: () => ({ opens: [...opens], ids: [...backends.keys()], frames: frames() }),
  localRead: () => localBackend.api.fetchServerMeta(),
}
