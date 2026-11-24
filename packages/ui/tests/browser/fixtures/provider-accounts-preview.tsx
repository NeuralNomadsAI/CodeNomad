// Interactive design sandbox: synthetic labels and quotas, no live credentials.
import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { SettingsScreen } from "../../../src/components/settings-screen"
import { setActiveSettingsSection } from "../../../src/stores/settings-screen"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { sdkManager } from "../../../src/lib/sdk-manager"
import { serverApi } from "../../../src/lib/api-client"
import { serverEvents } from "../../../src/lib/server-events"
import { applyUiSettings } from "./ui-settings"
import "../../../src/index.css"
import "./provider-accounts-preview.css"

const params = new URLSearchParams(location.search)
const single = params.has("single")
const [automatic, setAutomatic] = createSignal(params.has("auto"))
const [used, setUsed] = createSignal<Record<string, number>>({ personal: 76, work: 24, spare: 12 })
const [rows, setRows] = createSignal<any[]>([
  { type: "credential", id: "personal", label: "default", method: "oauth" },
  ...single ? [] : [
    { type: "credential", id: "work", label: "alex@studio.fr", method: "oauth" },
    { type: "credential", id: "spare", label: "Compte équipe", method: "oauth" },
  ],
])
const integrations: any[] = [
  { id: "anthropic", name: "Anthropic", connections: [{ type: "credential", id: "claude", label: "alex@exemple.fr", method: "oauth" }] },
  { id: "openrouter", name: "OpenRouter", connections: [] },
  { id: "exa", name: "Exa", connections: [{ type: "credential", id: "exa-key", label: "Clé API", method: "key" }] },
  { id: "tavily", name: "Tavily", connections: [] },
].map(item => ({ ...item, methods: [{ type: "key", label: "API key" }] }))
const catalog = () => [{ id: "openai", name: "OpenAI", methods: [{ type: "key", label: "API key" }], connections: rows() }, ...integrations]
const notify = () => (serverEvents as any).dispatch({ type: "instance.event", instanceId: "preview", event: { type: "credential.updated", data: {} } })
const mutate = async (action: string, input: any) => {
  const integration = catalog().find(item => item.connections.some((row: any) => row.id === input.credentialID))
  const next = integration!.connections.map((row: any) => ({ ...row }))
  const found = next.find((row: any) => row.id === input.credentialID)!
  if (action === "activate") next.splice(0, next.length, found, ...next.filter((row: any) => row !== found))
  if (action === "rename") found.label = input.label
  if (action === "remove") next.splice(next.indexOf(found), 1)
  if (integration!.id === "openai") setRows(next)
  else integrations.find(item => item.id === integration!.id).connections = next
  notify()
}
const client: any = {
  provider: { list: async () => ({ data: ["openai", "anthropic", "openrouter"].filter(id => catalog().find(item => item.id === id)!.connections.length > 0).map(id => ({ id, name: catalog().find(item => item.id === id)!.name, integrationID: id })) }) },
  model: { list: async () => ({ data: [] }) },
  websearch: { providers: async () => ({ data: [{ id: "exa", name: "Exa" }, { id: "tavily", name: "Tavily" }] }) },
  integration: { list: async () => ({ data: structuredClone(catalog()) }), connect: { key: async (input: any) => {
    const saved = { type: "credential", id: `demo-${Date.now()}`, label: "Clé API", method: "key" }
    if (input.integrationID === "openai") setRows([saved, ...rows()])
    else catalog().find(item => item.id === input.integrationID)!.connections.unshift(saved)
    notify()
  } } },
  credential: { activate: (input: any) => mutate("activate", input), update: (input: any) => mutate("rename", input), remove: (input: any) => mutate("remove", input) },
}
;(sdkManager as any).clients.set("preview:/workspaces/preview/instance", client)
let global: string | false | null = "exa", project: string | false | null = null
serverApi.getWebSearchSettings = async () => ({ location: { directory: "/preview" }, effective: project ?? global,
  scopes: [{ scope: "global", path: "/preview/global.jsonc", selection: global }, { scope: "project", path: "/preview/project.jsonc", selection: project }] })
serverApi.setWebSearchSettings = async (_id, input) => { if (input.scope === "global") global = input.provider; else project = input.provider }
const policyWrites: boolean[] = []
let failPolicy = false
serverApi.getProviderAccounts = async (_id, integrationID) => ({ supported: integrationID === "openai" && rows().length > 1,
  enabled: automatic(), logins: integrationID === "openai" ? { personal: "alex@exemple.fr" } : {} })
serverApi.setProviderAccountSelection = async (_id, integrationID, directory, enabled) => {
  policyWrites.push(enabled)
  if (failPolicy) { failPolicy = false; throw new Error("Synthetic policy failure") }
  setAutomatic(enabled); notify()
  return serverApi.getProviderAccounts("preview", integrationID, directory)
}
await applyUiSettings({ locale: "fr", theme: params.has("light") ? "light" : "dark" })
setActiveSettingsSection("providers")

function Simulation() {
  const exhaust = () => {
    const current = rows()[0]
    if (!current) return
    const quotas = { ...used(), [current.id]: 100 }
    setUsed(quotas)
    if (!automatic()) return
    const next = rows().find(row => Number.isFinite(quotas[row.id]) && quotas[row.id] < 100)
    if (next) void mutate("activate", { credentialID: next.id })
  }
  return <>
    <nav class="accounts-preview-toolbar" aria-label="Aperçus">
      <span>Aperçu · données fictives</span>
      <a href="/preview">Manuel</a><a href="/preview?auto">Auto</a><a href="/preview?single">Un compte</a>
      <a href={params.has("light") ? "/preview" : "/preview?light"}>Clair / sombre</a>
      <span aria-live="polite">Usage simulé : {used()[rows()[0]?.id] ?? "—"} %</span>
      <button type="button" class="selector-button" onClick={exhaust}>Simuler 100 %</button>
    </nav>
  </>
}
render(() => <ConfigProvider><I18nProvider><ThemeProvider><div class="accounts-preview-root">
  <SettingsScreen standalone providerContext={{ instanceId: "preview", location: { directory: "/preview" } }} />
  <Simulation />
</div></ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
;(window as any).accountsPreview = { rows, used, automatic, policyWrites, failPolicy: () => { failPolicy = true },
  refresh: notify }
