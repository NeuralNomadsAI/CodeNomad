import { render } from "solid-js/web"
import InstanceTabs from "../../../src/components/instance-tabs"
import { activeAppTabId, appTabs, selectAppTab, selectInstanceTab } from "../../../src/stores/app-tabs"
import { addInstance, instances, removeInstance } from "../../../src/stores/instances"
import { ConfigProvider, uiState, updatePreferences } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { releaseAppSessionRestoreGate } from "../../../src/stores/app-session-restore-gate"
import "../../../src/index.css"

await updatePreferences({})
releaseAppSessionRestoreGate()
for (const [id, serverId, folder] of [["local", "local-shared", "D:/same"], ["a1", "A", "D:/same"],
  ["a2", "A", "D:/same"], ["b", "B", "D:/same"], ["alias", "A", "d:/same"]]) {
  addInstance({ id, folder, binding: { serverId, directory: folder }, projectName: id,
    port: 0, pid: 0, proxyPath: "", status: "ready", client: null })
  selectInstanceTab(id)
}
;(window as any).renameFixture = {
  select: selectInstanceTab,
  remove: (id: string) => removeInstance(id, { authoritative: false }),
  names: () => Object.fromEntries([...instances()].map(([id, instance]) => [id, instance.projectName])),
  recents: () => uiState().recentFolders,
}
render(() => <ConfigProvider><I18nProvider><ThemeProvider>
  <InstanceTabs tabs={appTabs()} activeTabId={activeAppTabId()} onSelect={selectAppTab}
    onClose={() => {}} onNew={() => {}} onMoveTab={() => {}} />
</ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
