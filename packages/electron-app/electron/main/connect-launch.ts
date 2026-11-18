import type { ConnectionSettlement, LocalWindowRecord, LocalWindowRegistry } from "./local-window-registry"

/** A hidden launch window that has not settled by then starts normally, where the connection runs visibly. */
export const CONNECT_LAUNCH_TIMEOUT_MS = 60_000

export interface ConnectLaunchHost {
  registry: Pick<LocalWindowRegistry, "acknowledgeConnection" | "abandonConnections" | "queueConnection" | "promote" | "get">
  /** Opens the windows a normal start shows and returns the one that takes over the connections. */
  restoreNormalStart(): Promise<{ id: string }>
  close(record: LocalWindowRecord): void
  show(record: LocalWindowRecord): void
}

export async function acknowledgeLaunchConnection(
  host: ConnectLaunchHost, windowId: string, target: string, failure: string | null, handOff: boolean,
): Promise<void> {
  const settlement = host.registry.acknowledgeConnection(windowId, target, { failure: failure ?? undefined, handOff })
  await applySettlement(host, windowId, settlement)
}

/** Hands a hidden launch window's connections to a normal start (backend failure or timeout). */
export async function abandonLaunchWindow(host: ConnectLaunchHost, windowId: string): Promise<void> {
  const connections = host.registry.abandonConnections(windowId)
  if (connections.length) await applySettlement(host, windowId, { kind: "start-normally", connections })
}

async function applySettlement(host: ConnectLaunchHost, windowId: string, settlement: ConnectionSettlement): Promise<void> {
  const record = host.registry.get(windowId)
  if (!record || settlement.kind === "keep") return
  if (settlement.kind === "close") {
    host.close(record)
    return
  }
  let fallback: { id: string }
  try {
    fallback = await host.restoreNormalStart()
  } catch (error) {
    // Without a normal start the hidden window itself becomes visible and runs or reports the connections.
    console.error("[electron-startup] normal start after a launch connection failed", error)
    host.registry.promote(windowId)
    for (const connection of settlement.connections) host.registry.queueConnection(windowId, connection)
    host.show(record)
    return
  }
  for (const connection of settlement.connections) host.registry.queueConnection(fallback.id, connection)
  host.close(record)
}
