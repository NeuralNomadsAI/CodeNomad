import { render } from "solid-js/web"
import type { RemoteControlStatus } from "../../../../server/src/api-types"
import { RemoteControlSettingsSection } from "../../../src/components/settings/remote-control-settings-section"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { serverApi } from "../../../src/lib/api-client"
import "../../../src/index.css"

// ?scenario=failed-resume: left on before a restart, the relay then failed.
// ?scenario=skipped: left on, but another backend with this configuration owns it.
// ?scenario=resuming: reconnecting at launch, connected after a few status reads.
// ?scenario=connected: running; tests move it with window.setRemoteState().
// ?scenario=remote: the same, read by a paired device.
const scenario = new URLSearchParams(location.search).get("scenario")
const base: RemoteControlStatus = { manageable: true, enabled: false, startsOnLaunch: false, previews: true, state: "stopped", pairedDevices: 1 }
const connected: RemoteControlStatus = { ...base, enabled: true, startsOnLaunch: true, state: "connected", remoteUrl: "https://codenomad-fixture.tunnel.test" }
let status: RemoteControlStatus = scenario === "failed-resume" ? { ...base, startsOnLaunch: true, state: "error", error: "relay unavailable" }
  : scenario === "skipped" ? { ...base, startsOnLaunch: true }
  : scenario === "connected" ? connected
  : scenario === "remote" ? { ...connected, manageable: false }
  : { ...connected, state: "connecting" }
let reads = 0
const fixture = window as unknown as { statusReads: () => number; stops: number; previewChanges: boolean[]; setRemoteState: (state: "reconnecting" | "connected" | "stopped") => void }
fixture.statusReads = () => reads
fixture.stops = 0
fixture.previewChanges = []
fixture.setRemoteState = (state) => {
  status = state === "stopped" ? { ...base, startsOnLaunch: true, state: "error", error: "tunnel stopped" } : { ...connected, state }
}

serverApi.fetchRemoteControlStatus = async () => {
  reads += 1
  if (scenario === "resuming" && reads >= 3) status = connected
  return status
}
serverApi.fetchRemoteControlDevices = async () => ({
  devices: [{ id: "8e5f0a8e-4a8c-4f43-9a4c-6d1f6b0d7c11", name: "Android · Firefox", createdAt: "2026-10-12T12:39:58.214Z", lastSeenAt: "2026-10-12T12:43:14.286Z" }],
})
serverApi.createRemoteControlPairing = async () => ({
  url: "https://codenomad-fixture.tunnel.test/remote-pair#fixture-code",
  expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
})
serverApi.setRemoteControlPreviews = async (enabled) => {
  fixture.previewChanges.push(enabled)
  status = { ...status, previews: enabled }
  return status
}
serverApi.stopRemoteControl = async () => {
  fixture.stops += 1
  status = { ...base }
  return status
}

render(() => <ConfigProvider><I18nProvider><ThemeProvider>
  <main style={{ width: "min(900px, 100%)" }}><RemoteControlSettingsSection /></main>
</ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
