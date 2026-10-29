import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import Fastify from "fastify"
import { PanelExtensionStore } from "../../panel-extensions/store"
import { readPanelExtensionArchive } from "../../panel-extensions/archive"
import { fixtureArchive } from "../../panel-extensions/archive-fixture"
import type { ForgeWorkItems } from "../../forge/work-items"
import { registerPanelExtensionWorkItemRoutes } from "./panel-extension-work-items"

const API3 = { apiVersion: 3, permissions: ["session.context", "repository.workItems.read"] }

test("work item routes require explicit API 3 consent and the exact digest, read the project folder, and fence revocation and closing", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codenomad-work-items-route-")), app = Fastify(), store = new PanelExtensionStore(directory)
  const pkg = await readPanelExtensionArchive(fixtureArchive("<p>Contribute</p>", API3))
  const workspace = { id: "i", path: "/projects/app" }
  let open: typeof workspace | undefined = workspace, during: (() => Promise<void>) | undefined
  const reads: unknown[] = []
  const forge = {
    list: async (folder: string, input: unknown) => { reads.push([folder, input]); await during?.(); return { status: "unavailable", reason: "no_remote" } },
    itemUrl: async (folder: string, kind: string, number: number) => { reads.push([folder, kind, number]); return `https://github.com/o/r/pull/${number}` },
  } as unknown as ForgeWorkItems
  registerPanelExtensionWorkItemRoutes(app, { store, forge, workspaceManager: { get: (id: string) => id === "i" ? open : undefined } as any })
  const body = { instanceId: "i", digest: pkg.digest, kind: "pullRequest", query: "", page: 1, fresh: false }
  const list = (extra = {}) => app.inject({ method: "POST", url: `/api/panel-extensions/${pkg.manifest.id}/workItems`, payload: { ...body, ...extra } })
  try {
    await store.install(pkg)
    assert.equal((await list()).statusCode, 403, "installed packages start disabled")
    assert.equal(reads.length, 0)
    await store.activate(pkg.manifest.id, pkg.digest, true)
    for (const invalid of [{ directory: "/other" }, { kind: "branch" }, { page: 0 }, { page: 51 }, { query: "x".repeat(201) }]) {
      assert.equal((await list(invalid)).statusCode, 400, JSON.stringify(invalid))
    }
    assert.equal((await list({ digest: "a".repeat(64) })).statusCode, 409)
    assert.equal((await list({ instanceId: "closed" })).statusCode, 404)
    assert.equal(reads.length, 0)

    const success = await list()
    assert.deepEqual([success.statusCode, success.headers["cache-control"], success.json()], [200, "no-store", { status: "unavailable", reason: "no_remote" }])
    assert.deepEqual(reads.at(-1), ["/projects/app", { kind: "pullRequest", query: "", page: 1, fresh: false }])
    const url = await app.inject({ method: "POST", url: `/api/panel-extensions/${pkg.manifest.id}/workItemUrl`,
      payload: { instanceId: "i", digest: pkg.digest, kind: "pullRequest", number: 7 } })
    assert.deepEqual([url.statusCode, url.json()], [200, { url: "https://github.com/o/r/pull/7" }])

    during = () => store.activate(pkg.manifest.id, pkg.digest, false)
    assert.equal((await list()).statusCode, 403, "revocation during the read fences its result")
    await store.activate(pkg.manifest.id, pkg.digest, true)
    during = async () => { open = undefined }
    assert.equal((await list()).statusCode, 503, "closing the project during the read fences its result")
    during = undefined
    open = workspace

    const assets = await readPanelExtensionArchive(fixtureArchive("<p>Assets</p>", { apiVersion: 2, permissions: ["session.context", "session.assets.read"] }))
    await store.install(assets, pkg.digest)
    await store.activate(assets.manifest.id, assets.digest, true)
    assert.equal((await list({ digest: assets.digest })).statusCode, 403, "other API versions hold no work item permission")
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})

test("a caller that goes away cancels its host read", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codenomad-work-items-abort-")), app = Fastify(), store = new PanelExtensionStore(directory)
  const pkg = await readPanelExtensionArchive(fixtureArchive("<p>Contribute</p>", API3))
  let started!: () => void
  const reading = new Promise<void>(resolve => { started = resolve })
  let cancelled: Promise<boolean> | undefined
  const forge = { list: (_folder: string, _input: unknown, signal: AbortSignal) => {
    cancelled = new Promise<boolean>(resolve => signal.addEventListener("abort", () => resolve(true), { once: true }))
    started()
    return new Promise(() => {})
  } } as unknown as ForgeWorkItems
  registerPanelExtensionWorkItemRoutes(app, { store, forge, workspaceManager: { get: () => ({ id: "i", path: "/projects/app" }) } as any })
  try {
    await store.install(pkg)
    await store.activate(pkg.manifest.id, pkg.digest, true)
    const address = await app.listen({ host: "127.0.0.1", port: 0 })
    const caller = new AbortController()
    const response = fetch(`${address}/api/panel-extensions/${pkg.manifest.id}/workItems`, { method: "POST", signal: caller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instanceId: "i", digest: pkg.digest, kind: "issue", query: "", page: 1, fresh: false }) }).catch(() => undefined)
    await reading
    caller.abort()
    await response
    assert.equal(await cancelled, true)
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }) }
})
