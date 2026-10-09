import assert from "node:assert/strict"
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { TemporaryFolderRegistry, TemporaryWorkspaceError, TemporaryWorkspaces } from "./temporary-workspaces"
import { WorktreeDeletionFence } from "./worktree-session-evacuation"
import type { WorkspaceManager } from "./manager"

async function harness() {
  const base = await mkdtemp(path.join(os.tmpdir(), "codenomad-temporary-"))
  const file = path.join(base, "temporary-workspaces.json")
  const registry = await TemporaryFolderRegistry.open(path.join(base, "temporary-workspaces"), file)
  const workspaces = new Map<string, { id: string; path: string }>()
  const removed: string[] = []
  const cleared: string[] = []
  let sessions: Array<{ id: string; parentID?: string; location: { directory: string } }> = []
  let active: Record<string, unknown> = {}
  const client = {
    session: {
      list: async ({ directory }: { directory: string }) => ({ data: sessions.filter(() => directory), cursor: {} }),
      active: async () => active,
      remove: async ({ sessionID }: { sessionID: string }) => {
        removed.push(sessionID)
        if (sessionID === "already-gone") throw Object.assign(new Error("gone"), { _tag: "SessionNotFoundError", sessionID })
      },
    },
  }
  const manager = {
    get: (id: string) => workspaces.get(id),
    list: () => [...workspaces.values()],
    getServiceDirectory: (id: string) => workspaces.get(id)?.path,
    getSharedServiceClient: async () => client,
    delete: async (id: string) => { workspaces.delete(id) },
    reserveWorktreeDeletion: async (folder: string) => {
      if ([...workspaces.values()].some((workspace) => workspace.path.toLowerCase() === folder.toLowerCase())) {
        throw new Error("Worktree is open as another workspace")
      }
      return () => {}
    },
    clearTemporary: (folder: string) => { cleared.push(folder) },
  } as unknown as WorkspaceManager
  const changes: string[][] = []
  const temporary = new TemporaryWorkspaces({
    registry, workspaceManager: manager, deletionFence: new WorktreeDeletionFence(), onChange: (folders) => changes.push(folders),
  })
  return {
    base, file, registry, workspaces, removed, cleared, temporary, changes,
    setSessions: (next: typeof sessions) => { sessions = next },
    setActive: (next: typeof active) => { active = next },
    cleanup: () => rm(base, { recursive: true, force: true }),
  }
}

test("temporary folders are created under the root and survive a restart only while they exist", async () => {
  const h = await harness()
  try {
    const kept = await h.temporary.createFolder()
    const deleted = await h.temporary.createFolder()
    assert.notEqual(kept, deleted)
    assert.equal(path.dirname(kept), h.registry.root)
    assert.ok(h.registry.has(kept) && h.registry.has(deleted))
    assert.equal(h.registry.has(path.join(h.base, "elsewhere")), false)

    await rm(deleted, { recursive: true })
    const saved = JSON.parse(await readFile(h.file, "utf8"))
    saved.folders.push(path.join(h.base, "outside-root"))
    await writeFile(h.file, JSON.stringify(saved))
    const reopened = await TemporaryFolderRegistry.open(h.registry.root, h.file)
    assert.equal(reopened.has(kept), true)
    assert.equal(reopened.has(deleted), false)
    assert.deepEqual(JSON.parse(await readFile(h.file, "utf8")).folders, [kept])
  } finally { await h.cleanup() }
})

test("keeping a temporary workspace unregisters it without touching the folder", async () => {
  const h = await harness()
  try {
    const folder = await h.temporary.createFolder()
    h.workspaces.set("temp", { id: "temp", path: folder })
    h.workspaces.set("project", { id: "project", path: h.base })
    await h.temporary.keep("temp")
    assert.equal(h.registry.has(folder), false)
    assert.deepEqual(h.cleared, [folder])
    assert.ok((await stat(folder)).isDirectory())
    await assert.rejects(h.temporary.keep("temp"), (error: unknown) => error instanceof TemporaryWorkspaceError && error.statusCode === 400)
    await assert.rejects(h.temporary.discard("project"), (error: unknown) => error instanceof TemporaryWorkspaceError && error.statusCode === 400)
    assert.ok((await stat(h.base)).isDirectory())
  } finally { await h.cleanup() }
})

test("discarding removes conversations children first, closes the workspace and deletes the folder", async () => {
  const h = await harness()
  try {
    const folder = await h.temporary.createFolder()
    await mkdir(path.join(folder, "nested"))
    await writeFile(path.join(folder, "nested", "script.py"), "print(1)")
    h.workspaces.set("temp", { id: "temp", path: folder })
    h.setSessions([
      { id: "root", location: { directory: folder } },
      { id: "child", parentID: "root", location: { directory: folder } },
      { id: "already-gone", parentID: "child", location: { directory: path.join(folder, "nested") } },
      { id: "foreign", location: { directory: path.join(h.base, "other") } },
    ])
    await h.temporary.discard("temp")
    assert.deepEqual(h.removed, ["already-gone", "child", "root"])
    assert.equal(h.workspaces.has("temp"), false)
    assert.deepEqual(await readdir(h.registry.root), [])
    assert.equal(h.registry.has(folder), false)
  } finally { await h.cleanup() }
})

test("registry changes are announced and a never-opened empty folder can be abandoned", async () => {
  const h = await harness()
  try {
    const unused = await h.temporary.createFolder()
    const used = await h.temporary.createFolder()
    const open = await h.temporary.createFolder()
    assert.deepEqual(h.changes.at(-1), [unused, used, open])
    await writeFile(path.join(used, "notes.md"), "keep me")
    h.workspaces.set("open", { id: "open", path: open })
    const code = (expected: string) => (error: unknown) => error instanceof TemporaryWorkspaceError && error.code === expected
    await assert.rejects(h.temporary.abandonFolder(used), code("temporary_not_empty"))
    await assert.rejects(h.temporary.abandonFolder(open), code("temporary_open_elsewhere"))
    if (process.platform === "win32") {
      // Windows paths differing only in case name the same open folder.
      await assert.rejects(h.temporary.abandonFolder(open.toUpperCase()), code("temporary_open_elsewhere"))
    }
    await assert.rejects(h.temporary.abandonFolder(h.base), code("temporary_not_temporary"))
    await h.temporary.abandonFolder(unused)
    await assert.rejects(stat(unused), { code: "ENOENT" })
    assert.deepEqual(h.temporary.list(), [used, open])
    assert.deepEqual(h.changes.at(-1), [used, open])
    await h.temporary.keep("open")
    assert.deepEqual(h.changes.at(-1), [used])
  } finally { await h.cleanup() }
})

test("running conversations and duplicate tabs block discarding without removing anything", async () => {
  const h = await harness()
  try {
    const folder = await h.temporary.createFolder()
    h.workspaces.set("temp", { id: "temp", path: folder })
    h.setSessions([{ id: "root", location: { directory: folder } }])
    h.setActive({ root: { type: "busy" } })
    await assert.rejects(h.temporary.discard("temp"), (error: unknown) => error instanceof TemporaryWorkspaceError && error.code === "temporary_running")
    h.setActive({})
    h.workspaces.set("duplicate", { id: "duplicate", path: folder })
    await assert.rejects(h.temporary.discard("temp"), (error: unknown) => error instanceof TemporaryWorkspaceError && error.statusCode === 409)
    assert.deepEqual(h.removed, [])
    assert.ok(h.workspaces.has("temp"))
    assert.ok((await stat(folder)).isDirectory())
    assert.ok(h.registry.has(folder))
  } finally { await h.cleanup() }
})
