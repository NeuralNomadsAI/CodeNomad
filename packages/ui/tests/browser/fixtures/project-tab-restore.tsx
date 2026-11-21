import { createEffect, For, Show } from "solid-js"
import { render } from "solid-js/web"
import { initializeClientState, setRestorePreviousStateEnabled } from "../../../src/stores/client-state"
import { decodeClientSnapshotV2 } from "../../../src/stores/client-state-partitions"
import { useAppSessionRestore } from "../../../src/lib/hooks/use-app-session-restore"
import { activeAppTabId, appTabs, ensureActiveAppTab, getSidecarAppTabId, selectAppTab, setAppTabOrder } from "../../../src/stores/app-tabs"
import { appSessionRestoreGateActive } from "../../../src/stores/app-session-restore-gate"
import { activeInstanceId, createInstance, instances, refreshWorkspaceList, updateInstance } from "../../../src/stores/instances"
import { closeInstanceTab, selectInstanceTab } from "../../../src/stores/app-tabs"
import { canContinueOpenCodeSetup, continueOpenCodeSetup, openOpenCodeSetup, refreshOpenCodeSetup, runOpenCodeSetup } from "../../../src/stores/opencode-setup"
import { serverEvents } from "../../../src/lib/server-events"
import { activeSessionId, getSessionDraftPromptsForInstance, setSessionDraftPrompt } from "../../../src/stores/session-state"
import { sessions, getSessionListIds, getSessionThreads, loading } from "../../../src/stores/session-state"
import SessionList from "../../../src/components/session-list"
import { reloadWorktrees } from "../../../src/stores/worktrees"
import { backgroundReads } from "../../../src/lib/background-read-queue"
import { messageStoreBus } from "../../../src/stores/message-v2/bus"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { useGitChanges } from "../../../src/components/instance/shell/right-panel/useGitChanges"
import { getTabViewState, updateTabViewState } from "../../../src/stores/tab-view-state"
import { openSessionPreview, getSessionPreview, restoreSessionPreview } from "../../../src/stores/session-previews"
import { updateMissionProjectView } from "../../../src/stores/mission-view-state"
import { moveAppTab } from "../../../src/stores/app-tabs"
import { savedSessionBrowser } from "../../../src/stores/session-browser-persistence"
import { getToastHistory } from "../../../src/lib/notifications"
import { openSidecarTab } from "../../../src/stores/sidecars"
import { remoteRestoreTabs } from "../../../src/stores/remote-restore-tabs"

;(window as any).tabViews = {
  ids: () => appTabs().filter(tab => tab.kind === "instance").map(tab => tab.instance.id),
  view: getTabViewState, preview: getSessionPreview, open: openSessionPreview, restore: restoreSessionPreview,
  files: (id: string) => updateTabViewState(id, { rightPanelTab: "files", filesMode: "history" }),
  mission: (id: string) => updateMissionProjectView(id, { selected: "mission-b", reader: { kind: "playbook", missionId: "debug" } }),
  reorder: (a: string, b: string) => moveAppTab(`instance:${a}`, `instance:${b}`, "before"),
  close: closeInstanceTab,
  openDuplicateSidecars: async () => {
    const first = await openSidecarTab("demo", { activate: false })
    const second = await openSidecarTab("demo", { activate: false })
    const ids = [first, second].map(tab => getSidecarAppTabId(tab.token))
    setAppTabOrder([...appTabs().filter(tab => tab.kind === "instance").map(tab => tab.id), ...ids])
    selectAppTab(ids[1])
    return ids
  },
  active: activeAppTabId,
  disableRestore: () => setRestorePreviousStateEnabled(false),
  draft: (id: string) => getSessionDraftPromptsForInstance(id).same,
  writeDraft: (id: string, text: string) => setSessionDraftPrompt(id, "same", text),
  temporary: (id: string) => instances().get(id)?.temporary,
  refresh: () => refreshWorkspaceList(),
  retry: () => remoteRestoreTabs()[0].retry(),
  remove: (id: string) => (serverEvents as any).dispatch({
    type: "workspace.stopped", workspaceId: id, reason: "deleted", temporaryRetained: true,
  }),
  noticeCount: () => getToastHistory().length,
  saved: savedSessionBrowser,
}

function GitPanel(props: { instanceId: string }) {
  const git = useGitChanges({ instanceId: props.instanceId, t: key => key,
    isActive: () => activeInstanceId() === props.instanceId, rightPanelTab: () => "git-changes",
    worktreeSlug: () => "root", isPhoneLayout: () => false, promptInputApi: () => null, closeGitList() {},
  })
  return <span data-git-loading={git.gitStatusLoading()} />
}

const SessionView = location.search.includes("foreground")
  ? (await import("../../../src/components/session/session-view")).default : undefined
if (SessionView || location.search.includes("catalog")) await import("../../../src/index.css")
;(window as any).messageCount = () => messageStoreBus.getOrCreate(activeInstanceId()!).getSessionMessageIds("saved-session").length
;(window as any).sessionListIds = getSessionListIds
// Ordinary workspace updates (status, metadata) replace the instance object.
;(window as any).touchWorkspaces = () => { for (const id of instances().keys()) updateInstance(id, { error: undefined }) }
;(window as any).catalogRows = (id: string) => [...(sessions().get(id)?.values() ?? [])]
;(window as any).decodeSavedState = () => {
  const commit = (window as any).committedState
  return commit && decodeClientSnapshotV2(commit.snapshot, 1, async key => commit.partitions[key] ?? null)
}
;(window as any).reloadWorktrees = reloadWorktrees
;(window as any).sessionListLoading = (id: string) => loading().fetchingSessions.get(id)
;(window as any).runtimeRecovery = { canContinueOpenCodeSetup, continueOpenCodeSetup, refreshOpenCodeSetup, runOpenCodeSetup,
  openFirst: async () => { const { instanceId } = await createInstance("D:/first"); selectInstanceTab(instanceId) },
  retryFirst: async () => {
    openOpenCodeSetup(async () => { const { instanceId } = await createInstance("D:/first"); selectInstanceTab(instanceId) })
    await refreshOpenCodeSetup()
  },
  closeFirst: () => closeInstanceTab("first"),
  discover: (workspace: unknown) => (serverEvents as any).dispatchBatch([{ type: "workspace.created", workspace }]),
}
if (location.search.includes("inventory")) {
  let release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  ;(window as any).releaseInventoryBudget = release
  for (let i = 0; i < 2; i++) void backgroundReads.run(new AbortController().signal, () => blocked)
}

await initializeClientState()
function Fixture() {
  useAppSessionRestore()
  createEffect(() => {
    appTabs()
    appSessionRestoreGateActive()
    ensureActiveAppTab()
  })
  return <div data-restoring={appSessionRestoreGateActive()} style={{ height: "100vh", display: "flex", "flex-direction": "column" }}>
    <For each={appTabs()}>{tab => <button
      role="tab"
      aria-selected={activeAppTabId() === tab.id}
      data-tab-kind={tab.kind}
      data-app-tab-id={tab.id}
      data-session-selection={tab.kind === "instance" ? activeSessionId().get(tab.instance.id) : undefined}
      onClick={() => selectAppTab(tab.id)}
     >{tab.kind === "instance" ? tab.instance.folder : tab.kind === "sidecar" ? tab.sidecarTab.sidecarId : tab.kind === "remote-restore" ? tab.snapshot.folder : ""}
       {location.search.includes("git") && tab.kind === "instance" ? <GitPanel instanceId={tab.instance.id} /> : null}
     </button>}</For>
    <Show when={location.search.includes("catalog")}><ConfigProvider><I18nProvider><ThemeProvider>
      <Show keyed when={activeInstanceId()}>{id => <div style={{ height: "650px", width: "500px" }}>
        <SessionList instanceId={id} threads={getSessionThreads(id)} activeSessionId={activeSessionId().get(id) ?? null}
          onSelect={() => {}} onNew={() => {}} showHeader={false} showFooter={false} />
      </div>}</Show>
    </ThemeProvider></I18nProvider></ConfigProvider></Show>
    <Show when={SessionView}>{View => <ConfigProvider><I18nProvider><ThemeProvider>
      <Show keyed when={activeInstanceId()}>{id => <Show when={sessions().get(id)?.has("saved-session")}>
        {View()({ get instanceId() { return location.search.includes("foreground-slow") ? instances().get(id)!.id : id }, instanceFolder: `D:/${id}`, sessionId: "saved-session",
          get activeSessions() { return sessions().get(id)! }, isActive: true, escapeInDebounce: false })}
      </Show>}
      </Show>
    </ThemeProvider></I18nProvider></ConfigProvider>}</Show>
  </div>
}
;(window as any).disposeRestoreFixture = render(() => <Fixture />, document.getElementById("root")!)
