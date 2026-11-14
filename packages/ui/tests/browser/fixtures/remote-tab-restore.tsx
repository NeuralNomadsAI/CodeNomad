import { createEffect, For, Show } from "solid-js"
import { render } from "solid-js/web"
import { useAppSessionRestore } from "../../../src/lib/hooks/use-app-session-restore"
import { useRelayServerProfiles } from "../../../src/lib/hooks/use-remote-server-profiles"
import { getToastHistory, runToastAction, type ToastAction } from "../../../src/lib/notifications"
import { sseManager } from "../../../src/lib/sse-manager"
import "../../../src/stores/sessions"
import { initializeClientState, loadedRestorableSession, setRestorePreviousStateEnabled } from "../../../src/stores/client-state"
import { decodeClientSnapshotV2 } from "../../../src/stores/client-state-partitions"
import { activeAppTabId, appTabs, closeInstanceTab, ensureActiveAppTab, moveAppTab, selectAppTab } from "../../../src/stores/app-tabs"
import { appSessionRestoreGateActive } from "../../../src/stores/app-session-restore-gate"
import { backendRegistry } from "../../../src/stores/remote-backends"
import { backends } from "../../../src/lib/backend-client"
import { ConfigProvider, preferences, preferencesForBackend } from "../../../src/stores/preferences"
import { I18nProvider, preloadLocaleMessages } from "../../../src/lib/i18n"
import { getSessionDraftPromptsForInstance } from "../../../src/stores/session-state"
import { refreshWorkspaceList } from "../../../src/stores/instances"
import InstanceTabs from "../../../src/components/instance-tabs"
import RemoteRestoreView from "../../../src/components/remote-restore-view"
import AlertDialog from "../../../src/components/alert-dialog"
import "../../../src/index.css"

await preferencesForBackend("local").ensureLoaded()
await preloadLocaleMessages(preferences().locale)
await initializeClientState()
function close(id: string) {
  const tab = appTabs().find(tab => tab.id === id)
  if (tab?.kind === "remote-restore") tab.remove()
  else if (tab?.kind === "instance") closeInstanceTab(tab.instance.id)
  ensureActiveAppTab()
}
let relayProfiles: ReturnType<typeof useRelayServerProfiles>
let retainedNotice: ToastAction | undefined
function RelayProfiles() {
  relayProfiles = useRelayServerProfiles()
  return null
}
function Fixture() {
  useAppSessionRestore()
  createEffect(() => { appTabs(); appSessionRestoreGateActive(); ensureActiveAppTab() })
  return <ConfigProvider><I18nProvider>
    <RelayProfiles />
    <div data-restoring={appSessionRestoreGateActive()}>
      <InstanceTabs tabs={appTabs()} activeTabId={activeAppTabId()} onSelect={selectAppTab} onClose={close} onNew={() => {}} onMoveTab={moveAppTab} />
      <For each={appTabs()}>{tab => <Show when={activeAppTabId() === tab.id}>
        {tab.kind === "remote-restore" ? <RemoteRestoreView tab={tab} /> : <output data-ready>{tab.id}</output>}
      </Show>}</For>
    </div>
    <AlertDialog />
  </I18nProvider></ConfigProvider>
}
;(window as any).restoreFixture = {
  tabs: () => appTabs().map(tab => ({ id: tab.id, kind: tab.kind,
    folder: tab.kind === "instance" ? tab.instance.folder : tab.kind === "remote-restore" ? tab.snapshot.folder : "",
    drafts: tab.kind === "instance" ? getSessionDraftPromptsForInstance(tab.instance.id) : tab.kind === "remote-restore" ? tab.snapshot.drafts : {},
  })),
  active: activeAppTabId, close,
  disableAutoRestore: () => setRestorePreviousStateEnabled(false),
  notify: (id: string) => {
    ;(sseManager as any).handleEvent(id.slice("instance:".length), {
      id: "notice", type: "tui.toast.show", created: 1, data: { message: "Remote notice", variant: "info" },
    })
    retainedNotice = getToastHistory().find(item => item.action?.target?.instanceId === id.slice("instance:".length))?.action
    if (!retainedNotice) throw new Error("Remote notice action missing")
  },
  activateNotice: () => retainedNotice && runToastAction(retainedNotice),
  retry: async () => { await Promise.all(appTabs().filter(tab => tab.kind === "remote-restore").map(tab => tab.retry())) },
  restartBackend: async () => { const client = backends.get("a")!; await refreshWorkspaceList("a", client.api) },
  disconnect: () => backends.get("a")!.events.restart(),
  state: () => backendRegistry.state("a"),
  snapshot: loadedRestorableSession,
  saved: async () => { const value = (window as any).committedState; return value && decodeClientSnapshotV2(value.snapshot, 1, async key => value.partitions[key] ?? null) },
  removeServer: () => preferencesForBackend("local").removeRemoteServerProfile("a"),
  removeServerQueued: () => relayProfiles.removeServer(preferencesForBackend("local").remoteServers().find(profile => profile.id === "a")!),
  retargetServerQueued: () => preferencesForBackend("local").saveRemoteServerProfile({
    ...preferencesForBackend("local").remoteServers().find(profile => profile.id === "a")!, baseUrl: "https://changed.test",
  }, () => true),
}
;(window as any).disposeRestoreFixture = render(() => <Fixture />, document.getElementById("root")!)
