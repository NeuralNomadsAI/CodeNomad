import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import fs from "node:fs"
import { chmod, link, mkdtemp, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import Fastify from "fastify"
import { WorkspaceManager } from "../../workspaces/manager"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { registerWorkspaceRoutes } from "./workspaces"
import { registerBackendRelayRoutes } from "./backend-relay"
import type { RemoteServerBrowseManager } from "../../codenomad-servers/browse-manager"

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

  it("rejects an external change during staging and leaves no temporary file behind", async (t) => {
    const f = await createFixture()
    try {
      const target = path.join(f.root, "race.txt")
      await writeFile(target, "v1", "utf-8")
      const originalOpen = fs.promises.open.bind(fs.promises)
      let injected = false
      t.mock.method(fs.promises, "open", async (...args: Parameters<typeof fs.promises.open>) => {
        const handle = await originalOpen(...args)
        if (!injected && String(args[0]).includes(".codenomad-tmp-")) {
          injected = true
          await writeFile(target, "external-during-stage", "utf-8")
        }
        return handle
      })
      const response = await f.put("race.txt", { contents: "ours", expectedVersion: shaTag("v1") })
      t.mock.restoreAll()
      assert.equal(response.statusCode, 409)
      assert.deepEqual(response.json(), { error: "File changed on disk" })
      assert.equal(await readFile(target, "utf-8"), "external-during-stage")
      assert.deepEqual(await readdir(f.root), ["race.txt"])
    } finally {
      t.mock.restoreAll()
      await f.close()
    }
  })

  it("aborts without in-place fallback when staging fails", async (t) => {
    const f = await createFixture()
    try {
      const target = path.join(f.root, "stage-fail.txt")
      await writeFile(target, "intact", "utf-8")
      const originalOpen = fs.promises.open.bind(fs.promises)
      t.mock.method(fs.promises, "open", async (...args: Parameters<typeof fs.promises.open>) => {
        const handle = await originalOpen(...args)
        if (String(args[0]).includes(".codenomad-tmp-")) {
          const originalWrite = handle.write.bind(handle)
          handle.write = (async () => {
            const err = Object.assign(new Error("simulated stage failure"), { code: "EACCES" })
            throw err
          }) as typeof originalWrite
        }
        return handle
      })
      const response = await f.put("stage-fail.txt", { contents: "replacement", expectedVersion: shaTag("intact") })
      t.mock.restoreAll()
      assert.equal(response.statusCode, 400)
      assert.equal(await readFile(target, "utf-8"), "intact")
      assert.deepEqual(await readdir(f.root), ["stage-fail.txt"])
    } finally {
      t.mock.restoreAll()
      await f.close()
    }
  })

  it("serializes concurrent conditional saves across hardlink aliases", async () => {
    const f = await createFixture()
    try {
      const a = path.join(f.root, "a.txt")
      const b = path.join(f.root, "b.txt")
      await writeFile(a, "base", "utf-8")
      await link(a, b)
      const baseTag = shaTag("base")

      const [first, second] = await Promise.all([
        f.put("a.txt", { contents: "from-a", expectedVersion: baseTag }),
        f.put("b.txt", { contents: "from-b", expectedVersion: baseTag }),
      ])
      const codes = [first.statusCode, second.statusCode].sort((x, y) => x - y)
      assert.deepEqual(codes, [204, 409])
      const winner = first.statusCode === 204 ? "from-a" : "from-b"
      assert.equal(await readFile(a, "utf-8"), winner)
      assert.equal(await readFile(b, "utf-8"), winner)
    } finally {
      await f.close()
    }
  })

  it("refuses read-only files and reports oversized saves with file_too_large", async () => {
    const f = await createFixture()
    const readonlyFile = path.join(f.root, "readonly.txt")
    try {
      await writeFile(readonlyFile, "locked", "utf-8")
      await chmod(readonlyFile, 0o444)
      const refused = await f.put("readonly.txt", { contents: "overwrite", expectedVersion: shaTag("locked") })
      if (process.getuid?.() !== 0) {
        assert.equal(refused.statusCode, 400)
        assert.equal(await readFile(readonlyFile, "utf-8"), "locked")
      }

      const tooLarge = await f.put("big.txt", { contents: "a".repeat(5 * 1024 * 1024 + 1) })
      assert.equal(tooLarge.statusCode, 400)
      assert.equal(tooLarge.json().code, "file_too_large")

      // A valid <= 5 MiB file whose JSON-escaped body exceeds 16 MiB (6x control-char expansion) still succeeds.
      const escapedHeavy = "\u0001".repeat(3_000_000)
      const savedHeavy = await f.put("escaped.txt", { contents: escapedHeavy })
      assert.equal(savedHeavy.statusCode, 204)
      assert.equal(savedHeavy.headers.etag, shaTag(escapedHeavy))
    } finally {
      await chmod(readonlyFile, 0o666).catch(() => {})
      await f.close()
    }
  })

  it("returns 409 when a file's parent is deleted or replaced by a file, and verifies inode before hardlink in-place writes", async (t) => {
    const f = await createFixture()
    try {
      const subDir = path.join(f.root, "sub")
      const nested = path.join(subDir, "note.txt")
      fs.mkdirSync(subDir)
      await writeFile(nested, "v1", "utf-8")
      const v1 = (await f.preview("sub/note.txt")).json().version as string
      await rm(subDir, { recursive: true, force: true })

      const missingParent = await f.put("sub/note.txt", { contents: "v2", expectedVersion: v1 })
      assert.equal(missingParent.statusCode, 409)
      assert.deepEqual(missingParent.json(), { error: "File changed on disk" })

      // Parent directory replaced by a regular file (ENOTDIR) also returns 409.
      await writeFile(subDir, "now-a-file", "utf-8")
      const fileParent = await f.put("sub/note.txt", { contents: "v2", expectedVersion: v1 })
      assert.equal(fileParent.statusCode, 409)
      assert.deepEqual(fileParent.json(), { error: "File changed on disk" })

      // Hardlink destination replaced at the same path after opening must not mutate the old inode.
      const hlA = path.join(f.root, "hl-a.txt")
      const hlB = path.join(f.root, "hl-b.txt")
      await writeFile(hlA, "orig", "utf-8")
      await link(hlA, hlB)
      const origOpen = fs.promises.open.bind(fs.promises)
      let swapped = false
      t.mock.method(fs.promises, "open", async (...args: Parameters<typeof fs.promises.open>) => {
        const handle = await origOpen(...args)
        if (!swapped && path.resolve(String(args[0])) === path.resolve(hlA)) {
          swapped = true
          await unlink(hlA)
          await writeFile(hlA, "replaced-inode", "utf-8")
        }
        return handle
      })
      const swappedRes = await f.put("hl-a.txt", { contents: "stale-in-place", expectedVersion: shaTag("orig") })
      t.mock.restoreAll()
      assert.equal(swappedRes.statusCode, 409)
      assert.equal(await readFile(hlA, "utf-8"), "replaced-inode")
      assert.equal(await readFile(hlB, "utf-8"), "orig")

      const target = path.join(f.root, "fallback.txt")
      await writeFile(target, "before", "utf-8")
      const originalOpen = fs.promises.open.bind(fs.promises)
      t.mock.method(fs.promises, "open", async (...args: Parameters<typeof fs.promises.open>) => {
        if (String(args[0]).includes(".codenomad-tmp-")) {
          throw Object.assign(new Error("parent dir not writable"), { code: "EACCES" })
        }
        return originalOpen(...args)
      })
      const saved = await f.put("fallback.txt", { contents: "after", expectedVersion: shaTag("before") })
      t.mock.restoreAll()
      assert.equal(saved.statusCode, 204)
      assert.equal(saved.headers.etag, shaTag("after"))
      assert.equal(await readFile(target, "utf-8"), "after")
    } finally {
      t.mock.restoreAll()
      await f.close()
    }
  })

  it("forwards If-Match and ETag through the backend relay", async () => {
    const app = Fastify()
    const seen: { ifMatch?: string | null } = {}
    const manager = {
      relay: async (_id: string, _target: string, init: RequestInit) => {
        seen.ifMatch = new Headers(init.headers).get("if-match")
        return new Response(null, { status: 204, headers: { etag: shaTag("next") } })
      },
    } as unknown as RemoteServerBrowseManager
    registerBackendRelayRoutes(app, {
      manager,
      getSelfOrigins: () => new Set(["http://localhost:9898"]),
      guardCaller: () => true,
    })
    try {
      const response = await app.inject({
        method: "PUT",
        url: "/api/backends/remote-1/api/workspaces/ws/files/content?path=a.txt",
        headers: { "content-type": "application/json", "if-match": shaTag("prev") },
        payload: { contents: "next" },
      })
      assert.equal(response.statusCode, 204)
      assert.equal(seen.ifMatch, shaTag("prev"))
      assert.equal(response.headers.etag, shaTag("next"))
    } finally {
      await app.close()
    }
  })
})
