import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { WebSearchSettingsCard } from "../../../src/components/settings/websearch-settings-card"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { sdkManager } from "../../../src/lib/sdk-manager"
import { serverApi } from "../../../src/lib/api-client"
import { applyUiSettings } from "./ui-settings"
import "../../../src/index.css"

const [directory, setDirectory] = createSignal("/a")
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
render(() => <ConfigProvider><I18nProvider><ThemeProvider><main style={{ width: "min(700px, 100%)" }}>
  <WebSearchSettingsCard instanceId="web" location={{ directory: directory() }} />
</main></ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
;(window as any).fixture = { writes, keys, setDirectory, integrationLists: () => integrationLists, reject: () => { reject = true }, hold: () => { hold = true }, release: () => release?.() }
