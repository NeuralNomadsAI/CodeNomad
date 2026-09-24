import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import Fastify from "fastify"
import pino from "pino"
import { WorkspaceManager } from "./manager"
import { WorktreeDeletionFence } from "./worktree-session-evacuation"
import { EventBus } from "../events/bus"
import { registerWorkspaceRoutes } from "../server/routes/workspaces"
import { fixtureCatalogue } from "./__tests__/native-worktree-fixture"

test("project listing/search use an owned worktree and reject foreign directories and traversal", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "codenomad-attachment-root-")))
  const repo = path.join(root, "repo"), worktree = path.join(root, "worktree"), foreign = path.join(root, "foreign")
  const git = (...args: string[]) => execFileSync("git", args, { stdio: "ignore" })
  await mkdir(foreign)
  git("init", "--initial-branch=main", repo)
  git("-C", repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "--allow-empty", "-m", "init")
  git("-C", repo, "worktree", "add", "-b", "feature", worktree)
  await writeFile(path.join(repo, "main-only.txt"), "main")
  await writeFile(path.join(worktree, "worktree-only.txt"), "worktree")
  await writeFile(path.join(foreign, "secret.txt"), "private")
  const manager = new WorkspaceManager({ rootDir: root, logger: pino({ level: "silent" }), eventBus: new EventBus(),
    settings: { getOwner: () => ({ environmentVariables: {} }) } as never,
    binaryResolver: { resolveDefault: () => ({ path: process.execPath, label: "fixture" }) } as never,
    sharedService: { headers: async () => ({}), client: async () => ({}),
      validateLocation: async (location: object) => ({ ...location, project: { id: "fixture", directory: repo, canonical: repo } }), shutdown: async () => {} } as never,
  })
  const app = Fastify()
  registerWorkspaceRoutes(app, { workspaceManager: manager, worktreeDeletionFence: new WorktreeDeletionFence() })
  const savedPath = process.env.PATH
  try {
    const opened = await app.inject({ method: "POST", url: "/api/workspaces", payload: { path: repo } })
    assert.equal(opened.statusCode, 201, opened.body)
    const id = opened.json().id
    manager.getWorktrees = async () => fixtureCatalogue(repo, [repo, worktree])
    const base = `/api/workspaces/${id}/files`
    for (const suffix of ["?path=.", "/search?q=only"]) {
      const response = await app.inject(`${base}${suffix}&directory=${encodeURIComponent(worktree)}`)
      assert.equal(response.statusCode, 200, response.body)
      assert.ok(response.json().some((entry: any) => entry.path === "worktree-only.txt"))
      assert.equal(response.json().some((entry: any) => entry.path === "main-only.txt"), false)
      const denied = await app.inject(`${base}${suffix}&directory=${encodeURIComponent(foreign)}`)
      assert.equal(denied.statusCode, 400, denied.body)
      assert.match(denied.body, /not owned/)
    }
    const escape = await app.inject(`${base}?path=../foreign&directory=${encodeURIComponent(worktree)}`)
    assert.equal(escape.statusCode, 400)
    const original = await app.inject(`${base}?path=.`)
    assert.ok(original.json().some((entry: any) => entry.path === "main-only.txt"))
    // The explicitly opened physical directory remains usable without Git.
    process.env.PATH = foreign
    const degraded = await app.inject(`${base}?path=.&directory=${encodeURIComponent(repo)}`)
    assert.equal(degraded.statusCode, 200, degraded.body)
  } finally {
    process.env.PATH = savedPath
    await app.close()
    await manager.shutdown()
    await rm(root, { recursive: true, force: true })
  }
})
