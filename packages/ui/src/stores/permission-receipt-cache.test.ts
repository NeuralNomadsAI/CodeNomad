import assert from "node:assert/strict"
import { test } from "node:test"
import { serverApi } from "../lib/api-client"
import { backgroundReads } from "../lib/background-read-queue"
import { serverEvents } from "../lib/server-events"
import {
  acquirePermissionReceipts, cachedPermissionReceipts, invalidatePermissionReceipts, permissionReceiptGeneration, permissionReceiptKey,
} from "./permission-receipt-cache"

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}
const abortable = (gate: Promise<void>, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  signal?.addEventListener("abort", () => reject(signal.reason), { once: true })
  void gate.then(resolve)
})

test("rows that unmount stop their reads and never delay other background work", async () => {
  const original = serverApi.fetchPermissionReceipts
  const sent: string[] = []
  const gate = deferred()
  serverApi.fetchPermissionReceipts = async (_instance, _session, scope, _cursor, signal) => {
    sent.push("messageId" in scope ? scope.messageId : "unanchored")
    await abortable(gate.promise, signal)
    return { receipts: [] }
  }
  try {
    const rows = Array.from({ length: 40 }, (_, index) => acquirePermissionReceipts("cache-instance", "ses-scroll", { messageId: `m${index}` }, 1))
    await tick()
    let unrelated = false
    void backgroundReads.run(new AbortController().signal, async () => { unrelated = true })
    await tick()
    assert.equal(unrelated, true, "receipt bursts use their own lane")
    // A fast scroll: every row but the last two unmounts, including the one in flight.
    for (const row of rows.slice(0, 38)) row.release()
    await tick()
    gate.resolve()
    await Promise.allSettled(rows.map((row) => row.promise))
    assert.deepEqual(sent, ["m0", "m38", "m39"], "unmounted rows are cancelled; only mounted rows keep the lane")
    for (const row of rows.slice(38)) row.release()
  } finally { serverApi.fetchPermissionReceipts = original }
})

test("a read is shared while any mounted row waits, cancelled when none does, and retained once complete", async () => {
  const original = serverApi.fetchPermissionReceipts
  let calls = 0
  let gate = deferred()
  serverApi.fetchPermissionReceipts = async (_instance, _session, _scope, _cursor, signal) => {
    calls++
    await abortable(gate.promise, signal)
    return { receipts: [] }
  }
  try {
    const scope = { messageId: "shared" }
    const key = permissionReceiptKey("cache-instance", "ses-remount", scope)
    const first = acquirePermissionReceipts("cache-instance", "ses-remount", scope, 1)
    await tick()
    const second = acquirePermissionReceipts("cache-instance", "ses-remount", scope, 1)
    assert.equal(second.promise, first.promise)
    first.release()
    second.release()
    await assert.rejects(first.promise)
    assert.equal(cachedPermissionReceipts(key), undefined)
    gate = deferred()
    const mounted = acquirePermissionReceipts("cache-instance", "ses-remount", scope, 1)
    gate.resolve()
    await mounted.promise
    mounted.release()
    assert.equal(calls, 2)
    assert.ok(cachedPermissionReceipts(key), "the completed snapshot is retained for later remounts")
  } finally { serverApi.fetchPermissionReceipts = original }
})

test("an unanchored change invalidates only the unanchored row", async () => {
  const original = serverApi.fetchPermissionReceipts
  serverApi.fetchPermissionReceipts = async () => ({ receipts: [] })
  try {
    for (const scope of [{ messageId: "anchored" }, { unanchored: true as const }]) {
      const row = acquirePermissionReceipts("cache-instance", "ses-events", scope, 1)
      await row.promise
      row.release()
    }
    ;(serverEvents as any).dispatchBatch([{ type: "permission.receiptsChanged", instanceId: "cache-instance", sessionId: "ses-events" }])
    assert.ok(cachedPermissionReceipts(permissionReceiptKey("cache-instance", "ses-events", { messageId: "anchored" })), "anchored rows keep their snapshot")
    assert.equal(cachedPermissionReceipts(permissionReceiptKey("cache-instance", "ses-events", { unanchored: true })), undefined)
    ;(serverEvents as any).dispatchBatch([{ type: "permission.receiptsChanged", instanceId: "cache-instance", sessionId: "ses-events", messageId: "anchored" }])
    assert.equal(cachedPermissionReceipts(permissionReceiptKey("cache-instance", "ses-events", { messageId: "anchored" })), undefined)
  } finally { serverApi.fetchPermissionReceipts = original }
})

test("invalidation advances the generation that fences late pagination writes", () => {
  const before = permissionReceiptGeneration()
  invalidatePermissionReceipts(permissionReceiptKey("cache-instance", "ses-more", { messageId: "x" }))
  assert.notEqual(permissionReceiptGeneration(), before)
})
