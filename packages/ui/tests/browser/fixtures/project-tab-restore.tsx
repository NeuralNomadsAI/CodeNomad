import { createEffect, For, Show } from "solid-js"
import { render } from "solid-js/web"
import { initializeClientState } from "../../../src/stores/client-state"
import { decodeClientSnapshotV2 } from "../../../src/stores/client-state-partitions"
import { useAppSessionRestore } from "../../../src/lib/hooks/use-app-session-restore"
import { activeAppTabId, appTabs, ensureActiveAppTab, selectAppTab } from "../../../src/stores/app-tabs"
import { appSessionRestoreGateActive } from "../../../src/stores/app-session-restore-gate"
import { activeInstanceId } from "../../../src/stores/instances"
import { activeSessionId } from "../../../src/stores/session-state"
import { sessions, getSessionListIds, getSessionThreads, loading } from "../../../src/stores/session-state"
import SessionList from "../../../src/components/session-list"
import { reloadWorktrees } from "../../../src/stores/worktrees"
import { backgroundReads } from "../../../src/lib/background-read-queue"
import { messageStoreBus } from "../../../src/stores/message-v2/bus"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { useGitChanges } from "../../../src/components/instance/shell/right-panel/useGitChanges"

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
;(window as any).catalogRows = (id: string) => [...(sessions().get(id)?.values() ?? [])]
;(window as any).decodeSavedState = () => {
  const commit = (window as any).committedState
  return commit && decodeClientSnapshotV2(commit.snapshot, 1, async key => commit.partitions[key] ?? null)
}
;(window as any).reloadWorktrees = reloadWorktrees
;(window as any).sessionListLoading = (id: string) => loading().fetchingSessions.get(id)
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
      data-session-selection={tab.kind === "instance" ? activeSessionId().get(tab.instance.id) : undefined}
      onClick={() => selectAppTab(tab.id)}
     >{tab.kind === "instance" ? tab.instance.folder : tab.sidecarTab.sidecarId}
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
        {View()({ instanceId: id, instanceFolder: `D:/${id}`, sessionId: "saved-session",
          get activeSessions() { return sessions().get(id)! }, isActive: true, escapeInDebounce: false })}
      </Show>}
      </Show>
    </ThemeProvider></I18nProvider></ConfigProvider>}</Show>
  </div>
}
render(() => <Fixture />, document.getElementById("root")!)
