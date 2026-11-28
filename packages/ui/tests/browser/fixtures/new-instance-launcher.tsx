import "./new-instance-launcher-state"
import { createSignal, lazy, Show } from "solid-js"
import { render } from "solid-js/web"
import InstanceTabs from "../../../src/components/instance-tabs"
import NewInstanceLauncher from "../../../src/components/new-instance-launcher"
import { ConfigProvider, updatePreferences } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { addInstance } from "../../../src/stores/instances"
import { attachInstanceTab, type AppTabRecord } from "../../../src/stores/app-tabs"
import type { Instance } from "../../../src/types/instance"
import "../../../src/index.css"

const open: Instance = { id: "codenomad-tab", folder: "D:/CodeNomad", port: 0, pid: 0, proxyPath: "/fixture", status: "ready", client: null, projectName: "CodeNomad" }
addInstance(open)
attachInstanceTab(open.id)
addInstance({ ...open, id: "other-codenomad", projectName: undefined })
addInstance({ ...open, id: "other-blender", folder: "D:\\blender", projectName: undefined })
addInstance({ ...open, id: "remote-unsloth", folder: "D:/unsloth", backendId: "saved-server" })
addInstance({ ...open, id: "starting", folder: "D:/archive/project-0", status: "starting" })
const tabs: AppTabRecord[] = [{ id: `instance:${open.id}`, kind: "instance", instance: open }]

const calls: string[] = []
const EmptyTab = lazy(() => import("../../../src/components/folder-selection-view"))
const [launcherOpen, setLauncherOpen] = createSignal(false)
const [loading, setLoading] = createSignal(false)
const blank = new URLSearchParams(location.search).has("blank")
function Fixture() {
  const [anchor, setAnchor] = createSignal<HTMLElement>()
  return <Show when={blank} fallback={<>
    <InstanceTabs tabs={tabs} activeTabId={tabs[0].id} onSelect={() => {}} onClose={() => {}}
      onNew={() => calls.push("blank")} onMoveTab={() => {}}
      onOpenLauncher={(element) => { setAnchor(element); setLauncherOpen(true) }} launcherOpen={launcherOpen()} />
    <NewInstanceLauncher open={launcherOpen()} anchor={anchor()} isLoading={false} onOpenChange={setLauncherOpen}
      onSelectFolder={(path) => calls.push(`folder:${path}`)}
      onSelectExistingInstance={(id, path) => calls.push(`existing:${id}:${path}`)}
      onNewTemporary={() => calls.push("temporary")}
      />
    {/* Stands in for another window (command palette) taking focus. */}
    <input id="other-surface" aria-label="Other surface" />
  </>}>
    <div style="height:100dvh"><EmptyTab active isLoading={loading()} onSelectFolder={(path) => calls.push(`folder:${path}`)} onSelectExistingInstance={() => {}}
      onNewTemporaryInstance={() => calls.push("temporary")} /></div>
  </Show>
}

render(() => <ConfigProvider><I18nProvider><Fixture /></I18nProvider></ConfigProvider>, document.getElementById("root")!)
await updatePreferences({ locale: "en" })
;(window as any).launcherFixture = { calls, close: () => setLauncherOpen(false), setLoading, setLocale: (locale: string) => updatePreferences({ locale }) }
