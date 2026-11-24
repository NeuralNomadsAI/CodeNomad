import { For, Show, createEffect, createSignal } from "solid-js"
import { render } from "solid-js/web"
import FolderSelectionView from "../../../src/components/folder-selection-view"
import NewInstanceLauncher from "../../../src/components/new-instance-launcher"
import InstanceTab from "../../../src/components/instance-tab"
import { SettingsScreen } from "../../../src/components/settings-screen"
import { ConfigProvider, preferencesForBackend, updatePreferences } from "../../../src/stores/preferences"
import { I18nProvider, preloadLocaleMessages } from "../../../src/lib/i18n"
import { instances, refreshWorkspaceList } from "../../../src/stores/instances"
import { appTabs, activeAppTabId, closeBlankTab, ensureActiveAppTab, openBlankTab, replaceBlankTab, selectInstanceTab } from "../../../src/stores/app-tabs"
import { releaseAppSessionRestoreGate } from "../../../src/stores/app-session-restore-gate"
import { selectRemoteServer } from "../../../src/stores/remote-project-open"
import { backendRegistry } from "../../../src/stores/remote-backends"
import { setActiveSettingsSection } from "../../../src/stores/settings-screen"
import { addRemoteRestoreTab, remoteRestoreTabs, removeRemoteRestoreTab } from "../../../src/stores/remote-restore-tabs"
import { getServerMeta } from "../../../src/lib/server-meta"
import "../../../src/index.css"

await preferencesForBackend("local").ensureLoaded()
await preloadLocaleMessages("en")
await refreshWorkspaceList()
void getServerMeta().catch(() => {})
const startsWithoutTabs = !instances().has("w")
if (startsWithoutTabs) { releaseAppSessionRestoreGate(); openBlankTab() }
else selectInstanceTab("w")
const [launcherOpen, setLauncherOpen] = createSignal(false)
let launcherAnchor!: HTMLButtonElement
const native = new URL(location.href).searchParams.has("preferences")
setActiveSettingsSection("servers")
window.__CODENOMAD_SELECT_SERVER__ = selectRemoteServer
render(() => {
  createEffect(() => {
    appTabs()
    ensureActiveAppTab()
  })
  return <ConfigProvider><I18nProvider>
  <Show when={native} fallback={<>
    <div role="tablist" data-project-tabs><For each={appTabs()}>{tab => <Show when={tab.kind === "instance" && tab.instance}>
      {instance => <InstanceTab instance={instance()} active={activeAppTabId() === tab.id} onSelect={() => selectInstanceTab(instance().id)}
        onClose={() => {}} onRename={() => {}} />}
    </Show>}</For></div>
    <button type="button" ref={launcherAnchor} onClick={() => setLauncherOpen(true)}>Fixture launcher</button>
    <NewInstanceLauncher open={launcherOpen()} anchor={launcherAnchor} isLoading={false} onOpenChange={setLauncherOpen}
      onSelectFolder={() => { throw new Error("Unexpected local opening") }}
      onSelectExistingInstance={id => selectInstanceTab(id)} onNewTemporary={() => {}} />
    <For each={appTabs()}>{tab => tab.kind === "blank" &&
      <div data-fixture-blank hidden={tab.id !== activeAppTabId()} style="height:100dvh">
        <button onClick={() => closeBlankTab(tab.id)}>Close new tab</button>
        <FolderSelectionView initialServer={tab.server} active={tab.id === activeAppTabId()}
          onSelectFolder={() => { throw new Error("Unexpected local opening") }} onSelectExistingInstance={() => {}}
          onJoined={() => closeBlankTab(tab.id)}
          onRemoteOpened={id => replaceBlankTab(tab.id, `instance:${id}`)} />
      </div>
    }</For>
  </>}><SettingsScreen standalone /></Show>
</I18nProvider></ConfigProvider>
}, document.getElementById("root")!)
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
  openBlankTab: () => openBlankTab(),
  select: (id: string) => {
    const p = preferencesForBackend("local").remoteServers().find(p => p.id === id)!
    selectRemoteServer({ id: p.id, baseUrl: p.baseUrl, skipTlsVerify: p.skipTlsVerify })
  },
  disable: () => updatePreferences({ multiBackend: false }),
  enable: () => updatePreferences({ multiBackend: true }),
}
