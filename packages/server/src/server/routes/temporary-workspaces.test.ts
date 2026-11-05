import assert from "node:assert/strict"
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import Fastify from "fastify"
import type { EventBus } from "../../events/bus"
import { WorkspaceCapabilityError } from "../../opencode/servers/capabilities"
import type { WorkspaceManager } from "../../workspaces/manager"
import { TemporaryFolderRegistry } from "../../workspaces/temporary-workspaces"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { registerTemporaryWorkspaceRoutes } from "./temporary-workspaces"

test("temporary routes refuse explicit intents and host registry collisions before side effects", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "codenomad-temp-routes-"))
  const registry = await TemporaryFolderRegistry.open(path.join(base, "folders"), path.join(base, "registry.json"))
  const effects: string[] = []
  const workspaces = new Map<string, { id: string; path: string }>()
  const manager = {
    temporaryFolders: registry,
    get: (id: string) => workspaces.get(id),
    requireWorkspaceCapability(id: string, capability: string) {
      assert.equal(capability, "worktrees")
      if (id !== "local") throw new WorkspaceCapabilityError("worktrees", { code: "deferred" })
      return new AbortController().signal
    },
    clearTemporary: () => effects.push("clear"),
    list: () => { effects.push("list"); return [...workspaces.values()] },
    getSharedServiceClient: () => { throw new Error("native acquisition forbidden") },
  } as unknown as WorkspaceManager
  const app = Fastify()
  registerTemporaryWorkspaceRoutes(app, {
    workspaceManager: manager, worktreeDeletionFence: new WorktreeDeletionFence(),
    eventBus: { publish: () => effects.push("publish") } as unknown as EventBus,
  })
  try {
    const created = await app.inject({ method: "POST", url: "/api/workspaces/temporary", payload: {} })
    assert.equal(created.statusCode, 201)
    const folder = created.json().path
    await writeFile(path.join(folder, "sentinel"), "local")
    for (const id of ["local", "A", "B"]) workspaces.set(id, { id, path: folder })
    effects.length = 0
    for (const id of ["A", "B", "unknown"]) {
      for (const [url, payload] of [
        ["/api/workspaces/temporary", { serverId: id }],
        ["/api/workspaces/temporary/abandon", { serverId: id, path: folder }],
        ...(id === "unknown" ? [] : [
          [`/api/workspaces/${id}/keep`, {}], [`/api/workspaces/${id}/discard`, {}],
        ]),
      ] as Array<[string, object]>) {
        const response = await app.inject({ method: "POST", url, payload })
        assert.equal(response.statusCode, 403)
        assert.deepEqual(response.json(), { error: "explicit_capability_unavailable", code: "explicit_capability_unavailable", capability: "worktrees", reason: { code: "deferred" } })
      }
    }
    for (const intent of [
      { binding: { serverId: "A", directory: folder } },
      { binding: { serverId: "B", directory: folder }, serverId: "local-shared" },
      { workspace: "A" },
      { target: { serverId: "B" } },
    ]) {
      for (const [url, payload] of [
        ["/api/workspaces/temporary", intent],
        ["/api/workspaces/temporary/abandon", { ...intent, path: folder }],
      ] as Array<[string, object]>) {
        const response = await app.inject({ method: "POST", url, payload })
        assert.equal(response.statusCode, 400, response.body)
      }
    }
    assert.deepEqual(effects, [])
    assert.deepEqual(registry.list(), [folder])
    assert.deepEqual(await readdir(registry.root), [path.basename(folder)])
    assert.equal(await readFile(path.join(folder, "sentinel"), "utf8"), "local")
    assert.equal((await app.inject({ method: "POST", url: "/api/workspaces/local/keep" })).statusCode, 204)
    assert.deepEqual(registry.list(), [])
    assert.ok((await stat(folder)).isDirectory())
  } finally {
    await app.close()
    await rm(base, { recursive: true, force: true })
  }
})
