import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { link, mkdtemp, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import Fastify from "fastify"
import { WorkspaceManager } from "../../workspaces/manager"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { registerWorkspaceRoutes } from "./workspaces"

const shaTag = (text: string) => `"${createHash("sha256").update(Buffer.from(text, "utf-8")).digest("hex")}"`

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-file-version-"))
  const id = "ws-version"
  const workspace = { id, path: root }
  const manager = Object.assign(Object.create(WorkspaceManager.prototype), {
    get: (requested: string) => requested === id ? workspace : undefined,
    requireWorkspace: (requested: string) => {
      if (requested !== id) throw new Error("Workspace not found")
      return workspace
    },
    getWorktreeIdentityForPath: async (_id: string, directory: string) => directory === root ? directory : undefined,
    resolveOwnedWorktree: async (_workspace: unknown, directory: string) => directory === root ? { directory } : null,
  }) as WorkspaceManager
  const app = Fastify()
  registerWorkspaceRoutes(app, { workspaceManager: manager, worktreeDeletionFence: new WorktreeDeletionFence() })
  return {
    root,
    app,
    preview: (file: string) => app.inject(`/api/workspaces/${id}/files/preview?${new URLSearchParams({ path: file, directory: root })}`),
    put: (file: string, payload: Record<string, unknown>, headers?: Record<string, string>) =>
      app.inject({
        method: "PUT",
        url: `/api/workspaces/${id}/files/content?${new URLSearchParams({ path: file, directory: root })}`,
        payload,
        headers,
      }),
    close: async () => {
      await app.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

describe("workspace file version & optimistic concurrency", () => {
  it("returns matching version and ETag from preview and updates ETag on valid expectedVersion PUT", async () => {
    const f = await createFixture()
    try {
      await writeFile(path.join(f.root, "notes.txt"), "initial content", "utf-8")

      const preview = await f.preview("notes.txt")
      assert.equal(preview.statusCode, 200)
      const expectedTag = shaTag("initial content")
      assert.equal(preview.headers.etag, expectedTag)
      assert.equal(preview.json().version, expectedTag)
      assert.equal(Buffer.from(preview.json().contents, "base64").toString("utf-8"), "initial content")

      const saved = await f.put("notes.txt", { contents: "updated content", expectedVersion: expectedTag })
      assert.equal(saved.statusCode, 204)
      assert.equal(saved.headers.etag, shaTag("updated content"))
      assert.equal(await readFile(path.join(f.root, "notes.txt"), "utf-8"), "updated content")
      assert.deepEqual(await readdir(f.root), ["notes.txt"])
    } finally {
      await f.close()
    }
  })

  it("rejects stale expectedVersion and deleted files with 409 without writing", async () => {
    const f = await createFixture()
    try {
      const target = path.join(f.root, "notes.txt")
      await writeFile(target, "v1", "utf-8")
      const v1 = (await f.preview("notes.txt")).json().version as string

      // External edit on disk
      await writeFile(target, "external-v2", "utf-8")
      const stale = await f.put("notes.txt", { contents: "my-edit", expectedVersion: v1 })
      assert.equal(stale.statusCode, 409)
      assert.deepEqual(stale.json(), { error: "File changed on disk" })
      assert.equal(await readFile(target, "utf-8"), "external-v2")

      // External deletion on disk
      await unlink(target)
      const missing = await f.put("notes.txt", { contents: "my-edit", expectedVersion: shaTag("external-v2") })
      assert.equal(missing.statusCode, 409)
      assert.deepEqual(missing.json(), { error: "File changed on disk" })
      assert.deepEqual(await readdir(f.root), [])
    } finally {
      await f.close()
    }
  })

  it("supports If-Match alone and rejects combining If-Match with expectedVersion", async () => {
    const f = await createFixture()
    try {
      const target = path.join(f.root, "notes.txt")
      await writeFile(target, "v1", "utf-8")
      const v1 = shaTag("v1")

      const both = await f.put("notes.txt", { contents: "v2", expectedVersion: v1 }, { "if-match": v1 })
      assert.equal(both.statusCode, 400)
      assert.equal(await readFile(target, "utf-8"), "v1")

      const emptyBodyVersion = await f.put("notes.txt", { contents: "v2", expectedVersion: "" })
      assert.equal(emptyBodyVersion.statusCode, 400)
      assert.equal(await readFile(target, "utf-8"), "v1")

      const emptyHeader = await f.put("notes.txt", { contents: "v2" }, { "if-match": "" })
      assert.equal(emptyHeader.statusCode, 400)
      assert.equal(await readFile(target, "utf-8"), "v1")

      const ok = await f.put("notes.txt", { contents: "v2" }, { "if-match": v1 })
      assert.equal(ok.statusCode, 204)
      assert.equal(ok.headers.etag, shaTag("v2"))
      assert.equal(await readFile(target, "utf-8"), "v2")

      const staleHeader = await f.put("notes.txt", { contents: "v3" }, { "if-match": v1 })
      assert.equal(staleHeader.statusCode, 409)
      assert.deepEqual(staleHeader.json(), { error: "File changed on disk" })
      assert.equal(await readFile(target, "utf-8"), "v2")
    } finally {
      await f.close()
    }
  })

  it("accepts versionless PUT for existing callers and writes hardlinked files in place", async () => {
    const f = await createFixture()
    try {
      const target = path.join(f.root, "a.txt")
      const alias = path.join(f.root, "b.txt")

      const created = await f.put("a.txt", { contents: "first" })
      assert.equal(created.statusCode, 204)
      assert.equal(created.headers.etag, shaTag("first"))

      await link(target, alias)
      const updated = await f.put("a.txt", { contents: "shared-update", expectedVersion: shaTag("first") })
      assert.equal(updated.statusCode, 204)
      assert.equal(updated.headers.etag, shaTag("shared-update"))
      assert.equal(await readFile(target, "utf-8"), "shared-update")
      assert.equal(await readFile(alias, "utf-8"), "shared-update")

      // Shorter in-place write truncates cleanly
      const shorter = await f.put("a.txt", { contents: "ok", expectedVersion: shaTag("shared-update") })
      assert.equal(shorter.statusCode, 204)
      assert.equal(await readFile(alias, "utf-8"), "ok")
    } finally {
      await f.close()
    }
  })
})
