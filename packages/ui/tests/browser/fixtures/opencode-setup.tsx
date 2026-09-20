import { render } from "solid-js/web"
import OpenCodeSetup from "../../../src/components/opencode-setup"
import { ConfigProvider, updatePreferences } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { serverApi } from "../../../src/lib/api-client"
import { openOpenCodeSetup } from "../../../src/stores/opencode-setup"
import { createInstanceFetch } from "../../../src/lib/sdk-manager"
import "../../../src/index.css"
serverApi.fetchConfigOwner = async () => ({ settings: { locale: "en" } }) as any
serverApi.fetchStateOwner = async () => ({}) as any
serverApi.patchConfigOwner = async (_owner, patch) => patch as any
let resumed = 0
render(() => <ConfigProvider><I18nProvider><OpenCodeSetup /></I18nProvider></ConfigProvider>, document.getElementById("root")!)
await updatePreferences({ locale: "en" })
;(window as any).fixture = {
  open: () => openOpenCodeSetup(async () => { resumed++ }), resumed: () => resumed,
  unsupported: () => createInstanceFetch(`${location.origin}/workspaces/w/instance/`)(`${location.origin}/api/session/s/prompt`,
    { method: "POST", body: "{}" }).then(response => response.status),
}
