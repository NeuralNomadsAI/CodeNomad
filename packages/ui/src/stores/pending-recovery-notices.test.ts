import assert from "node:assert/strict"
import { test } from "node:test"

test("saved warning claims keep failed coverage without retaining diagnostic text", async () => {
  const storage = new Map([["codenomad.pendingRecoveryNotices", JSON.stringify([
    "/project\nHTTP 503 from first checkout",
    "/project\nTimed out in another checkout",
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
    const { claimPendingRecoveryNotice, capturePendingRecoveryNotices } = await import("./pending-recovery-notices")
    const cause = { kind: "request", detail: "test" } as const
    assert.equal(claimPendingRecoveryNotice("/project", cause), false)
    assert.equal(claimPendingRecoveryNotice("/other", { kind: "unsupported" }), false)
    assert.equal(claimPendingRecoveryNotice("/other", cause), true)
    assert.doesNotMatch([...storage.values()].join(), /checkout/)
    capturePendingRecoveryNotices("/other").release(["/other"])
    assert.equal(claimPendingRecoveryNotice("/project", cause), false)
    capturePendingRecoveryNotices("/project").release(["/project"])
    assert.equal(claimPendingRecoveryNotice("/project", cause), true)
    capturePendingRecoveryNotices("/scoped").release(["/scoped"])
    assert.equal(claimPendingRecoveryNotice("/scoped", cause), false)
    capturePendingRecoveryNotices("/scoped").release(["/scoped", "/scoped/worktree"])
    assert.equal(claimPendingRecoveryNotice("/scoped", cause), true)
  } finally {
    Reflect.deleteProperty(globalThis, "window")
  }
})
