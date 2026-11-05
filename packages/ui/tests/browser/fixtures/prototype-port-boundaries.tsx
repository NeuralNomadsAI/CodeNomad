import { For } from "solid-js"
import { render } from "solid-js/web"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { serverApi } from "../../../src/lib/api-client"
import { serverEvents } from "../../../src/lib/server-events"
import { addInstance, updateInstance } from "../../../src/stores/instances"
import { initialServerCapabilities } from "../../../../server/src/opencode/servers/capabilities"
import { integrations, integrationBindings } from "../../../src/stores/integrations"
import { setSessions, setActiveSession } from "../../../src/stores/session-state"
import { pluginControlsCache } from "../../../src/stores/plugin-controls"
import { createIntegrationStatusModule } from "../../../src/components/instance/shell/right-panel/integration-status-module"
import { PluginActivationSwitch } from "../../../src/components/plugin-activation-switch"
import { PluginAddMenu } from "../../../src/components/plugin-add-menu"
import { PluginRowActions } from "../../../src/components/plugin-row-actions"
import "../../../src/index.css"

;(serverEvents as any).connectGeneration++
;(serverEvents as any).clearReconnectTimer()
;(serverEvents as any).connection?.disconnect()
;(serverEvents as any).connection = null
;(serverEvents as any).watchdog.setConnected(false)
serverApi.fetchConfigOwner = async () => ({ settings: { locale: "en" } }) as any
serverApi.fetchStateOwner = async () => ({}) as any
const calls: { instanceId: string; method: string }[] = []
const demand = (instanceId: string, method: string) => {
  calls.push({ instanceId, method })
  return () => { calls.push({ instanceId, method: `${method}-release` }) }
}
integrations.state = () => ({ status: "ready", stale: false, response: { integrations: [{
  id: "fixture", displayName: "Fixture integration", family: "native", plugin: { declared: true, runtime: "loaded" },
  state: "ok", configuredSources: [], summary: { en: "Fixture" }, app: { name: "Fixture app" },
  status: { version: "1.0.0", host: { state: "ok", action: "install" }, connection: { offers: 1 } },
}] } }) as any
integrations.demand = instanceId => demand(instanceId, "integrations")
integrationBindings.demand = target => demand(target.instanceId, "binding")
pluginControlsCache.acquireDemand = instanceId => demand(instanceId, "plugins")
pluginControlsCache.mutate = async instanceId => { calls.push({ instanceId, method: "mutate" }); return {} as any }
const ids = ["local-shared", "remote"]
for (const id of ids) {
  const capabilities = initialServerCapabilities({ id, kind: id === "local-shared" ? "local-shared" : "explicit", label: id, origin: "https://server.invalid" } as any, 1 as any)
  // Even injected available metadata cannot qualify the explicit host operations.
  for (const value of Object.values(capabilities.features)) value.state = "available"
  addInstance({ id, folder: "/same", binding: { serverId: id, directory: "/same" }, capabilities,
    client: {} as any, status: "ready", port: 1, pid: 1 }, () => true)
  setSessions(previous => new Map(previous).set(id, new Map([["ses_fixture", { id: "ses_fixture", instanceId: id, title: "Fixture conversation",
    location: { directory: "/same" }, parentId: null, status: "idle", time: { created: 1, updated: 1 } } as any]])))
  setActiveSession(id, "ses_fixture")
}

function Surface(props: { id: string }) {
  const module = createIntegrationStatusModule({ instanceId: props.id, folder: () => "/same", t: key => key, isActive: () => true })
  const location = { directory: "/same" }
  const control = { id: "fixture.plugin", global: "default", project: "default", effective: "enabled" } as const
  return <section data-owner={props.id}>
    <div data-module-sections={module().statusSections?.length ?? 0} />
    <For each={module().statusSections}>{section => section.render()}</For>
    <PluginActivationSwitch instanceId={props.id} location={location} control={control} scope="global" available label="Fixture activation" />
    <div data-add><PluginAddMenu instanceId={props.id} location={location} projectAvailable /></div>
    <div data-actions><PluginRowActions instanceId={props.id} location={location} name="Fixture plugin"
      source={{ type: "package", target: "fixture-package", version: "1.0.0" }} removable={[]} /></div>
  </section>
}
render(() => <ConfigProvider><I18nProvider><ThemeProvider><For each={ids}>{id => <Surface id={id} />}</For></ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
;(window as any).fixture = {
  calls: () => calls,
  retireLocal: () => updateInstance("local-shared", { binding: { serverId: "remote", directory: "/same" } }),
}
