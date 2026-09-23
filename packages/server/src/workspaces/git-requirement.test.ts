import assert from "node:assert/strict"
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises"
import { execFileSync } from "node:child_process"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import Fastify from "fastify"
import pino from "pino"
import { EventBus } from "../events/bus"
import { registerWorkspaceRoutes } from "../server/routes/workspaces"
import { registerWorktreeRoutes } from "../server/routes/worktrees"
import { registerInstanceProxyRoutes } from "../server/http-server"
import { WorkspaceManager, canonicalWorktreeIdentity } from "./manager"
import { WorktreeDeletionFence } from "./worktree-session-evacuation"
import { GitRequiredError, requireHostGit } from "./git-requirement"

test("no-Git conversations retain directory ownership, agent context and deletion fences", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "codenomad-no-git-")))
  const repo = path.join(root, "repo"), folder = path.join(repo, "nested"), foreign = path.join(root, "foreign")
  await mkdir(folder, { recursive: true })
  await mkdir(foreign)
  await mkdir(path.join(folder, "child"))
  const alias = path.join(root, "alias")
  await symlink(folder, alias, process.platform === "win32" ? "junction" : "dir")
  execFileSync("git", ["init", repo], { stdio: "ignore" })
  const savedPath = Object.entries(process.env).filter(([key]) => key.toLowerCase() === "path")
  const restorePath = () => {
    for (const key of Object.keys(process.env)) if (key.toLowerCase() === "path") delete process.env[key]
    for (const [key, value] of savedPath) process.env[key] = value
  }
  const instructions = new Map<string, unknown>([["unrelated", "preserved"]])
  const sent: string[] = []
  const upstream = Fastify()
  upstream.all("/*", async request => { sent.push(request.url); return { ok: true, url: request.url } })
  await upstream.listen({ host: "127.0.0.1", port: 0 })
  const endpoint = { url: `http://127.0.0.1:${(upstream.server.address() as { port: number }).port}` }
  const client = {
    project: { list: async () => [{ id: "fixture", canonical: repo, sandboxes: [foreign] }] },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, location: { directory: sessionID === "foreign" ? foreign : sessionID === "child" ? path.join(folder, "child") : folder } }),
      environment: async () => {},
      instructions: { entry: {
        put: async ({ key, value }: { key: string; value: unknown }) => { instructions.set(key, value) },
        remove: async ({ key }: { key: string }) => { instructions.delete(key) },
      } },
    },
  }
  const logger = pino({ level: "silent" })
  const manager = new WorkspaceManager({
    rootDir: root,
    settings: { getOwner: () => ({ environmentVariables: {} }) } as never,
    binaryResolver: { resolveDefault: () => ({ path: process.execPath, label: "fixture" }) } as never,
    eventBus: new EventBus(), logger,
    sharedService: {
      headers: async () => ({ authorization: "Basic fixture" }),
      client: async () => client,
      acquire: async () => ({ endpoint, client, fetch, assertCurrent() {}, invalidate() {}, profile: async () => "modern" }),
      validateLocation: async (location: { directory: string }) => ({ ...location, project: { id: "fixture", directory: repo, canonical: repo } }),
      shutdown: async () => {},
    } as never,
  })
  const app = Fastify(), fence = new WorktreeDeletionFence()
  registerWorkspaceRoutes(app, { workspaceManager: manager, worktreeDeletionFence: fence })
  registerWorktreeRoutes(app, { workspaceManager: manager, worktreeDeletionFence: fence })
  registerInstanceProxyRoutes(app, { workspaceManager: manager, worktreeDeletionFence: fence, logger })
  try {
    for (const [key] of savedPath) delete process.env[key]
    process.env.PATH = foreign
    await assert.rejects(requireHostGit(), GitRequiredError)
    const opened = await app.inject({ method: "POST", url: "/api/workspaces", payload: { path: folder } })
    assert.equal(opened.statusCode, 201, opened.body)
    const id = opened.json().id
    const base = `/workspaces/${id}/instance/api`
    const catalogue = await manager.getWorktrees(id, "fresh")
    assert.equal(catalogue.gitAvailable, false)
    assert.equal(catalogue.isGitRepo, undefined, "do not misreport an unknown repository as a non-repository")
    assert.deepEqual(catalogue.worktrees.map(w => w.directory), [folder])
    assert.equal(await manager.getWorktreeIdentityForPath(id, alias), canonicalWorktreeIdentity(folder))
    assert.equal(await manager.getServiceDirectoryForPath(id, foreign), undefined)
    assert.equal(await manager.getServiceDirectoryForPath(id, path.join(folder, "child")), undefined)

    const list = await app.inject({ method: "GET", url: `${base}/session?project=fixture&subpath=nested` })
    assert.equal(list.statusCode, 200, list.body)
    const forwarded = new URL(list.json().url, endpoint.url)
    assert.equal(forwarded.searchParams.get("directory"), folder)
    assert.equal(forwarded.searchParams.has("project"), false)
    const cursor = (scope: object) => Buffer.from(JSON.stringify({ ...scope, anchor: { id: "owned", time: 1, direction: "next" } })).toString("base64url")
    for (const scope of [{ project: "fixture" }, { project: "fixture", subpath: "nested" }]) {
      const page = await app.inject({ method: "GET", url: `${base}/session?cursor=${cursor(scope)}` })
      assert.equal(page.statusCode, 403, page.body)
    }
    const page = await app.inject({ method: "GET", url: `${base}/session?cursor=${cursor({ directory: folder })}` })
    assert.equal(page.statusCode, 200, page.body)

    for (const [method, url, payload] of [
      ["POST", `${base}/session`, { location: { directory: folder } }],
      ["DELETE", `${base}/experimental/session/owned/instructions/entries/codenomad.voice-mode`, undefined],
      ["POST", `${base}/session/owned/prompt`, { text: "Help install Git" }],
      ["POST", `${base}/session/owned/command`, { name: "help" }],
      ["POST", `${base}/session/owned/shell`, { command: "echo available" }],
    ] as const) {
      const response = await app.inject({ method, url, payload })
      assert.equal(response.statusCode, 200, response.body)
    }
    const context = instructions.get("codenomad.git-availability") as { gitAvailable: boolean; backendPlatform: string; context: string }
    assert.equal(context.gitAvailable, false)
    assert.equal(context.backendPlatform, process.platform)
    assert.match(context.context, /WSL/)
    assert.equal(instructions.get("unrelated"), "preserved")
    const count = sent.length
    for (const session of ["foreign", "child"]) {
      const response = await app.inject({ method: "POST", url: `${base}/session/${session}/prompt`, payload: {} })
      assert.equal(response.statusCode, 403, response.body)
    }
    assert.equal(sent.length, count)
    const gitOperation = await app.inject({ method: "POST", url: `/api/workspaces/${id}/worktrees`, payload: { slug: "new-task" } })
    assert.equal(gitOperation.statusCode, 503)
    assert.equal(gitOperation.json().code, "git_required")

    await fence.run(repo, [repo], async () => {
      const response = await app.inject({ method: "POST", url: `${base}/session/owned/prompt`, payload: {} })
      assert.equal(response.statusCode, 409, response.body)
    })
    restorePath()
    assert.equal(await manager.getWorktreeIdentityForPath(id, folder), canonicalWorktreeIdentity(repo))
    const recovered = await app.inject({ method: "POST", url: `${base}/session/owned/prompt`, payload: {} })
    assert.equal(recovered.statusCode, 200, recovered.body)
    assert.equal(instructions.has("codenomad.git-availability"), false)
    assert.equal(instructions.get("unrelated"), "preserved")
  } finally {
    restorePath()
    await app.close()
    await upstream.close()
    await manager.shutdown()
    await rm(root, { recursive: true, force: true })
  }
})
