import { create, OpenTunnelStorage } from "@opentunnel/client"

export type RemoteTunnelState = "connecting" | "connected" | "reconnecting" | "stopped"

export interface RemoteTunnelStatus {
  state: RemoteTunnelState
  connections: number
  lastError?: string
}

export interface RemoteTunnel {
  /** Public HTTPS origin of this route. */
  readonly url: string
  readonly hostname: string
  status(): RemoteTunnelStatus
  /** Settles when the tunnel stops; resolves with the fatal error message, if any. */
  readonly closed: Promise<string | undefined>
  close(): Promise<void>
}

export interface OpenRemoteTunnelOptions {
  /** Subdomain label claimed on the device's shared tunnel. */
  route: string
  /** Plain TCP `host:port` receiving decrypted connections. */
  target: string
  /** OpenTunnel profile; the device-wide `default` profile when omitted. */
  profile?: string
  /** Relay API origin; the hosted relay when omitted. */
  api?: string
  /** Overrides `XDG_DATA_HOME` for the identity store (tests). */
  dataHome?: string
  signal?: AbortSignal
}

/**
 * Claims one route on the device's shared OpenTunnel identity, creating the
 * identity on first use. TLS terminates in this process; the relay only
 * forwards ciphertext. Closing releases this route without deleting the shared
 * identity, which other applications (such as OpenCode) may also use.
 */
export async function openRemoteTunnel(options: OpenRemoteTunnelOptions): Promise<RemoteTunnel> {
  const store = OpenTunnelStorage.xdg(options.dataHome ? { env: { ...process.env, XDG_DATA_HOME: options.dataHome } } : {})
  const client = create({ store, ...(options.api ? { api: options.api } : {}) })
  let connection: Awaited<ReturnType<typeof client.tunnel.connect>>
  try {
    connection = await client.tunnel.connect({
      ...(options.profile ? { profile: options.profile } : {}),
      routes: { [options.route]: options.target },
      ...(options.signal ? { signal: options.signal } : {}),
    })
  } catch (error) {
    await client.dispose().catch(() => undefined)
    throw error
  }

  // The SDK queues events without bound until they are consumed.
  void (async () => {
    try {
      for await (const _event of connection.events) {
        // Status is read on demand through connection.status().
      }
    } catch {
      // The connection's closed promise reports failures.
    }
  })()

  const hostname = `${options.route}.${connection.tunnel.hostname}`
  let closing: Promise<void> | undefined
  return {
    url: `https://${hostname}`,
    hostname,
    status: () => {
      const status = connection.status()
      return {
        state: status.state === "waiting-routes" ? "connecting" : status.state,
        connections: status.connections,
        ...(status.lastError ? { lastError: status.lastError } : {}),
      }
    },
    closed: connection.closed.then(
      () => undefined,
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    ),
    close: () => {
      closing ??= connection.close().finally(() => client.dispose())
      return closing
    },
  }
}
