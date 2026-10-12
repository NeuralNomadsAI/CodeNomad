import { serverApi } from "../../../src/lib/api-client"

// Imported before the preferences store, which starts loading as soon as it is evaluated.
// ?scenario=saved: the tunnel server is already saved, as when pairing it again.
export const TUNNEL = "https://codenomad-fixture.device.opentunnel.test"
const fixture = window as unknown as { probes: string[]; uiState: () => string }
fixture.probes = []
let uiBucket: Record<string, unknown> = new URLSearchParams(location.search).get("scenario") === "saved"
  ? { remoteServers: [{ id: "saved-tunnel", name: "Desk", baseUrl: TUNNEL, skipTlsVerify: false, createdAt: "2026-10-12T10:00:00.000Z", updatedAt: "2026-10-12T10:00:00.000Z" }] }
  : {}
fixture.uiState = () => JSON.stringify(uiBucket)

serverApi.fetchConfigOwner = (async () => ({})) as typeof serverApi.fetchConfigOwner
serverApi.fetchStateOwner = (async (owner: string) => (owner === "ui" ? uiBucket : {})) as typeof serverApi.fetchStateOwner
serverApi.patchStateOwner = (async (owner: string, patch: unknown) => {
  if (owner !== "ui") return {}
  uiBucket = { ...uiBucket, ...(patch as Record<string, unknown>) }
  return uiBucket
}) as typeof serverApi.patchStateOwner
serverApi.probeRemoteServer = async ({ baseUrl, skipTlsVerify }) => {
  fixture.probes.push(baseUrl)
  return { ok: true, reachable: true, normalizedUrl: baseUrl.replace(/\/$/, ""), skipTlsVerify: Boolean(skipTlsVerify), requiresAuth: true, authenticated: false }
}
