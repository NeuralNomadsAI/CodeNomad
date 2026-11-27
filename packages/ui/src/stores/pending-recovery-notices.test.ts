import assert from "node:assert/strict"
import { test } from "node:test"

test("unsupported-plugin claims persist per backend and ignore legacy project warnings", async () => {
  const storage = new Map([["codenomad.pendingRecoveryNotices", JSON.stringify([
    "/project\nHTTP 503 from first checkout",
    "unsupported",
    ['project:"/scoped"', ["/scoped/worktree"]],
  ])]])
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
  } })
  try {
    const { claimUnsupportedPendingRecoveryNotice, captureUnsupportedPendingRecoveryNotice } = await import("./pending-recovery-notices")
    assert.equal(claimUnsupportedPendingRecoveryNotice(), false, "saved local unsupported claim survives reload")
    assert.equal(claimUnsupportedPendingRecoveryNotice("remote-a"), true)
    assert.equal(claimUnsupportedPendingRecoveryNotice("remote-a"), false)
    assert.equal(claimUnsupportedPendingRecoveryNotice("remote-b"), true)
    const staleLocal = captureUnsupportedPendingRecoveryNotice()
    captureUnsupportedPendingRecoveryNotice("remote-b").release()
    assert.equal(claimUnsupportedPendingRecoveryNotice("remote-a"), false)
    assert.equal(claimUnsupportedPendingRecoveryNotice("remote-b"), true)
    captureUnsupportedPendingRecoveryNotice("remote-a").release()
    assert.equal(claimUnsupportedPendingRecoveryNotice("remote-a"), true)
    staleLocal.release()
    assert.equal(claimUnsupportedPendingRecoveryNotice(), true, "complete recovery re-arms local unsupported notice")
    const beforeClaim = captureUnsupportedPendingRecoveryNotice("remote-c")
    assert.equal(claimUnsupportedPendingRecoveryNotice("remote-c"), true)
    beforeClaim.release()
    assert.equal(claimUnsupportedPendingRecoveryNotice("remote-c"), false, "a scan started before the claim cannot re-arm it")
    assert.doesNotMatch([...storage.values()].join(), /checkout|project:/)
  } finally {
    Reflect.deleteProperty(globalThis, "window")
  }
})
