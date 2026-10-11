import "./new-instance-launcher-state"
import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import InstanceTabs from "../../../src/components/instance-tabs"
import NewInstanceLauncher from "../../../src/components/new-instance-launcher"
import { ConfigProvider, updatePreferences } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { addInstance } from "../../../src/stores/instances"
import type { AppTabRecord } from "../../../src/stores/app-tabs"
import type { Instance } from "../../../src/types/instance"
import "../../../src/index.css"

const open: Instance = { id: "codenomad-tab", folder: "D:/CodeNomad", port: 0, pid: 0, proxyPath: "/fixture", status: "ready", client: null, projectName: "CodeNomad" }
addInstance(open)
const tabs: AppTabRecord[] = [{ id: `instance:${open.id}`, kind: "instance", instance: open }]

const calls: string[] = []
function Fixture() {
  const [launcherOpen, setLauncherOpen] = createSignal(false)
  const [anchor, setAnchor] = createSignal<HTMLElement>()
  return <>
    <InstanceTabs tabs={tabs} activeTabId={tabs[0].id} onSelect={() => {}} onClose={() => {}}
      onNew={() => calls.push("home")} onMoveTab={() => {}}
      onOpenLauncher={(element) => { setAnchor(element); setLauncherOpen(true) }} launcherOpen={launcherOpen()} />
    <NewInstanceLauncher open={launcherOpen()} anchor={anchor()} isLoading={false} onOpenChange={setLauncherOpen}
      onSelectFolder={(path) => calls.push(`folder:${path}`)}
      onSelectExistingInstance={(id, path) => calls.push(`existing:${id}:${path}`)}
      onNewTemporaryInstance={() => calls.push("temporary")}
      onOpenSidecar={() => calls.push("sidecar")}
      onOpenHome={() => calls.push("full-home")} />
  </>
}

render(() => <ConfigProvider><I18nProvider><Fixture /></I18nProvider></ConfigProvider>, document.getElementById("root")!)
await updatePreferences({ locale: "en" })
;(window as any).launcherFixture = { calls }
