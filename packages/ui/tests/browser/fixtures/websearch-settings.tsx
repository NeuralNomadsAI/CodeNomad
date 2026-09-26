import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { WebSearchSettingsCard } from "../../../src/components/settings/websearch-settings-card"
import StatusTab from "../../../src/components/instance/shell/right-panel/tabs/StatusTab"
import { parseRightPanelCustomization } from "../../../src/components/instance/shell/right-panel/registry"
import { shellStore } from "../../../src/stores/shells"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider, useI18n } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { sdkManager } from "../../../src/lib/sdk-manager"
import { serverApi } from "../../../src/lib/api-client"
import { applyUiSettings } from "./ui-settings"
import "../../../src/index.css"

const [directory, setDirectory] = createSignal("/a")
const [active, setActive] = createSignal(true), [expanded, setExpanded] = createSignal(["websearch"])
const [customization, setCustomization] = createSignal(parseRightPanelCustomization({}))
shellStore.load = async () => {}
const selections: Record<string, { global: string | false | null; project: string | false | null }> = {}
const writes: any[] = [], keys: any[] = []
let integrationLists = 0
let reject = false, hold = false, release: (() => void) | undefined
serverApi.getWebSearchSettings = async (_id, directory) => {
  const state = selections[directory] ??= { global: "alpha", project: null }
  return { location: { directory }, effective: state.project ?? state.global,
    scopes: (["global", "project"] as const).map(scope => ({ scope, path: `${directory}/${scope}.jsonc`, selection: state[scope] })) }
}
serverApi.setWebSearchSettings = async (_id, payload) => {
  writes.push(payload)
  if (reject) { reject = false; throw new Error("fixture mutation failure") }
  if (hold) { hold = false; await new Promise<void>(resolve => { release = resolve }) }
  selections[payload.location.directory][payload.scope] = payload.provider
}
const client = {
  websearch: { providers: async () => ({ data: [{ id: "alpha", name: "Alpha" }] }) },
  integration: { list: async () => { integrationLists++; return { data: [{ id: "alpha", name: "Alpha", methods: [{ type: "key" }],
    connections: [{ type: "env", name: "ALPHA_API_KEY" }, { type: "credential", id: "key-id", label: "Saved key", method: "key" }] }] } },
    connect: { key: async (value: any) => { keys.push(value) } } },
  credential: { remove: async (value: any) => { keys.push(value) } },
}
;(sdkManager as any).clients.set("web:/workspaces/web/instance", client)
await applyUiSettings({})
function ProjectStatus() {
  const { t } = useI18n()
  return <StatusTab instanceId="web" instance={{ id: "web", folder: directory(), status: "ready", client } as any}
    t={t} activeSession={() => null} isActive={active} expandedItems={expanded} onExpandedItemsChange={setExpanded}
    customization={customization} onCustomizationChange={setCustomization} />
}
render(() => <ConfigProvider><I18nProvider><ThemeProvider><main style={{ width: "min(700px, 100%)" }}>
  {new URLSearchParams(location.search).has("project") ? <ProjectStatus />
    : <WebSearchSettingsCard instanceId="web" location={{ directory: directory() }} scope="global" />}
</main></ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
;(window as any).fixture = { writes, keys, setDirectory, setActive, integrationLists: () => integrationLists, reject: () => { reject = true }, hold: () => { hold = true }, release: () => release?.() }
