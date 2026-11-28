import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { UsageSettingsSection } from "../../../src/components/settings/usage-settings-section"
import ProviderUsagePanel from "../../../src/components/session/provider-usage-panel"
import { ProviderAccounts } from "../../../src/components/provider-auth/provider-accounts"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { backends, createBackendClient, localBackend, type BackendClient } from "../../../src/lib/backend-client"
import { backendEvents } from "../../../src/lib/backend-events"
import "../../../src/index.css"

const registry = backends as Map<string, BackendClient>
const remote = createBackendClient({ id: "lab", baseUrl: location.origin })
registry.set("lab", remote)
let detach = backendEvents.attach("lab", remote.events)
const calls: { owner: string; method: string; id: string; directory?: string; enabled?: boolean }[] = []
let held = false, version = 1
const pending: (() => void)[] = []
const wait = async () => { if (held) await new Promise<void>(resolve => pending.push(resolve)) }
const [remoteId, setRemoteId] = createSignal("lab~same")
localBackend.api.fetchConfigOwner = async () => ({ settings: { locale: "en" } }) as any
localBackend.api.fetchStateOwner = async () => ({}) as any
const snapshot = (steps: number, query: any, owner: string) => ({ scope: "service", owner, identity: owner, connection: owner,
  stats: { range: { from: query.from, to: query.to }, sessions: 1, subagents: 0, prompts: 1, steps,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0,
    tools: { mode: "none" }, activeDays: 1, streak: 1, models: [], activity: [] } })
function configure(backend: BackendClient, owner: string) {
  const record = (method: string, id: string, directory?: string, enabled?: boolean) => calls.push({ owner, method, id, directory, enabled })
  backend.api.getServiceUsageOwner = async id => { record("owner", id); return { owner, identity: owner, connection: owner } }
  backend.api.getCachedServiceUsage = async (id, _timezone, days) => { record("cache", id); return { owner, identity: owner, connection: owner, days: days ?? 30 } }
  backend.api.getServiceUsage = async (id, query) => {
    record("stats", id); const steps = owner === "local" ? 11 : version === 1 ? 77 : 22
    await wait(); return snapshot(steps, query, owner) as any
  }
  backend.api.fetchProviderUsage = async id => {
    record("quota", id); const usedPercent = owner === "local" ? 11 : version === 1 ? 77 : 22
    await wait(); return { supported: true, configured: true, ok: true, providerName: owner,
      windows: { "5h": { usedPercent, resetAt: null } } } as any
  }
  backend.api.getProviderAccounts = async (id, _integration, directory) => {
    record("accounts", id, directory); const enabled = version > 1
    await wait(); return { supported: true, enabled, logins: { one: `${owner}-${version}` } }
  }
  backend.api.setProviderAccountSelection = async (id, _integration, directory, enabled) => {
    record("selection", id, directory, enabled); await wait(); return { supported: true, enabled, logins: {} }
  }
  return { integration: { list: async () => {
    record("catalog", "native", "/Exact\\Folder/")
    return { data: [{ id: "openai", connections: [
      { type: "credential", id: "one", label: "default", method: "oauth" },
      { type: "credential", id: "two", label: "Second", method: "oauth" },
    ] }] }
  } }, credential: { activate: async () => {}, remove: async () => {}, update: async () => {} } } as any
}
const localClient = configure(localBackend, "local"), remoteClient = configure(remote, "remote")
function Consumers(props: { id: string; client: any }) {
  return <>
    <div data-stats><UsageSettingsSection instanceId={props.id} /></div>
    <div data-quota><ProviderUsagePanel instanceId={props.id} sessionId="session" directory="/Exact\\Folder/" active providerId="openai" modelId="model" /></div>
    <div data-accounts><ProviderAccounts instanceId={props.id} integrationId="openai" client={props.client} location={{ directory: "/Exact\\Folder/" }} /></div>
  </>
}
render(() => <ConfigProvider><I18nProvider>
  <section data-owner="local"><Consumers id="same" client={localClient} /></section>
  <section data-owner="remote"><Consumers id={remoteId()} client={remoteClient} /></section>
</I18nProvider></ConfigProvider>, document.getElementById("root")!)
;(window as any).routing = {
  calls, get pending() { return pending.length }, hold: () => { held = true },
  release: () => { held = false; pending.splice(0).forEach(resolve => resolve()) },
  detach: () => detach(),
  reattach: () => { version++; detach = backendEvents.attach("lab", remote.events) },
  missing: () => { registry.delete("lab"); setRemoteId("lab~missing") },
  event: (owner: string, type = "credential.updated") => ((owner === "local" ? localBackend : remote).events as any).dispatch({
    type: "instance.event", instanceId: "same", event: { type, data: {}, location: { directory: "/Exact\\Folder/" } },
  }),
  status: (generation = 1) => (remote.events as any).dispatch({ type: "instance.eventStatus", instanceId: "same", status: "connected", generation }),
}
