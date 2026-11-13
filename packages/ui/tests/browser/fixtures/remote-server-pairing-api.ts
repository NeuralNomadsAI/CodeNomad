import { serverApi } from "../../../src/lib/api-client"

// Imported before the preferences store, which starts loading as soon as it is evaluated.
// ?scenario=saved: the tunnel server is already saved, as when pairing it again.
export const TUNNEL = "https://codenomad-fixture.device.opentunnel.test"
const fixture = window as unknown as { probes: string[]; uiState: () => string }
const scenario = new URLSearchParams(location.search).get("scenario")
fixture.probes = []
let uiBucket: Record<string, unknown> = new URLSearchParams(location.search).get("scenario") === "saved"
  ? { remoteServers: [{ id: "saved-tunnel", name: "Desk", baseUrl: TUNNEL, skipTlsVerify: false, createdAt: "2026-10-12T10:00:00.000Z", updatedAt: "2026-10-12T10:00:00.000Z" }] }
  : {}
fixture.uiState = () => JSON.stringify(uiBucket)
if (scenario === "ssh-launch") {
  uiBucket = { remoteServers: [{ id: "ssh", name: "Desk", baseUrl: "http://127.0.0.1:9899", ssh: { host: "lab" }, skipTlsVerify: false, createdAt: "", updatedAt: "" }] }
  let pending = true
  const acknowledgements: unknown[] = []
  Object.assign(window, { acknowledgements })
  Object.assign(window.electronAPI!, {
    nextPendingConnection: async () => { if (!pending) return null; pending = false; return { target: "Desk", hidden: true } },
    acknowledgePendingConnection: async (...args: unknown[]) => { acknowledgements.push(args) },
    onPendingConnections: () => () => {},
  })
}

serverApi.fetchConfigOwner = (async () => ({ settings: { multiBackend: new URLSearchParams(location.search).get("scenario") === "ssh" } })) as typeof serverApi.fetchConfigOwner
serverApi.listSshHosts = async () => ({ hosts: ["lab", "other"] })
serverApi.fetchStateOwner = (async (owner: string) => (owner === "ui" ? uiBucket : {})) as typeof serverApi.fetchStateOwner
serverApi.patchStateOwner = (async (owner: string, patch: unknown) => {
  if (owner !== "ui") return {}
  uiBucket = { ...uiBucket, ...(patch as Record<string, unknown>) }
  return uiBucket
}) as typeof serverApi.patchStateOwner
serverApi.probeRemoteServer = async ({ baseUrl, skipTlsVerify }) => {
  fixture.probes.push(`${baseUrl} skipTls=${Boolean(skipTlsVerify)}`)
  return { ok: true, reachable: true, normalizedUrl: baseUrl.replace(/\/$/, ""), skipTlsVerify: Boolean(skipTlsVerify), requiresAuth: true, authenticated: false }
}
