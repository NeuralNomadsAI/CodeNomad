import type { PermissionReceipt } from "../../../server/src/api-types"
import { serverApi } from "../lib/api-client"
import { serverEvents } from "../lib/server-events"

export type PermissionReceiptScope = { messageId: string } | { unanchored: true }
export interface PermissionReceiptSnapshot { receipts: PermissionReceipt[]; next?: string; pages: number }
type Read = { pages: number; stale: boolean; promise: Promise<PermissionReceiptSnapshot> }

// Virtualized transcript rows mount and unmount continuously. Keep each row's
// last snapshot and share identical in-flight reads, so remounting never
// re-requests (or cancels) its receipts. Server changes and reconnects invalidate.
const MAX_SNAPSHOTS = 2_000
const snapshots = new Map<string, PermissionReceiptSnapshot>()
const reads = new Map<string, Read>()

// Changes apply to rows that are not mounted, and events missed while
// disconnected can change any row.
serverEvents.on("permission.receiptsChanged", event => {
  if (event.type !== "permission.receiptsChanged") return
  const session = `${event.instanceId}\0${event.sessionId}\0`
  const changed = event.messageId ? `${session}${event.messageId}` : undefined
  for (const key of [...snapshots.keys(), ...reads.keys()]) {
    if (key.startsWith(session) && (!changed || key === changed)) invalidatePermissionReceipts(key)
  }
})
serverEvents.onOpen(() => {
  for (const key of [...snapshots.keys(), ...reads.keys()]) invalidatePermissionReceipts(key)
})

export function permissionReceiptKey(instanceId: string, sessionId: string, scope: PermissionReceiptScope): string {
  return [instanceId, sessionId, "messageId" in scope ? scope.messageId : ""].join("\0")
}

export function cachedPermissionReceipts(key: string): PermissionReceiptSnapshot | undefined {
  return snapshots.get(key)
}

export function rememberPermissionReceipts(key: string, snapshot: PermissionReceiptSnapshot): void {
  snapshots.delete(key)
  snapshots.set(key, snapshot)
  if (snapshots.size > MAX_SNAPSHOTS) snapshots.delete(snapshots.keys().next().value!)
}

export function invalidatePermissionReceipts(key: string): void {
  snapshots.delete(key)
  const read = reads.get(key)
  if (read) read.stale = true
  reads.delete(key)
}

export function ownsPermissionReceipt(receipt: PermissionReceipt, sessionId: string, scope: PermissionReceiptScope): boolean {
  return receipt.sessionId === sessionId && ("messageId" in scope ? receipt.source?.messageId === scope.messageId : !receipt.source)
}

export function readPermissionReceipts(instanceId: string, sessionId: string, scope: PermissionReceiptScope, pages: number): Promise<PermissionReceiptSnapshot> {
  const key = permissionReceiptKey(instanceId, sessionId, scope)
  const existing = reads.get(key)
  if (existing && existing.pages >= pages) return existing.promise
  const read: Read = { pages, stale: false, promise: undefined! }
  read.promise = (async () => {
    const receipts: PermissionReceipt[] = []
    let cursor: string | undefined
    let fetched = 0
    do {
      const page = await serverApi.fetchPermissionReceipts(instanceId, sessionId, scope, cursor)
      receipts.push(...page.receipts.filter(receipt => ownsPermissionReceipt(receipt, sessionId, scope)))
      cursor = page.next
      fetched++
    } while (cursor && fetched < pages)
    const snapshot = { receipts, next: cursor, pages: fetched }
    if (!read.stale) rememberPermissionReceipts(key, snapshot)
    return snapshot
  })()
  reads.set(key, read)
  void read.promise.catch(() => {}).finally(() => { if (reads.get(key) === read) reads.delete(key) })
  return read.promise
}
