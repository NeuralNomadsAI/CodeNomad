import { createEffect, For, Show } from "solid-js"
import { render } from "solid-js/web"
import { initializeClientState } from "../../../src/stores/client-state"
import { useAppSessionRestore } from "../../../src/lib/hooks/use-app-session-restore"
import { activeAppTabId, appTabs, ensureActiveAppTab, selectAppTab } from "../../../src/stores/app-tabs"
import { appSessionRestoreGateActive } from "../../../src/stores/app-session-restore-gate"
import { activeInstanceId } from "../../../src/stores/instances"
import { activeSessionId } from "../../../src/stores/session-state"
import { sessions } from "../../../src/stores/session-state"
import { messageStoreBus } from "../../../src/stores/message-v2/bus"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"

const SessionView = location.search.includes("foreground")
  ? (await import("../../../src/components/session/session-view")).default : undefined
if (SessionView) await import("../../../src/index.css")
;(window as any).messageCount = () => messageStoreBus.getOrCreate(activeInstanceId()!).getSessionMessageIds("saved-session").length

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
    >{tab.kind === "instance" ? tab.instance.folder : tab.sidecarTab.sidecarId}</button>}</For>
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
