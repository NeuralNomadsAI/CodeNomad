import { Show } from "solid-js"
import { render } from "solid-js/web"
import InstanceTabs from "../../../src/components/instance-tabs"
import PromptInput from "../../../src/components/prompt-input"
import { activeAppTabId, appTabs, closeInstanceTab, selectAppTab, selectInstanceTab } from "../../../src/stores/app-tabs"
import { addInstance, instances } from "../../../src/stores/instances"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { releaseAppSessionRestoreGate } from "../../../src/stores/app-session-restore-gate"
import { serverEvents } from "../../../src/lib/server-events"
import { applyUiSettings } from "./ui-settings"
import "../../../src/index.css"

const NO_SESSION = "__no_session_draft__"

function open(id: string, folder: string) {
  addInstance({ id, folder, projectName: id, port: 0, pid: 0,
    proxyPath: `/workspaces/${id}/instance`, status: "ready", client: null })
  selectInstanceTab(id)
}

releaseAppSessionRestoreGate()
await applyUiSettings({ locale: "en" })
open("first", "D:\\Drafts\\Project")
;(window as any).draftsFixture = {
  open,
  records: () => [...instances().keys()],
  stopped: (id: string) => (serverEvents as any).dispatchBatch([{ type: "workspace.stopped", workspaceId: id, reason: "deleted" }]),
}

function Fixture() {
  const active = () => {
    const tab = appTabs().find(tab => tab.id === activeAppTabId())
    return tab?.kind === "instance" ? tab.instance : null
  }
  return <>
    <InstanceTabs tabs={appTabs()} activeTabId={activeAppTabId()} onSelect={selectAppTab}
      onClose={id => { if (id.startsWith("instance:")) closeInstanceTab(id.slice("instance:".length)) }} onNew={() => {}} />
    <Show when={active()} keyed>{instance =>
      <PromptInput instanceId={instance.id} instanceFolder={instance.folder} sessionId={NO_SESSION} isActive={true} onSend={async () => {}} />
    }</Show>
  </>
}

render(() => <ConfigProvider><I18nProvider><ThemeProvider><Fixture /></ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
