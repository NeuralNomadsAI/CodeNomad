import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { WebSearchSettingsCard } from "../../../src/components/settings/websearch-settings-card"
import { ProvidersSettingsSection } from "../../../src/components/settings/providers-settings-section"
import { SettingsScreen } from "../../../src/components/settings-screen"
import { setActiveSettingsSection } from "../../../src/stores/settings-screen"
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

const params = new URLSearchParams(location.search)
const isPreview = params.has("page")
const searchProviders = isPreview ? [{ id: "exa", name: "Exa" }, { id: "tavily", name: "Tavily" }, { id: "tinyfish", name: "TinyFish" }]
  : [{ id: "alpha", name: "Alpha" }]
const integrationData: any[] = searchProviders.map((provider, index) => ({ ...provider, methods: [{ type: "key", label: "API key" }],
  connections: index === 0 ? [{ type: "env", name: isPreview ? "EXA_API_KEY" : "ALPHA_API_KEY" }, { type: "credential", id: "key-id", label: "Saved key", method: "key" }] : [] }))
integrationData.push(
  { id: "openai", name: "OpenAI", methods: [{ type: "key", label: "API key" }], connections: [{ type: "env", name: "OPENAI_API_KEY" }] },
  { id: "anthropic", name: "Anthropic", methods: [{ type: "key", label: "API key" }], connections: [{ type: "env", name: "ANTHROPIC_API_KEY" }] },
)
const [directory, setDirectory] = createSignal("/a")
const [active, setActive] = createSignal(true), [expanded, setExpanded] = createSignal<string[]>([])
const [customization, setCustomization] = createSignal(parseRightPanelCustomization({}))
shellStore.load = async () => {}
const selections: Record<string, { global: string | false | null; project: string | false | null }> = {}
const writes: any[] = [], keys: any[] = []
let integrationLists = 0
let reject = false, hold = false, release: (() => void) | undefined
serverApi.getWebSearchSettings = async (_id, directory) => {
  const state = selections[directory] ??= { global: searchProviders[0].id, project: null }
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
  provider: { list: async () => ({ data: [{ id: "openai", name: "OpenAI", integrationID: "openai" }, { id: "anthropic", name: "Anthropic", integrationID: "anthropic" }] }) },
  model: { list: async () => ({ data: [{ id: "gpt-5", name: "GPT-5", providerID: "openai" }, { id: "claude-sonnet-4", name: "Claude Sonnet 4", providerID: "anthropic" }] }) },
  websearch: { providers: async () => ({ data: searchProviders }) },
  integration: { list: async () => { integrationLists++; return { data: structuredClone(integrationData) } },
    connect: { key: async (value: any) => {
      keys.push(value)
      if (reject) { reject = false; throw new Error("fixture connection failure") }
      if (hold) { hold = false; await new Promise<void>(resolve => { release = resolve }) }
      integrationData.find(item => item.id === value.integrationID)?.connections.push({ type: "credential", id: `saved-${keys.length}`, label: "Saved key", method: "key" })
    } } },
  credential: { remove: async (value: any) => {
    keys.push(value)
    for (const item of integrationData) item.connections = item.connections.filter((connection: any) => connection.id !== value.credentialID)
  } },
}
;(sdkManager as any).clients.set("web:/workspaces/web/instance", client)
await applyUiSettings(params.has("page") ? { locale: "fr", theme: params.has("light") ? "light" : "dark" } : {})
if (params.has("page")) setActiveSettingsSection("providers")
function ProjectStatus() {
  const { t } = useI18n()
  return <StatusTab instanceId="web" instance={{ id: "web", folder: directory(), status: "ready", client } as any}
    t={t} activeSession={() => null} isActive={active} expandedItems={expanded} onExpandedItemsChange={setExpanded}
    customization={customization} onCustomizationChange={setCustomization} />
}
render(() => <ConfigProvider><I18nProvider><ThemeProvider>{params.has("page")
  ? <SettingsScreen standalone providerContext={{ instanceId: "web", location: { directory: directory() } }} />
  : <main style={{ width: "min(700px, 100%)" }}>
  {new URLSearchParams(location.search).has("project") ? <ProjectStatus />
    : new URLSearchParams(location.search).has("preview")
      ? <ProvidersSettingsSection instanceId="web" location={{ directory: directory() }} />
      : <WebSearchSettingsCard instanceId="web" location={{ directory: directory() }} />}
</main>}</ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
;(window as any).fixture = { writes, keys, setDirectory, setActive, integrationLists: () => integrationLists, reject: () => { reject = true }, hold: () => { hold = true }, release: () => release?.() }
