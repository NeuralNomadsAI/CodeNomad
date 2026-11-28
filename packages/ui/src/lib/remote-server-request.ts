import type { BackendHttp } from "./backend-transport"
import type { RemoteServerBrowseResponse } from "../../../server/src/api-types"
import { secretEntryAllowed } from "./host-server-meta"

const codes = ["unknown_server", "needs_credentials", "auth", "pairing_unavailable", "pairing_expired", "pairing_rate_limited", "tls_error", "secret_entry_forbidden", "unreachable", "path_unavailable", "refused"] as const
export type RemoteServerErrorCode = typeof codes[number]
export class RemoteServerRequestError extends Error {
  constructor(readonly code: RemoteServerErrorCode) { super(code); this.name = "RemoteServerRequestError" }
}
export class RemoteServerInUseError extends Error {
  constructor(message: string) { super(message); this.name = "RemoteServerInUseError" }
}
export type RemoteServerConnectInput = { username?: string; password?: string; pairingLink?: string }

export function assertRemoteServerCredentials(input: RemoteServerConnectInput) {
  if ((input.password !== undefined || input.pairingLink !== undefined) && !secretEntryAllowed()) {
    throw new RemoteServerRequestError("secret_entry_forbidden")
  }
}

type RemoteServerBrowseInput = { path?: string }

/** Host-only browsing and credential operations; failures expose only stable codes. */
export function remoteServerRequest(ctx: BackendHttp, id: string, action: "browse", body: RemoteServerBrowseInput, signal?: AbortSignal): Promise<RemoteServerBrowseResponse>
export function remoteServerRequest(ctx: BackendHttp, id: string, action: "connect" | "forget", body: RemoteServerConnectInput, signal?: AbortSignal): Promise<{ ok: boolean }>
export async function remoteServerRequest(ctx: BackendHttp, id: string, action: "browse" | "connect" | "forget", body: RemoteServerConnectInput | RemoteServerBrowseInput, signal?: AbortSignal): Promise<RemoteServerBrowseResponse | { ok: boolean }> {
  signal?.throwIfAborted()
  if (ctx.id !== "local" || !id || id.length > 256) throw new RemoteServerRequestError("unknown_server")
  if (action === "connect") assertRemoteServerCredentials(body as RemoteServerConnectInput)
  try {
    const response = await ctx.fetch(ctx.url(`/api/remote-servers/${encodeURIComponent(id)}/${action}`), {
      method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal,
    })
    signal?.throwIfAborted()
    const value = await response.json().catch(() => undefined)
    signal?.throwIfAborted()
    if (!response.ok) {
      const code = response.status === 426 ? "refused" : codes.find(code => code === value?.error) ?? "unreachable"
      throw new RemoteServerRequestError(code)
    }
    if (action === "browse") {
      if (!value?.listing?.metadata || !Array.isArray(value.listing.entries) || !Array.isArray(value.recents)) throw new RemoteServerRequestError("unreachable")
      return value
    }
    if (value?.ok !== true) throw new RemoteServerRequestError("unreachable")
    return { ok: true }
  } catch (error) {
    signal?.throwIfAborted()
    throw error instanceof RemoteServerRequestError ? error : new RemoteServerRequestError("unreachable")
  }
}
