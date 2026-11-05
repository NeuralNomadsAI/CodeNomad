import type { ServiceConnection } from "../workspaces/opencode-service"
import type { ProviderReadContext } from "./types"

/** Read settings only through the daemon, in the route's already authorized Location. */
export async function readUsageProviderSettings(connection: ServiceConnection, providerID: string, directory: string, signal: AbortSignal) {
  const unavailable = { context: { signal, settingsStatus: "unavailable" } as ProviderReadContext, provider: undefined }
  try {
    signal.throwIfAborted()
    connection.assertCurrent()
    const info = await connection.client.provider.get({ providerID, location: { directory } }, { signal })
    signal.throwIfAborted()
    connection.assertCurrent()
    if (info.location.directory !== directory || "workspaceID" in info.location || info.data.id !== providerID) return unavailable
    const settings: NonNullable<ProviderReadContext["settings"]> = {}
    let unresolved = false
    for (const key of ["baseURL", "apiKey"] as const) {
      const value: unknown = info.data.settings?.[key]
      if (typeof value !== "string") continue
      if (/\{(?:env|file):/i.test(value)) unresolved = true
      else if (value.trim()) settings[key] = value.trim()
    }
    return { provider: info.data, context: { signal, settings, integrationID: info.data.integrationID ?? info.data.id,
      settingsStatus: unresolved ? "unresolved" : "available" } as ProviderReadContext }
  } catch {
    signal.throwIfAborted()
    return unavailable
  }
}
