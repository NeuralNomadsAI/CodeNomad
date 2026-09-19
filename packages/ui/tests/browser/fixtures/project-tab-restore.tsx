import { createEffect, For } from "solid-js"
import { render } from "solid-js/web"
import { initializeClientState } from "../../../src/stores/client-state"
import { useAppSessionRestore } from "../../../src/lib/hooks/use-app-session-restore"
import { activeAppTabId, appTabs, ensureActiveAppTab, selectAppTab } from "../../../src/stores/app-tabs"
import { appSessionRestoreGateActive } from "../../../src/stores/app-session-restore-gate"
import { activeSessionId } from "../../../src/stores/session-state"

await initializeClientState()
function Fixture() {
  useAppSessionRestore()
  createEffect(() => {
    appTabs()
    appSessionRestoreGateActive()
    ensureActiveAppTab()
  })
  return <div data-restoring={appSessionRestoreGateActive()}>
    <For each={appTabs()}>{tab => <button
      role="tab"
      aria-selected={activeAppTabId() === tab.id}
      data-session-selection={tab.kind === "instance" ? activeSessionId().get(tab.instance.id) : undefined}
      onClick={() => selectAppTab(tab.id)}
    >{tab.kind === "instance" ? tab.instance.folder : tab.sidecarTab.sidecarId}</button>}</For>
  </div>
}
render(() => <Fixture />, document.getElementById("root")!)
