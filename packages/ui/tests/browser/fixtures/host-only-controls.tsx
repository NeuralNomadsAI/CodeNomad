import "./remote-server-pairing-api"
import { render } from "solid-js/web"
import { serverApi } from "../../../src/lib/api-client"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import FolderSelectionView from "../../../src/components/folder-selection-view"
import { SavedRemoteServersCard } from "../../../src/components/settings/saved-remote-servers-card"
import { RemoteAccessSettingsSection } from "../../../src/components/settings/remote-access-settings-section"
import { SideCarsSettingsSection } from "../../../src/components/settings/sidecars-settings-section"
import { SideCarPickerDialog } from "../../../src/components/sidecar-picker-dialog"
import { getServerMeta } from "../../../src/lib/server-meta"
import "../../../src/index.css"

const query = new URLSearchParams(location.search)
serverApi.fetchServerMeta = (async () => {
  const mode = query.get("mode")
  if (mode === "failure") throw new Error("Unavailable")
  const meta = { localUrl: "http://localhost:3000", listeningMode: "all", addresses: [] }
  return mode === "missing" ? meta : { ...meta, localRequest: mode === "local" }
}) as typeof serverApi.fetchServerMeta
serverApi.fetchAuthStatus = async () => ({ authenticated: true, username: "codenomad", passwordUserProvided: true })
serverApi.fetchSidecars = async () => ({ sidecars: [{ id: "fixture", name: "Fixture SideCar", kind: "port", port: 3000,
  insecure: true, prefixMode: "strip", status: "running" }] }) as Awaited<ReturnType<typeof serverApi.fetchSidecars>>

function Harness() {
  const surface = query.get("surface")
  void getServerMeta().catch(() => {}).finally(() => { document.documentElement.dataset.metaSettled = "true" })
  if (surface === "picker") return <SideCarPickerDialog open onClose={() => {}} onOpenSidecar={() => {}} />
  if (surface === "settings") return <><SavedRemoteServersCard /><RemoteAccessSettingsSection /><SideCarsSettingsSection /></>
  return <FolderSelectionView onSelectFolder={() => {}} onSelectExistingInstance={() => {}} onOpenSidecar={() => {}} />
}

render(() => <ConfigProvider><I18nProvider><ThemeProvider><Harness /></ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
