import { For, Show, createSignal } from "solid-js"
import { render } from "solid-js/web"
import FolderSelectionView from "../../../src/components/folder-selection-view"
import RemoteServerProjectDialog from "../../../src/components/remote-server-browser"
import InstanceTab from "../../../src/components/instance-tab"
import { SettingsScreen } from "../../../src/components/settings-screen"
import { ConfigProvider, preferencesForBackend, updatePreferences } from "../../../src/stores/preferences"
import { I18nProvider, preloadLocaleMessages } from "../../../src/lib/i18n"
import { instances, refreshWorkspaceList } from "../../../src/stores/instances"
import { appTabs, activeAppTabId, selectInstanceTab } from "../../../src/stores/app-tabs"
import { selectRemoteServer } from "../../../src/stores/remote-project-open"
import { backendRegistry } from "../../../src/stores/remote-backends"
import { setActiveSettingsSection } from "../../../src/stores/settings-screen"
import { addRemoteRestoreTab, remoteRestoreTabs, removeRemoteRestoreTab } from "../../../src/stores/remote-restore-tabs"
import "../../../src/index.css"

await preferencesForBackend("local").ensureLoaded()
await preloadLocaleMessages("en")
await refreshWorkspaceList()
selectInstanceTab("w")
const [home, setHome] = createSignal(true)
const native = new URL(location.href).searchParams.has("preferences")
setActiveSettingsSection("servers")
window.__CODENOMAD_SELECT_SERVER__ = selectRemoteServer
render(() => <ConfigProvider><I18nProvider>
  <Show when={native} fallback={<>
    <div role="tablist"><For each={appTabs()}>{tab => <Show when={tab.kind === "instance" && tab.instance}>
      {instance => <InstanceTab instance={instance()} active={activeAppTabId() === tab.id} onSelect={() => selectInstanceTab(instance().id)}
        onClose={() => {}} onRename={() => {}} />}
    </Show>}</For></div>
    <Show when={home()}><FolderSelectionView onSelectFolder={() => { throw new Error("Unexpected local opening") }}
      onSelectExistingInstance={() => {}} onClose={() => setHome(false)} /></Show>
    <RemoteServerProjectDialog onOpened={() => setHome(false)} />
  </>}><SettingsScreen standalone /></Show>
</I18nProvider></ConfigProvider>, document.getElementById("root")!)
;(window as any).remoteOpenFixture = {
  snapshot: () => ({ tabs: appTabs().map(tab => ({ id: tab.id, kind: tab.kind })), active: activeAppTabId() }),
  records: () => [...instances().keys()],
  details: (id: string) => instances().get(id),
  waiting: () => remoteRestoreTabs().map(tab => ({ id: tab.id, snapshot: tab.snapshot })),
  addWaiting: (backendId: string) => addRemoteRestoreTab({
    id: `waiting:${backendId}`, kind: "remote-restore", retry: async () => { throw new Error("Unexpected restore retry") },
    remove: () => removeRemoteRestoreTab(`waiting:${backendId}`),
    snapshot: { kind: "workspace", backendId, folder: "/same", occurrence: 0,
      drafts: { __no_session_draft__: "preserved draft" }, attachments: {}, scrollSnapshots: {}, unseenIdleSince: {}, generationRecovery: {} },
  }),
  state: (id: string) => backendRegistry.state(id),
  home: () => setHome(true),
  select: (id: string) => {
    const p = preferencesForBackend("local").remoteServers().find(p => p.id === id)!
    selectRemoteServer({ id: p.id, baseUrl: p.baseUrl, skipTlsVerify: p.skipTlsVerify })
  },
  disable: () => updatePreferences({ multiBackend: false }),
}
