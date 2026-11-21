import "./remote-server-pairing-api"
import { render } from "solid-js/web"
import { serverApi } from "../../../src/lib/api-client"
import { ConfigProvider, useConfig } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import FolderSelectionView from "../../../src/components/folder-selection-view"
import { SavedRemoteServersCard } from "../../../src/components/settings/saved-remote-servers-card"
import { RemoteAccessSettingsSection } from "../../../src/components/settings/remote-access-settings-section"
import { RemoteControlSettingsSection } from "../../../src/components/settings/remote-control-settings-section"
import { SideCarsSettingsSection } from "../../../src/components/settings/sidecars-settings-section"
import { getServerMeta } from "../../../src/lib/server-meta"
import "../../../src/index.css"

const query = new URLSearchParams(location.search)
const configWrites: Array<{ owner: string; patch: unknown }> = []
Object.assign(window, { configWrites })
serverApi.patchConfigOwner = (async (owner: string, patch: unknown) => {
  configWrites.push({ owner, patch })
  return patch
}) as typeof serverApi.patchConfigOwner
serverApi.fetchServerMeta = (async () => {
  const mode = query.get("mode")
  if (mode === "failure") throw new Error("Unavailable")
  const meta = { localUrl: "http://localhost:3000", listeningMode: "all", addresses: [],
    ...(query.has("locked") ? { listeningLocked: true, host: "10.20.0.7" } : {}) }
  if (mode === "servers" || mode === "servers-readonly" || mode === "servers-refused") return {
    ...meta, localRequest: false, serversUsable: mode !== "servers-refused", serversManageable: mode === "servers",
  }
  // "sidecars": a non-local client the host lets open SideCars over direct HTTPS.
  return mode === "missing" ? meta : { ...meta, localRequest: mode === "local", ...(mode === "sidecars" ? { sidecarsAllowed: true } : {}) }
}) as typeof serverApi.fetchServerMeta
serverApi.fetchAuthStatus = async () => ({ authenticated: true, username: "codenomad", passwordUserProvided: true })
serverApi.fetchRemoteControlStatus = async () => ({ manageable: query.get("mode") === "local", enabled: false,
  startsOnLaunch: true, previews: true, state: "stopped", pairedDevices: 0, disabledByAdministrator: true,
  directOrigins: ["https://code.example.test"] })
serverApi.fetchRemoteControlDevices = async () => ({ devices: [] })
serverApi.fetchSidecars = async () => ({ sidecars: [{ id: "fixture", name: "Fixture SideCar", kind: "port", port: 3000,
  insecure: true, prefixMode: "strip", status: "running" }] }) as Awaited<ReturnType<typeof serverApi.fetchSidecars>>

function Harness() {
  Object.assign(window, { hostControlsConfig: useConfig() })
  const surface = query.get("surface")
  void getServerMeta().catch(() => {}).finally(() => { document.documentElement.dataset.metaSettled = "true" })
  if (surface === "settings") return <><SavedRemoteServersCard />{query.has("locked") && <RemoteControlSettingsSection />}<RemoteAccessSettingsSection /><SideCarsSettingsSection /></>
  return <FolderSelectionView onSelectFolder={() => {}} onSelectExistingInstance={() => {}} onOpenSidecar={() => {}} />
}

render(() => <ConfigProvider><I18nProvider><ThemeProvider><Harness /></ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
