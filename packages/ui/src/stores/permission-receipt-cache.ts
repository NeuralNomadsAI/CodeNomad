import type { PermissionReceipt } from "../../../server/src/api-types"
import { serverApi } from "../lib/api-client"
import { receiptReads } from "../lib/background-read-queue"
import { serverEvents } from "../lib/server-events"

export type PermissionReceiptScope = { messageId: string } | { unanchored: true }
export interface PermissionReceiptSnapshot { receipts: PermissionReceipt[]; next?: string; pages: number }
type Read = {
  pages: number
  stale: boolean
  subscribers: number
  controller: AbortController
  promise: Promise<PermissionReceiptSnapshot>
}

// Virtualized transcript rows mount and unmount continuously. Keep each row's
// completed snapshot and share in-flight reads among mounted rows. A read no
// mounted row waits for is cancelled, so scrolled-away rows never hold the
// single receipt lane. Server changes and reconnects invalidate.
const MAX_SNAPSHOTS = 2_000
const snapshots = new Map<string, PermissionReceiptSnapshot>()
const reads = new Map<string, Read>()
let invalidations = 0

// Changes apply to rows that are not mounted, and events missed while
// disconnected can change any row. The server omits messageId only for a
// receipt without a source message, which belongs to the unanchored row.
serverEvents.on("permission.receiptsChanged", event => {
  if (event.type !== "permission.receiptsChanged") return
  invalidatePermissionReceipts(permissionReceiptKey(event.instanceId, event.sessionId,
    event.messageId ? { messageId: event.messageId } : { unanchored: true }))
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

/** Changes whenever any snapshot is invalidated; callers fence late writes with it. */
export function permissionReceiptGeneration(): number {
  return invalidations
}

export function invalidatePermissionReceipts(key: string): void {
  invalidations++
  snapshots.delete(key)
  const read = reads.get(key)
  if (read) read.stale = true
  reads.delete(key)
}

export function ownsPermissionReceipt(receipt: PermissionReceipt, sessionId: string, scope: PermissionReceiptScope): boolean {
  return receipt.sessionId === sessionId && ("messageId" in scope ? receipt.source?.messageId === scope.messageId : !receipt.source)
}

/** Joins (or starts) the shared read for a row; call release when the row stops waiting. */
export function acquirePermissionReceipts(instanceId: string, sessionId: string, scope: PermissionReceiptScope, pages: number) {
  const key = permissionReceiptKey(instanceId, sessionId, scope)
  let read = reads.get(key)
  if (!read || read.pages < pages) read = startRead(key, instanceId, sessionId, scope, pages)
  const joined = read
  joined.subscribers++
  let released = false
  return {
    promise: joined.promise,
    release: () => {
      if (released) return
      released = true
      if (--joined.subscribers > 0) return
      joined.controller.abort()
      if (reads.get(key) === joined) reads.delete(key)
    },
  }
}

function startRead(key: string, instanceId: string, sessionId: string, scope: PermissionReceiptScope, pages: number): Read {
  const read: Read = { pages, stale: false, subscribers: 0, controller: new AbortController(), promise: undefined! }
  const { signal } = read.controller
  read.promise = (async () => {
    const receipts: PermissionReceipt[] = []
    let cursor: string | undefined
    let fetched = 0
    do {
      const page = await receiptReads.run(signal, () => serverApi.fetchPermissionReceipts(instanceId, sessionId, scope, cursor, signal))
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
  return read
}
