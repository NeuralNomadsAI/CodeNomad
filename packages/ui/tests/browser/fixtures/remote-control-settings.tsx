import { render } from "solid-js/web"
import type { RemoteControlStatus } from "../../../../server/src/api-types"
import { RemoteControlSettingsSection } from "../../../src/components/settings/remote-control-settings-section"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { serverApi } from "../../../src/lib/api-client"
import "../../../src/index.css"

// ?scenario=failed-resume: left on before a restart, the relay then failed.
// ?scenario=resuming: reconnecting at launch, connected after a few status reads.
const scenario = new URLSearchParams(location.search).get("scenario")
const base: RemoteControlStatus = { manageable: true, enabled: false, startsOnLaunch: false, state: "stopped", pairedDevices: 1 }
let status: RemoteControlStatus = scenario === "failed-resume"
  ? { ...base, startsOnLaunch: true, state: "error", error: "relay unavailable" }
  : { ...base, enabled: true, startsOnLaunch: true, state: "connecting" }
let reads = 0
const fixture = window as unknown as { statusReads: () => number; stops: number }
fixture.statusReads = () => reads
fixture.stops = 0

serverApi.fetchRemoteControlStatus = async () => {
  reads += 1
  if (scenario === "resuming" && reads >= 3) status = { ...status, state: "connected", remoteUrl: "https://codenomad-fixture.tunnel.test" }
  return status
}
serverApi.fetchRemoteControlDevices = async () => ({
  devices: [{ id: "8e5f0a8e-4a8c-4f43-9a4c-6d1f6b0d7c11", name: "Android · Firefox", createdAt: "2026-10-12T12:39:58.214Z", lastSeenAt: "2026-10-12T12:43:14.286Z" }],
})
serverApi.stopRemoteControl = async () => {
  fixture.stops += 1
  status = { ...base }
  return status
}

render(() => <ConfigProvider><I18nProvider><ThemeProvider>
  <main style={{ width: "min(900px, 100%)" }}><RemoteControlSettingsSection /></main>
</ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
