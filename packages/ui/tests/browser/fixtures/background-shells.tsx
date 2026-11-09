import { createSignal } from "solid-js"
import { OpenCode } from "@opencode/client"
import { render } from "solid-js/web"
import StatusTab from "../../../src/components/instance/shell/right-panel/tabs/StatusTab"
import AlertDialog from "../../../src/components/alert-dialog"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider, useI18n } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { serverApi } from "../../../src/lib/api-client"
import { sdkManager } from "../../../src/lib/sdk-manager"
import { addInstance, instances } from "../../../src/stores/instances"
import { DEFAULT_RIGHT_PANEL_CUSTOMIZATION } from "../../../src/components/instance/shell/right-panel/registry"
import { serverEvents } from "../../../src/lib/server-events"
import "../../../src/index.css"

const id = "background-shells"
const folder = new URLSearchParams(location.search).has("wsl") ? "\\\\wsl.localhost\\Ubuntu\\home\\user\\repo" : "/repo"
const client = OpenCode.make({ baseUrl: `${location.origin}/workspaces/${id}/instance/` })
;(sdkManager as any).clients.set(`${id}:/workspaces/${id}/instance`, client)
addInstance({ id, folder, port: 0, pid: 0, proxyPath: "", status: "ready", client })
serverApi.fetchConfigOwner = async () => ({ settings: { locale: "en" } } as any)
serverApi.fetchStateOwner = async () => ({} as any)
const Fixture = () => {
  const { t } = useI18n()
  const [expanded, setExpanded] = createSignal(["background-processes"])
  const [customization, setCustomization] = createSignal({ ...DEFAULT_RIGHT_PANEL_CUSTOMIZATION,
    hiddenStatusSectionIds: ["tokens", "yolo-mode", "provider-usage", "mcp", "plugins"] })
  return <aside style={{ width: "280px" }}><StatusTab t={t} instanceId={id} instance={instances().get(id)!}
    activeSession={() => null} isActive={() => true} expandedItems={expanded} onExpandedItemsChange={setExpanded}
    customization={customization} onCustomizationChange={setCustomization} /><AlertDialog /></aside>
}
render(() => <ConfigProvider><I18nProvider><ThemeProvider><Fixture /></ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
;(window as any).fixture = { event: (type: string, directory = "/repo") => (serverEvents as any).dispatchBatch([{ type: "instance.event", instanceId: id,
  event: { type, location: { directory }, data: {}, id: "event", created: Date.now() } }]) }
