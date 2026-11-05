import type { ClientWindowStateRecord } from "./client-state-envelope"
import { isPartitionKey, validateClientStatePartitionRoot } from "./client-state-partitions"

export interface RetainedProjectMetadata { index: number; serverId: string; directory: string; occurrence?: number }
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value)
const onlyKeys = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key))

/** Only the tab manifest is inspected. Never follow workspace/session/blob partitions. */
export async function retainedProjectMetadata(record: ClientWindowStateRecord, load: (key: string) => Promise<string | null>): Promise<RetainedProjectMetadata[] | undefined> {
  if (!record.restoreEnabled) return []
  if (!object(record.snapshot)) return
  const root = record.snapshot
  let session: unknown
  const partitioned = record.partitionProtocolVersion === 1
  if (partitioned) {
    const keys = validateClientStatePartitionRoot(root)
    if (!keys || typeof root.sessionPartition !== "string" || !record.partitionKeys?.includes(root.sessionPartition)) return
    const text = await load(root.sessionPartition)
    if (text === null) return
    let manifest: unknown
    try { manifest = JSON.parse(text) } catch { return }
    if (!object(manifest) || manifest.format !== 2 || !onlyKeys(manifest, ["format", "session"])) return
    session = manifest.session
  } else {
    if (root.version !== undefined && root.version !== 1) return
    session = root.session
  }
  if (session === null) return []
  if (!object(session) || !Array.isArray(session.tabs) || session.tabs.length > 32
    || !onlyKeys(session, ["tabs", "activeTabIndex", "homeActive"]) || !Number.isInteger(session.activeTabIndex)
    || Number(session.activeTabIndex) < -1 || Number(session.activeTabIndex) >= session.tabs.length
    || session.homeActive !== undefined && typeof session.homeActive !== "boolean") return
  const result: RetainedProjectMetadata[] = []
  for (const [index, tab] of session.tabs.entries()) {
    if (!object(tab)) return
    const kind = tab.kind ?? tab.type
    if (kind === "sidecar") { if (typeof tab.sidecarId !== "string" || !tab.sidecarId || tab.sidecarId.length > 512) return; continue }
    if (kind !== "workspace" && (partitioned || kind !== "instance")) return
    if (typeof tab.folder !== "string" || !tab.folder.trim() || tab.folder.length > 4096 || tab.folder.includes("\0")) return
    if (tab.serverId !== undefined && (typeof tab.serverId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(tab.serverId))) return
    if (tab.occurrence !== undefined && (!Number.isInteger(tab.occurrence) || Number(tab.occurrence) < 0 || Number(tab.occurrence) >= 32)) return
    if (partitioned && (!isPartitionKey(tab.workspacePartition) || !record.partitionKeys?.includes(tab.workspacePartition))) return
    result.push({ index, serverId: (tab.serverId as string | undefined) ?? "local-shared", directory: tab.folder,
      ...(tab.occurrence === undefined ? {} : { occurrence: Number(tab.occurrence) }) })
  }
  return result
}
