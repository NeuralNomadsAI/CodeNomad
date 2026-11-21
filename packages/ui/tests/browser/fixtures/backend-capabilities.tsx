import { createSignal } from "solid-js"
import { OpenCode } from "@opencode/client"
import { render } from "solid-js/web"
import AppActions from "../../../src/components/app-actions"
import StatusTab from "../../../src/components/instance/shell/right-panel/tabs/StatusTab"
import FolderSelectionView from "../../../src/components/folder-selection-view"
import { SettingsScreen } from "../../../src/components/settings-screen"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider, useI18n } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { serverApi } from "../../../src/lib/api-client"
import { sdkManager } from "../../../src/lib/sdk-manager"
import { getServerMeta } from "../../../src/lib/server-meta"
import { addInstance, instances } from "../../../src/stores/instances"
import { loadSpeechCapabilities } from "../../../src/stores/speech"
import { refreshOpenCodeSetup } from "../../../src/stores/opencode-setup"
import { DEFAULT_RIGHT_PANEL_CUSTOMIZATION } from "../../../src/components/instance/shell/right-panel/registry"
import type { Session } from "../../../src/types/session"
import "../../../src/index.css"

// Every HTTP read, /api/meta included, reaches the test's deterministic routes.
const id = "backend-capabilities"
const client = OpenCode.make({ baseUrl: `${location.origin}/workspaces/${id}/instance/` })
;(sdkManager as any).clients.set(`${id}:/workspaces/${id}/instance`, client)
addInstance({ id, folder: "/repo", port: 0, pid: 0, proxyPath: "", status: "ready", client })
serverApi.fetchConfigOwner = async () => ({ settings: { locale: "en" } } as any)
serverApi.fetchStateOwner = async () => ({} as any)

const Fixture = () => {
  const { t } = useI18n()
  const [expanded, setExpanded] = createSignal<string[]>([])
  const [customization, setCustomization] = createSignal({ ...DEFAULT_RIGHT_PANEL_CUSTOMIZATION })
  const session = () => ({ id: "ses_a", location: { directory: "/repo" } } as Session)
  return <div style={{ display: "flex" }}>
    <main style={{ width: "640px" }}><AppActions /><FolderSelectionView onSelectFolder={() => {}} onSelectExistingInstance={() => {}}
      onOpenSidecar={() => {}} onNewTemporaryInstance={() => {}} /></main>
    <aside style={{ width: "280px" }}><StatusTab t={t} instanceId={id} instance={instances().get(id)!} activeSession={session}
      isActive={() => true} expandedItems={expanded} onExpandedItemsChange={setExpanded}
      customization={customization} onCustomizationChange={setCustomization} /></aside>
    <section style={{ width: "900px" }}><SettingsScreen standalone /></section>
  </div>
}

;(window as any).fixture = { loadSpeechCapabilities, refreshOpenCodeSetup }
// Local workspace inventory resolves the host's route families before displaying its panels.
void getServerMeta().then(() => {
  render(() => <ConfigProvider><I18nProvider><ThemeProvider><Fixture /></ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
  document.documentElement.dataset.metaSettled = "true"
})
