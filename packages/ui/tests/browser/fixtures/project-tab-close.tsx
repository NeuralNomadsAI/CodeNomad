import { render } from "solid-js/web"
import InstanceTabs from "../../../src/components/instance-tabs"
import { activeAppTabId, appTabs, closeInstanceTab, selectAppTab, selectInstanceTab } from "../../../src/stores/app-tabs"
import { addInstance, instances } from "../../../src/stores/instances"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { useAppLifecycle } from "../../../src/lib/hooks/use-app-lifecycle"
import { releaseAppSessionRestoreGate } from "../../../src/stores/app-session-restore-gate"
import { serverEvents } from "../../../src/lib/server-events"
import { getToastHistory } from "../../../src/lib/notifications"
import "../../../src/index.css"

releaseAppSessionRestoreGate()
for (const id of ["first", "second"]) {
  addInstance({ id, folder: "D:/same-folder", projectName: id, port: 0, pid: 0,
    proxyPath: `/workspaces/${id}/instance`, status: "ready", client: null })
  selectInstanceTab(id)
}
;(window as any).closeFixture = {
  records: () => [...instances().keys()],
  history: getToastHistory,
  stopped: (id: string, reason = "deleted") => (serverEvents as any).dispatchBatch([
    { type: "workspace.stopped", workspaceId: id, reason },
  ]),
}

function Fixture() {
  const close = async () => {
    const tab = appTabs().find(tab => tab.id === activeAppTabId())
    if (tab?.kind === "instance") closeInstanceTab(tab.instance.id)
  }
  useAppLifecycle({ setEscapeInDebounce() {}, handleNewInstanceRequest() {}, handleCloseActiveTab: close,
    handleNewSession: async () => {}, handleCloseSession: async () => {}, showFolderSelection: () => false,
    setShowFolderSelection() {}, getActiveInstance: () => null, getActiveSessionIdForInstance: () => null })
  return <InstanceTabs tabs={appTabs()} activeTabId={activeAppTabId()} onSelect={selectAppTab}
    onClose={id => { if (id.startsWith("instance:")) closeInstanceTab(id.slice("instance:".length)) }} onNew={() => {}} />
}

render(() => <ConfigProvider><I18nProvider><ThemeProvider><Fixture /></ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
