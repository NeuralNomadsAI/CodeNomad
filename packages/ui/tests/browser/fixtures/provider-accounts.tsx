import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { ProviderAccounts } from "../../../src/components/provider-auth/provider-accounts"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { serverEvents } from "../../../src/lib/server-events"
import { applyUiSettings } from "./ui-settings"
import "../../../src/index.css"
const [directory, setDirectory] = createSignal("/a")
let connections: any[] = [{ type: "credential", id: "one", label: "First", method: "key" }, { type: "credential", id: "two", label: "Second", method: "oauth" }, { type: "env", name: "PROVIDER_KEY" }]
const writes: any[] = []
let fail = false, reads = 0
const mutate = async (action: string, input: any) => {
  writes.push({ action, ...input })
  if (fail) { fail = false; throw new Error("fixture failure") }
  const found = connections.find(item => item.id === input.credentialID)
  if (action === "activate") connections = [found, ...connections.filter(item => item !== found)]
  if (action === "rename") found.label = input.label
  if (action === "remove") connections = connections.filter(item => item !== found)
}
const client: any = { integration: { list: async () => { reads++; return { data: [{ id: "provider", connections: structuredClone(connections) }] } } },
  credential: { activate: (input: any) => mutate("activate", input), update: (input: any) => mutate("rename", input), remove: (input: any) => mutate("remove", input) } }
await applyUiSettings({})
render(() => <ConfigProvider><I18nProvider><ThemeProvider><main style={{ width: "min(700px, 100%)" }}>
  <ProviderAccounts instanceId="accounts" integrationId="provider" client={client} location={{ directory: directory() }} />
</main></ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
;(window as any).fixture = { writes, reads: () => reads, setDirectory, fail: () => { fail = true },
  refresh: () => (serverEvents as any).dispatch({ type: "instance.event", instanceId: "accounts", event: { type: "credential.updated", data: {} } }) }
