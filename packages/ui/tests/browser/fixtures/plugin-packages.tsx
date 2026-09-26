import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { PluginPackageAction } from "../../../src/components/plugin-package-action"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { sdkManager } from "../../../src/lib/sdk-manager"
import { pluginControlsCache } from "../../../src/stores/plugin-controls"
import { applyUiSettings } from "./ui-settings"
import "../../../src/index.css"
const [source, setSource] = createSignal<any>({ type: "package", target: "fixture-plugin@latest", version: "1.0.0" })
const [active, setActive] = createSignal(true)
const requests: any[] = []
let resolve: () => void, reject: () => void, invalidations = 0
pluginControlsCache.invalidateInstance = () => { invalidations++ }
const client: any = { plugin: {
  check: async (input: any) => { requests.push({ action: "check", ...input }); setSource({ ...source(), outdated: true }); return { data: [] } },
  update: async (input: any) => { requests.push({ action: "update", ...input }); await new Promise<void>((yes, no) => { resolve = yes; reject = () => no(new Error("synthetic failure")) }) },
} }
;(sdkManager as any).clients.set("plugins:/workspaces/plugins/instance", client)
await applyUiSettings({})
render(() => <ConfigProvider><I18nProvider><ThemeProvider><main>
  <PluginPackageAction instanceId="plugins" location={{ directory: "/a" }} source={source()} active={active()} />
  <PluginPackageAction instanceId="plugins" location={{ directory: "/b" }} source={source()} active={active()} />
  <PluginPackageAction instanceId="plugins" location={{ directory: "/a" }} source={{ type: "local", path: "/plugin" }} />
</main></ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
;(window as any).fixture = { requests, setActive, resolve: () => resolve(), reject: () => reject(), invalidations: () => invalidations }
