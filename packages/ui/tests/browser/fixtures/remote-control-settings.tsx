import { render } from "solid-js/web"
import type { RemoteControlDevice, RemoteControlStatus } from "../../../../server/src/api-types"
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
// ?scenario=disabled: the administrator disabled Remote Control; a device paired before stays revocable.
const scenario = new URLSearchParams(location.search).get("scenario")
const base: RemoteControlStatus = { manageable: true, enabled: false, startsOnLaunch: false, previews: true, state: "stopped", pairedDevices: 1 }
const connected: RemoteControlStatus = { ...base, enabled: true, startsOnLaunch: true, state: "connected", remoteUrl: "https://codenomad-fixture.tunnel.test" }
let status: RemoteControlStatus = scenario === "failed-resume" ? { ...base, startsOnLaunch: true, state: "error", error: "relay unavailable" }
  : scenario === "skipped" ? { ...base, startsOnLaunch: true }
  : scenario === "connected" ? connected
  : scenario === "remote" ? { ...connected, manageable: false }
  // ?scenario=direct: the tunnel is off; two verified direct HTTPS origins can pair.
  : scenario === "direct" ? { ...base, directOrigins: ["https://code.example.test", "https://ui.example.test:8443"] }
  : scenario === "disabled" ? { ...base, disabledByAdministrator: true, directOrigins: ["https://code.example.test"] }
  : { ...connected, state: "connecting" }
let reads = 0
const fixture = window as unknown as { statusReads: () => number; stops: number; previewChanges: boolean[]; pairingOrigins: Array<string | undefined>; setRemoteState: (state: "reconnecting" | "connected" | "stopped" | "disabled") => void }
fixture.statusReads = () => reads
fixture.stops = 0
fixture.previewChanges = []
fixture.pairingOrigins = []
fixture.setRemoteState = (state) => {
  status = state === "disabled" ? { ...base, disabledByAdministrator: true, directOrigins: ["https://code.example.test"] }
    : state === "stopped" ? { ...base, startsOnLaunch: true, state: "error", error: "tunnel stopped" } : { ...connected, state }
}

serverApi.fetchRemoteControlStatus = async () => {
  reads += 1
  if (scenario === "resuming" && reads >= 3) status = connected
  return status
}
let devices: RemoteControlDevice[] = [
  { id: "8e5f0a8e-4a8c-4f43-9a4c-6d1f6b0d7c11", name: "Android · Firefox", createdAt: "2026-10-12T12:39:58.214Z", lastSeenAt: "2026-10-12T12:43:14.286Z" },
  ...(scenario === "direct" ? [{ id: "1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d", name: "iPhone · Safari", createdAt: "2026-10-12T12:39:58.214Z", lastSeenAt: "2026-10-12T12:43:14.286Z", origin: "https://code.example.test" }] : []),
]
serverApi.fetchRemoteControlDevices = async () => ({ devices })
serverApi.revokeRemoteControlDevice = async (id) => {
  const device = devices.find(device => device.id === id)!
  if (!device.revocationPending) {
    devices = devices.map(entry => entry.id === id ? { ...entry, revocationPending: true } : entry)
    status = { ...status, pairedDevices: devices.filter(entry => !entry.revocationPending).length }
    throw new Error("Registry could not be saved")
  }
  devices = devices.filter(entry => entry.id !== id)
}
serverApi.createRemoteControlPairing = async (origin) => {
  fixture.pairingOrigins.push(origin)
  return {
    url: `${origin ?? "https://codenomad-fixture.tunnel.test"}/remote-pair#fixture-code`,
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  }
}
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
