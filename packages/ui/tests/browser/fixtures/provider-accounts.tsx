import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { ProviderAccounts } from "../../../src/components/provider-auth/provider-accounts"
import { ProviderManagerModal } from "../../../src/components/provider-auth/provider-manager-modal"
import { sdkManager } from "../../../src/lib/sdk-manager"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { serverEvents } from "../../../src/lib/server-events"
import { applyUiSettings } from "./ui-settings"
import "../../../src/index.css"
const [directory, setDirectory] = createSignal("/a")
const unconnected = new URLSearchParams(location.search).has("unconnected")
let connections: any[] = unconnected ? [] : [{ type: "credential", id: "one", label: "First", method: "key" }, { type: "credential", id: "two", label: "Second", method: "oauth" }, { type: "env", name: "PROVIDER_KEY" }]
const writes: any[] = []
const external = new URLSearchParams(location.search).has("external")
const integrationId = new URLSearchParams(location.search).get("integration") ?? (unconnected ? "opencode" : "provider")
const otherIntegrations = unconnected ? [
  { id: "env-only", name: "Environment only", methods: [{ type: "env", names: ["ENV_KEY"] }], connections: [{ type: "env", name: "ENV_KEY" }] },
  { id: "no-methods", name: "No connect methods", methods: [], connections: [] },
] : []
let fail = false, reads = 0
let deferParent = false, releaseParent: (() => void) | undefined
const mutate = async (action: string, input: any) => {
  writes.push({ action, ...input })
  if (fail) { fail = false; throw new Error("fixture failure") }
  const found = connections.find(item => item.id === input.credentialID)
  if (action === "activate") connections = [found, ...connections.filter(item => item !== found)]
  if (action === "rename") found.label = input.label
  if (action === "remove") connections = connections.filter(item => item !== found)
}
const client: any = { provider: { list: async () => {
  if (deferParent) { deferParent = false; await new Promise<void>(resolve => { releaseParent = resolve }) }
  return { data: unconnected
    ? [{ id: "opencode", name: "OpenCode Console", integrationID: "opencode" }, ...otherIntegrations.map(item => ({ id: item.id, name: item.name }))]
    : [{ id: "provider", name: "Fixture provider", activation: "enabled", package: "fixture" }] }
} },
  model: { list: async () => ({ data: [] }) },
  websearch: { providers: async () => ({ data: [] }) },
  integration: { list: async () => { reads++; return { data: [{ id: integrationId, name: unconnected ? "OpenCode Console" : "Fixture provider", methods: unconnected
    ? [{ type: "key", label: "API key (service account)" }, { type: "env", names: ["OPENCODE_API_KEY"] }, { type: "oauth", id: "console-device", label: "OpenCode Console account" }]
    : external
    ? [{ type: "external", id: "fixture-source", label: "Native credential source", form: [{ key: "resource", type: "string", label: "Resource", required: true }] }]
    : [{ type: "key", label: "API key" }], connections: structuredClone(connections) }, ...otherIntegrations] } }, connect: {
      external: async (input: any) => {
        writes.push({ action: "external", ...input })
        if (fail) { fail = false; throw new Error("fixture failure") }
      },
      key: async (input: any) => {
        if (!unconnected) throw new Error("External credentials must not use API key auth")
        writes.push({ action: "key", ...input })
        connections = [{ type: "credential", id: "console-key", label: "Console service account", method: "key" }]
      },
    }, oauth: { connect: async () => { throw new Error("External credentials must not use OAuth") } } },
  credential: { activate: (input: any) => mutate("activate", input), update: (input: any) => mutate("rename", input), remove: (input: any) => mutate("remove", input) } }
await applyUiSettings({})
;(sdkManager as any).clients.set("accounts:/workspaces/accounts/instance", client)
render(() => <ConfigProvider><I18nProvider><ThemeProvider><main style={{ width: "min(700px, 100%)" }}>
  {new URLSearchParams(location.search).has("parent")
    ? <ProviderManagerModal instanceId="accounts" location={{ directory: directory() }} embedded />
    : <ProviderAccounts instanceId="accounts" integrationId={integrationId} client={client} location={{ directory: directory() }} />}
</main></ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
;(window as any).fixture = { writes, reads: () => reads, setDirectory, fail: () => { fail = true },
  deferParent: () => { deferParent = true }, parentPending: () => Boolean(releaseParent),
  releaseParent: () => { releaseParent?.(); releaseParent = undefined },
  switchExternally: () => {
    connections = [connections[1], connections[0], ...connections.slice(2)]
    ;(serverEvents as any).dispatch({ type: "instance.event", instanceId: "accounts", event: { type: "credential.switched", data: {} } })
  },
  refresh: () => (serverEvents as any).dispatch({ type: "instance.event", instanceId: "accounts", event: { type: "credential.updated", data: {} } }) }
