import assert from "node:assert/strict"
import test from "node:test"
import vm from "node:vm"
import { requireMemoryCleanup, runMemoryCleanupInWindow } from "./memory-cleanup"
import type { RendererFlushWindow } from "./renderer-client-state-flush"

const request = { id: "one", scope: "global", workspaceId: "project-a", directory: "/repo-a" } as const
test("remote cleanup binds the durable server identity as well as the qualified project", () => {
  const remote = { ...request, workspaceId: "remote~same", serverId: "server-a" }
  const context = { section: "general", instanceId: remote.workspaceId, serverId: "server-a", location: { directory: remote.directory } } as const
  assert.deepEqual(requireMemoryCleanup(remote, context), remote)
  assert.throws(() => requireMemoryCleanup({ ...remote, serverId: "replacement" }, context))
  assert.throws(() => requireMemoryCleanup({ ...remote, serverId: undefined }, context))
})
test("cleanup forwards only a fixed intent with the exact Preferences project", async () => {
  const context = { section: "general", instanceId: "project-a", location: { directory: "/repo-a" } } as const
  assert.deepEqual(requireMemoryCleanup(request, context), request)
  for (const invalid of [{ ...request, prompt: "run me" }, { ...request, sessionId: "existing" }, { ...request, workspaceId: "project-b" }, { ...request, directory: "/repo-b" }, { ...request, scope: "other" }]) {
    assert.throws(() => requireMemoryCleanup(invalid, context))
  }
  assert.throws(() => requireMemoryCleanup(request, undefined))
  const calls: unknown[] = []
  const page = { location: { origin: "http://localhost:3000" }, __CODENOMAD_MEMORY_CLEANUP__: async (value: unknown) => { calls.push(value) } }
  const window: RendererFlushWindow = { isDestroyed: () => false, webContents: {
    isDestroyed: () => false, getURL: () => "http://localhost:3000/app",
    executeJavaScript: async source => vm.runInNewContext(source, { window: page }),
  } }
  await runMemoryCleanupInWindow(window, request, () => true)
  assert.equal(JSON.stringify(calls), JSON.stringify([request]))
  await assert.rejects(runMemoryCleanupInWindow(undefined, request, () => true))
  await assert.rejects(runMemoryCleanupInWindow(window, request, () => false))
  page.location.origin = "https://outside.example"
  await assert.rejects(runMemoryCleanupInWindow(window, request, () => true))
  assert.equal(calls.length, 1)
})
