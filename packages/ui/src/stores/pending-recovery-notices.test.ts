import assert from "node:assert/strict"
import { test } from "node:test"

test("saved warning claims survive reload without retaining diagnostics", async () => {
  const storage = new Map([["codenomad.pendingRecoveryNotices", JSON.stringify([
    "/project\nHTTP 503 from first checkout",
    "/project\nTimed out in another checkout",
    "unsupported",
  ])]])
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
  } })
  try {
    const { claimPendingRecoveryNotice, releasePendingRecoveryNotices } = await import("./pending-recovery-notices")
    assert.equal(claimPendingRecoveryNotice("/project", "directories"), false)
    assert.equal(claimPendingRecoveryNotice("/other", "unsupported"), false)
    assert.equal(claimPendingRecoveryNotice("/other", "request"), true)
    assert.doesNotMatch([...storage.values()].join(), /checkout/)
    releasePendingRecoveryNotices("/other")
    assert.equal(claimPendingRecoveryNotice("/project", "unstable"), false)
    releasePendingRecoveryNotices("/project")
    assert.equal(claimPendingRecoveryNotice("/project", "unstable"), true)
  } finally {
    Reflect.deleteProperty(globalThis, "window")
  }
})
