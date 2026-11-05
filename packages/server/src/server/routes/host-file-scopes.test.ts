import assert from "node:assert/strict"
import test from "node:test"
import fs from "node:fs/promises"
import Fastify from "fastify"
import type { FileSystemBrowser } from "../../filesystem/browser"
import { registerFilesystemRoutes } from "./filesystem"
import { registerConfigFileRoutes } from "./config-files"
import { registerTemporaryWorkspaceRoutes } from "./temporary-workspaces"
import { TemporaryWorkspaces } from "../../workspaces/temporary-workspaces"
import type { WorkspaceManager } from "../../workspaces/manager"
import type { EventBus } from "../../events/bus"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"

test("host filesystem/config routes reject project/server selectors before IO", async t => {
  const app = Fastify(); t.after(() => app.close())
  let effects = 0
  const forbidden = () => { effects++; throw new Error("Host IO forbidden") }
  registerFilesystemRoutes(app, { fileSystemBrowser: {
    browse: forbidden, createFolder: forbidden, readFileContent: forbidden,
  } as unknown as FileSystemBrowser })
  registerConfigFileRoutes(app, { files: [{ id: "host", label: "Host", path: "display", absolutePath: "/exact", language: "json" }] })
  await app.ready()
  t.mock.method(fs, "readFile", forbidden)
  t.mock.method(fs, "writeFile", forbidden)
  t.mock.method(fs, "mkdir", forbidden)
  for (const serverId of ["A", "B"]) {
    for (const selector of [`serverId=${serverId}`, `workspaceId=${serverId}`, `binding%5BserverId%5D=${serverId}`]) {
      for (const url of [
        `/api/filesystem?path=%2Fexact&${selector}`,
        `/api/filesystem/files/content?path=%2Fexact&${selector}`,
        `/api/config-files?${selector}`, `/api/config-files/host/content?${selector}`,
      ]) assert.equal((await app.inject(url)).statusCode, 400, url)
      assert.equal((await app.inject({ method: "PUT", url: `/api/config-files/host/content?${selector}`, payload: { contents: "forbidden" } })).statusCode, 400)
    }
    for (const scope of [{ serverId }, { binding: { serverId, directory: "/exact" } }]) {
      assert.equal((await app.inject({ method: "POST", url: "/api/filesystem/folders", payload: { name: "forbidden", parentPath: "/exact", ...scope } })).statusCode, 400)
      assert.equal((await app.inject({ method: "PUT", url: "/api/config-files/host/content", payload: { contents: "forbidden", ...scope } })).statusCode, 400)
    }
  }
  assert.equal(effects, 0)
})

test("host mutations reject query scope before adapters, including encoded and mixed intents", async t => {
  const app = Fastify(); t.after(() => app.close())
  const effects: string[] = []
  registerFilesystemRoutes(app, { fileSystemBrowser: {
    createFolder: async () => { effects.push("folder"); return { path: "/host/new" } },
  } as unknown as FileSystemBrowser })
  t.mock.method(TemporaryWorkspaces.prototype, "createFolder", async () => { effects.push("temporary"); return "/host/new" })
  t.mock.method(TemporaryWorkspaces.prototype, "abandonFolder", async () => { effects.push("abandon") })
  registerTemporaryWorkspaceRoutes(app, {
    workspaceManager: { temporaryFolders: {} } as WorkspaceManager,
    eventBus: {} as EventBus, worktreeDeletionFence: new WorktreeDeletionFence(),
  })
  const routes = [
    { url: "/api/filesystem/folders", payload: { parentPath: "/host", name: "new" }, capability: "files", status: 201 },
    { url: "/api/workspaces/temporary", payload: {}, capability: "worktrees", status: 201 },
    { url: "/api/workspaces/temporary/abandon", payload: { path: "/host/new" }, capability: "worktrees", status: 204 },
  ]
  for (const route of routes) {
    for (const selector of ["serverId=A", "workspaceId=B", "binding%5BserverId%5D=A",
      "%73erverId=A", "binding.serverId=A", "serverId=local-shared&workspaceId=B"]) {
      await t.test(`${route.url}?${selector}`, async () => {
        const response = await app.inject({ method: "POST", url: `${route.url}?${selector}`, payload: route.payload })
        assert.equal(response.statusCode, 403)
        assert.deepEqual(response.json(), { error: "explicit_capability_unavailable", code: "explicit_capability_unavailable", capability: route.capability, reason: { code: "localOnly" } })
      })
    }
    // A local body selector cannot override the URL's explicit intent.
    const mixed = await app.inject({ method: "POST", url: `${route.url}?serverId=A`, payload: { ...route.payload, serverId: "local-shared" } })
    await t.test(`${route.url} mixed URL/body`, () => assert.equal(mixed.statusCode, 403))
    // The production server has no form parser: forms fail before any handler.
    const form = await app.inject({ method: "POST", url: route.url, headers: { "content-type": "application/x-www-form-urlencoded" }, payload: "serverId=A" })
    assert.equal(form.statusCode, 415)
  }
  assert.deepEqual(effects, [])
  assert.equal((await app.inject({ method: "POST", url: "/api/filesystem/missing?serverId=A", payload: {} })).statusCode, 404)
  for (const route of routes) assert.equal((await app.inject({ method: "POST", url: route.url, payload: route.payload })).statusCode, route.status)
  assert.deepEqual(effects, ["folder", "temporary", "abandon"])
})
