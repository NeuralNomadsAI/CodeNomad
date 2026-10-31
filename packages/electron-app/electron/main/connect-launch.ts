import type { LocalWindowRecord, PendingConnection } from "./local-window-registry"

export interface ConnectLaunchHost {
  acknowledgeConnection(windowId: string, target: string): { record: LocalWindowRecord; connection: PendingConnection }
  queueConnection(windowId: string, connection: PendingConnection): void
  /** Opens the windows a normal start shows and returns the one that reports the failure. */
  restoreNormalStart(): Promise<{ id: string }>
  close(record: LocalWindowRecord): void
}

/**
 * Settles one `--connect-server` request. A window opened only for the connection closes once it
 * has nothing left to connect; when a connection fails there, CodeNomad starts normally instead and
 * the restored window shows the failure, together with any connection still queued.
 */
export async function acknowledgeLaunchConnection(host: ConnectLaunchHost, windowId: string, target: string, failure: string | null): Promise<void> {
  const { record, connection } = host.acknowledgeConnection(windowId, target)
  if (!record.connectOnly || connection.failure !== undefined) return
  if (failure === null) {
    if (!record.pendingConnections?.length) host.close(record)
    return
  }
  const remaining = record.pendingConnections?.splice(0) ?? []
  const fallback = await host.restoreNormalStart()
  host.queueConnection(fallback.id, { target, failure })
  for (const pending of remaining) host.queueConnection(fallback.id, pending)
  host.close(record)
}
