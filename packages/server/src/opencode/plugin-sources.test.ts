import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import { pathToFileURL } from "node:url"
import Fastify from "fastify"
import { parse } from "jsonc-parser"
import { PluginControls } from "./plugin-controls"
import { PluginSources } from "./plugin-sources"
import { registerPluginSourceRoutes } from "../server/routes/plugin-sources"
import { catalogEntry, catalogOf } from "./integrations/catalog-fixture"
import type { IntegrationCatalog } from "./integrations/contract"
import { IntegrationsReader } from "./integrations/integrations"

async function fixture(options: { sameScopes?: boolean; catalog?: IntegrationCatalog } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "plugin-sources-"))
  const global = path.join(root, "global")
  const project = options.sameScopes ? global : path.join(root, "project")
  await mkdir(global, { recursive: true })
  await mkdir(project, { recursive: true })
  const globalFile = path.join(global, "opencode.jsonc")
  const projectFile = path.join(project, ".opencode", "opencode.jsonc")
  const state = { runtime: [] as unknown[], hideProject: false, current: true, gate: undefined as Promise<void> | undefined,
    rpcOutput: undefined as unknown, rpcError: undefined as unknown, rpcCalls: [] as string[] }
  const documentEntry = async (file: string) => readFile(file, "utf8").then(text => [{ type: "document", path: file, info: parse(text) }], () => [])
  const connection: any = {
    assertCurrent: () => { if (!state.current) throw new Error("replaced connection") },
    client: {
      config: { get: async () => {
        await state.gate
        return [{ type: "directory", path: global }, ...await documentEntry(globalFile),
          ...(options.sameScopes || state.hideProject ? [] : await documentEntry(projectFile))]
      } },
      plugin: { list: async () => ({ data: state.runtime }) },
      rpc: { call: async ({ method }: { method: string }) => {
        state.rpcCalls.push(method)
        if (state.rpcError) throw state.rpcError
        return { output: state.rpcOutput }
      } },
    },
  }
  const manager: any = {
    get: (id: string) => id === "w" || id === "w2" ? {} : undefined,
    getSharedServiceConnection: async () => connection,
    getServiceDirectoryForPath: async (_id: string, directory: string) => directory === project ? directory : undefined,
    ownsLocation: async () => true,
    getWorktreeIdentityForPath: async () => "owned",
    getServicePathStyle: () => process.platform === "win32" ? "win32" : "posix",
    getServiceWslDistro: () => undefined,
    getHostPathForServicePath: async (_id: string, value: string) => value,
  }
  const controls = new PluginControls({ workspaceManager: manager, worktreeDeletionFence: { enter: () => () => {} }, logger: { info() {} } as any })
  const catalog = options.catalog && { read: async () => ({ state: "fresh" as const, catalog: options.catalog! }) }
  const integrations = catalog && new IntegrationsReader({ controls, workspaceManager: manager, catalog })
  const sources = new PluginSources({ documents: controls, logger: { info() {} } as any, catalog, integrations })
  return { root, globalFile, projectFile, project, state, controls, sources, location: { directory: project },
    cleanup: () => rm(root, { recursive: true, force: true }) }
}

const code = (expected: string, kind?: string) => (error: any) => error?.code === expected && (!kind || error.kind === kind)

describe("plugin source mutations", () => {
  it("adds a string at the end of the chosen scope, defaulting to nothing else, and never claims activity", async () => {
    const f = await fixture()
    try {
      await writeFile(f.globalFile, '{\n  // keep\n  "plugins": ["-other.id"]\n}\n')
      const response = await f.sources.add("w", { location: f.location, scope: "global", spec: "fixture-plugin@latest" })
      assert.deepEqual(response, { scope: "global", spec: "fixture-plugin@latest", reloadPending: true })
      const saved = await readFile(f.globalFile, "utf8")
      assert.match(saved, /\/\/ keep/)
      assert.deepEqual(parse(saved).plugins, ["-other.id", "fixture-plugin@latest"])
      // Missing project documents are created only by an explicit Project mutation.
      await assert.rejects(readFile(f.projectFile))
      await f.sources.add("w", { location: f.location, scope: "project", spec: "@scope/project-only" })
      assert.deepEqual(parse(await readFile(f.projectFile, "utf8")).plugins, ["@scope/project-only"])
    } finally { await f.cleanup() }
  })

  it("refuses a package already declared in any effective scope, whatever its form", async () => {
    const f = await fixture()
    try {
      await writeFile(f.globalFile, JSON.stringify({ plugins: ["foo@1.0.0", { package: "objpkg", options: { a: 1 } }, "alias@npm:target@1", "github:user/repo"] }))
      for (const spec of ["foo", "Foo@^2", "foo@next", "objpkg@2", "target", "alias@3", "git+https://github.com/user/repo.git#v2"]) {
        await assert.rejects(f.sources.add("w", { location: f.location, scope: "project", spec }), code("duplicate", "conflict"), spec)
      }
      // A write the daemon has not reloaded yet is still a declaration.
      f.state.hideProject = true
      await mkdir(path.dirname(f.projectFile), { recursive: true })
      await writeFile(f.projectFile, JSON.stringify({ plugins: ["late"] }))
      await assert.rejects(f.sources.add("w", { location: f.location, scope: "global", spec: "late@1" }), code("duplicate"))
      assert.deepEqual(parse(await readFile(f.globalFile, "utf8")).plugins.length, 4, "refusals write nothing")
    } finally { await f.cleanup() }
  })

  it("adds a recognised native integration to Global only, and a Git build and a registry spec of one integration collide", async () => {
    const GIT = "github:NeuralNomadsAI/opencode-integrations#"
    const f = await fixture({ catalog: catalogOf(catalogEntry("fixture", { sources: { git: [GIT] } }), catalogEntry("mail", { family: "api" })) })
    try {
      await writeFile(f.globalFile, "{}")
      for (const spec of ["@neuralnomads/opencode-fixture@^0.1", "fx@npm:@neuralnomads/opencode-fixture", `${GIT}path:/integrations/fixture`]) {
        await assert.rejects(f.sources.add("w", { location: f.location, scope: "project", spec }), code("global-only", "invalid"), spec)
      }
      await assert.rejects(readFile(f.projectFile), "a refused Project add writes nothing")
      await f.sources.add("w", { location: f.location, scope: "project", spec: "@neuralnomads/opencode-mail" })
      await f.sources.add("w", { location: f.location, scope: "global", spec: `${GIT}fixture-v0.1.0::path:/integrations/fixture` })
      await assert.rejects(f.sources.add("w", { location: f.location, scope: "global", spec: "@neuralnomads/opencode-fixture" }), code("duplicate", "conflict"))
      // Loaded from an entry no way names (a local build): its plugin ID still designates it.
      await writeFile(f.globalFile, "{}")
      f.state.runtime = [{ id: "neuralnomads.fixture", source: { type: "local", path: "/builds/fixture/index.js" }, state: { status: "active" } }]
      await assert.rejects(f.sources.add("w", { location: f.location, scope: "global", spec: "@neuralnomads/opencode-fixture" }), code("duplicate", "conflict"))
    } finally { await f.cleanup() }
  })

  it("refuses the second of two concurrent adds of one package in different scopes", async () => {
    const f = await fixture()
    try {
      await writeFile(f.globalFile, "{}")
      // Two workspaces share the Global document: the queue spans the whole server.
      const results = await Promise.allSettled([
        f.sources.add("w", { location: f.location, scope: "global", spec: "race-plugin@1" }),
        f.sources.add("w2", { location: f.location, scope: "project", spec: "race-plugin@2" }),
      ])
      assert.deepEqual(results.map(result => result.status), ["fulfilled", "rejected"])
      assert.equal((results[1] as PromiseRejectedResult).reason.code, "duplicate")
      assert.deepEqual(parse(await readFile(f.globalFile, "utf8")).plugins, ["race-plugin@1"])
      await assert.rejects(readFile(f.projectFile), "the refused scope is never written")
    } finally { await f.cleanup() }
  })

  it("refuses an add whose OpenCode reads stall, releases the queue, and never writes it later", async () => {
    const f = await fixture()
    try {
      await writeFile(f.globalFile, "{}")
      // This fake client ignores the abort signal: the grace period still releases the queue.
      const sources = new PluginSources({ documents: f.controls, logger: { info() {} } as any, addTimeoutMs: 50, abortGraceMs: 20 })
      let release!: () => void
      f.state.gate = new Promise<void>(resolve => { release = resolve })
      const stalled = sources.add("w", { location: f.location, scope: "global", spec: "stalled-plugin" })
      // Let the queued turn start its daemon reads before later reads stop stalling.
      await new Promise(resolve => setTimeout(resolve, 10))
      f.state.gate = undefined
      const next = sources.add("w2", { location: f.location, scope: "global", spec: "next-plugin" })
      await assert.rejects(stalled, code("timeout", "unavailable"))
      await next
      release()
      await new Promise(resolve => setTimeout(resolve, 50))
      assert.deepEqual(parse(await readFile(f.globalFile, "utf8")).plugins, ["next-plugin"], "the abandoned add never writes")
    } finally { await f.cleanup() }
  })

  it("re-checks an aborted signal under the lock before the document commit", async () => {
    const f = await fixture()
    try {
      await writeFile(f.globalFile, "{}")
      const controller = new AbortController()
      let edited = false
      await assert.rejects(f.controls.editConfigDocument("w", f.location, "global", document => {
        edited = true
        controller.abort()
        return `${document.text.trim().slice(0, -1)}"plugins": ["late"] }\n`
      }, controller.signal))
      assert.equal(edited, true, "the abort lands after the edit, during the commit")
      assert.equal(await readFile(f.globalFile, "utf8"), "{}")
    } finally { await f.cleanup() }
  })

  it("refuses local paths, variables and plugin IDs as 422 before any write", async () => {
    const f = await fixture()
    try {
      await writeFile(f.globalFile, JSON.stringify({ plugins: ["-known.id"] }))
      f.state.runtime = [{ id: "fixture.package", source: { type: "package", target: "fixture-plugin" }, features: {}, state: { status: "active" } }]
      for (const [spec, expected] of [["./local", "local-path"], ["file:../x", "local-path"], ["foo@{env:V}", "invalid-spec"],
        ["fixture.package", "plugin-id"], ["known.id", "plugin-id"]] as const) {
        await assert.rejects(f.sources.add("w", { location: f.location, scope: "global", spec }), code(expected, "invalid"), spec)
      }
      assert.equal(await readFile(f.globalFile, "utf8"), JSON.stringify({ plugins: ["-known.id"] }))
    } finally { await f.cleanup() }
  })

  it("removes exactly the displayed entry, leaves activation rules, and refuses a stale index", async () => {
    const f = await fixture()
    try {
      const text = '{\n  "plugins": [\n    "keep",\n    { "package": "fixture-plugin", "options": { "x": 1 } },\n    "-fixture.package"\n  ]\n}\n'
      await writeFile(f.globalFile, text)
      await assert.rejects(f.sources.remove("w", { location: f.location, scope: "global", target: "fixture-plugin", entryIndex: 0 }), code("stale", "conflict"))
      assert.equal(await readFile(f.globalFile, "utf8"), text)
      const response = await f.sources.remove("w", { location: f.location, scope: "global", target: "fixture-plugin", entryIndex: 1 })
      assert.deepEqual(response, { scope: "global", spec: "fixture-plugin", reloadPending: true })
      assert.deepEqual(parse(await readFile(f.globalFile, "utf8")).plugins, ["keep", "-fixture.package"])
      await assert.rejects(f.sources.remove("w", { location: f.location, scope: "global", target: "fixture-plugin", entryIndex: 1 }), code("stale"))
    } finally { await f.cleanup() }
  })

  it("fails attached integration removal closed at the central source route, and permits only a verified zero", async () => {
    const f = await fixture({ catalog: catalogOf(catalogEntry("fixture")) })
    const app = Fastify()
    registerPluginSourceRoutes(app, { sources: f.sources })
    try {
      const target = "@neuralnomads/opencode-fixture"
      const original = JSON.stringify({ plugins: [target, "-neuralnomads.fixture"], keep: true })
      await writeFile(f.globalFile, original)
      f.state.runtime = [{ id: "neuralnomads.fixture", source: { type: "package", target, version: "0.1.0" }, features: {}, state: { status: "active" } }]
      const status = (attachedSessions?: number) => ({ contract: 1, integration: { id: "fixture", version: "0.1.0", family: "native", spec: 0 },
        host: { state: "ok" }, connection: { state: "attached", ...(attachedSessions === undefined ? {} : { attachedSessions }) } })
      const remove = () => app.inject({ method: "DELETE", url: "/api/workspaces/w/plugin-sources", payload: { location: f.location, scope: "global", target, entryIndex: 0 } })
      f.state.rpcOutput = status(2)
      assert.deepEqual((await remove()).json(), { error: "Integration removal requires verified detached sessions", code: "attached-sessions" })
      assert.equal(await readFile(f.globalFile, "utf8"), original)
      for (const output of [status(), { ...status(0), integration: { ...status(0).integration, id: "mismatch" } }, { invalid: "SECRET_SENTINEL" }]) {
        f.state.rpcOutput = output
        const response = await remove()
        assert.equal(response.statusCode, 409)
        assert.equal(response.json().code, "attachment-unverified")
        assert.equal(response.body.includes("SECRET_SENTINEL"), false)
        assert.equal(await readFile(f.globalFile, "utf8"), original)
      }
      f.state.rpcError = new Error("SECRET_SENTINEL")
      assert.equal((await remove()).json().code, "attachment-unverified")
      assert.equal(await readFile(f.globalFile, "utf8"), original)
      f.state.rpcError = undefined
      f.state.rpcOutput = status(0)
      assert.equal((await remove()).statusCode, 200)
      assert.deepEqual(parse(await readFile(f.globalFile, "utf8")), { plugins: ["-neuralnomads.fixture"], keep: true })
      assert.ok(f.state.rpcCalls.length > 0)
      assert.ok(f.state.rpcCalls.every(method => method === "status"), "never invents binding enumeration or detach-all")
    } finally { await app.close(); await f.cleanup() }
  })

  it("protects local native sources recognised by plugin ID and refuses removal without status authority", async () => {
    const f = await fixture({ catalog: catalogOf(catalogEntry("fixture")) })
    try {
      const localPath = path.join(f.root, "builds", "fixture", "index.js")
      const target = pathToFileURL(localPath).href
      const original = JSON.stringify({ plugins: [target] })
      await writeFile(f.globalFile, original)
      f.state.runtime = [{ id: "neuralnomads.fixture", source: { type: "local", path: localPath }, features: {}, state: { status: "active" } }]
      f.state.rpcOutput = { contract: 1, integration: { id: "fixture", version: "0.1.0", family: "native", spec: 0 }, connection: { state: "attached", attachedSessions: 1 } }
      await assert.rejects(f.sources.remove("w", { location: f.location, scope: "global", target, entryIndex: 0 }), code("attached-sessions"))
      const noReader = new PluginSources({ documents: f.controls, logger: { info() {} } as any,
        catalog: { read: async () => ({ state: "fresh", catalog: catalogOf(catalogEntry("fixture")) }) } })
      await assert.rejects(noReader.remove("w", { location: f.location, scope: "global", target, entryIndex: 0 }), code("attachment-unverified"))
      assert.equal(await readFile(f.globalFile, "utf8"), original)
    } finally { await f.cleanup() }
  })

  it("reads removal authority after queued edits and keeps the edit connection pinned through commit", async () => {
    const catalog = catalogOf(catalogEntry("fixture"))
    const f = await fixture({ catalog })
    const target = "@neuralnomads/opencode-fixture"
    const original = JSON.stringify({ plugins: [target] })
    try {
      await writeFile(f.globalFile, original)
      f.state.runtime = [{ id: "neuralnomads.fixture", source: { type: "package", target, version: "0.1.0" }, features: {}, state: { status: "active" } }]
      const output = (attachedSessions: number) => ({ contract: 1, integration: { id: "fixture", version: "0.1.0", family: "native", spec: 0 },
        connection: { state: "attached", attachedSessions } })
      f.state.rpcOutput = output(0)
      let enter!: () => void, release!: () => void
      const entered = new Promise<void>(resolve => { enter = resolve })
      const gate = new Promise<void>(resolve => { release = resolve })
      const firstEdit = f.controls.editConfigDocument("w", f.location, "global", async document => {
        enter(); await gate; return document.text
      })
      await entered
      const removal = f.sources.remove("w", { location: f.location, scope: "global", target, entryIndex: 0 })
      assert.equal(f.state.rpcCalls.length, 0, "no preflight authority is taken outside the edit queue")
      f.state.rpcOutput = output(1)
      release()
      await firstEdit
      await assert.rejects(removal, code("attached-sessions"))
      assert.equal(await readFile(f.globalFile, "utf8"), original)

      const sources = new PluginSources({ documents: f.controls, logger: { info() {} } as any,
        catalog: { read: async () => ({ state: "fresh", catalog }) },
        integrations: { read: async () => {
          f.state.current = false
          return { location: f.location, catalog: { state: "fresh" }, integrations: [
            { id: "fixture", state: "ok", status: { connection: { attachedSessions: 0 } } },
          ] } as any
        } },
      })
      await assert.rejects(sources.remove("w", { location: f.location, scope: "global", target, entryIndex: 0 }))
      assert.equal(await readFile(f.globalFile, "utf8"), original, "a verified zero from a superseded edit connection cannot commit")
    } finally { await f.cleanup() }
  })

  it("keeps ownership, scope availability and connection fencing from the shared document primitive", async () => {
    const f = await fixture({ sameScopes: true })
    try {
      await assert.rejects(f.sources.add("w", { location: f.location, scope: "project", spec: "foo" }), (error: any) => error.kind === "unavailable")
      await assert.rejects(f.sources.add("w", { location: { directory: path.join(f.root, "foreign") }, scope: "global", spec: "foo" }),
        (error: any) => error.kind === "forbidden")
      await assert.rejects(f.sources.add("other", { location: f.location, scope: "global", spec: "foo" }), (error: any) => error.kind === "not-found")
      f.state.current = false
      await assert.rejects(f.sources.add("w", { location: f.location, scope: "global", spec: "foo" }), (error: any) => error.kind === "unavailable")
      await assert.rejects(readFile(f.globalFile))
    } finally { await f.cleanup() }
  })

  it("exposes the inventory correlation and GUI flag the Plugins surface needs", async () => {
    const f = await fixture()
    try {
      await writeFile(f.globalFile, JSON.stringify({ plugins: ["fixture-plugin@latest", "pending-plugin"] }))
      f.state.runtime = [{ id: "fixture.package", source: { type: "package", target: "fixture-plugin@latest", version: "1.0.0", outdated: true },
        features: { server: true, gui: true }, state: { status: "active" } }]
      const snapshot = await f.controls.read("w", f.location)
      assert.deepEqual(snapshot.configured.sources.map(({ target, pluginId }) => ({ target, pluginId })),
        [{ target: "fixture-plugin@latest", pluginId: "fixture.package" }, { target: "pending-plugin", pluginId: undefined }])
      assert.deepEqual(snapshot.runtime[0]?.features, { server: true, gui: true })
      assert.deepEqual(snapshot.runtime[0]?.source, { type: "package", target: "fixture-plugin@latest", version: "1.0.0", outdated: true })
    } finally { await f.cleanup() }
  })
})

describe("plugin source routes", () => {
  it("validates strictly and maps errors with their stable code", async () => {
    const f = await fixture()
    const app = Fastify({ logger: false })
    try {
      registerPluginSourceRoutes(app, { sources: f.sources })
      const url = "/api/workspaces/w/plugin-sources"
      for (const payload of [
        { location: f.location, scope: "global" },
        { location: f.location, scope: "machine", spec: "foo" },
        { location: f.location, scope: "global", spec: "foo", path: "/elsewhere" },
        { location: { ...f.location, token: "x" }, scope: "global", spec: "foo" },
      ]) {
        assert.equal((await app.inject({ method: "POST", url, payload })).statusCode, 400)
      }
      assert.equal((await app.inject({ method: "DELETE", url, payload: { location: f.location, scope: "global", target: "x", entryIndex: -1 } })).statusCode, 400)
      const local = await app.inject({ method: "POST", url, payload: { location: f.location, scope: "global", spec: "./local" } })
      assert.equal(local.statusCode, 422)
      assert.equal(local.json().code, "local-path")
      const added = await app.inject({ method: "POST", url, payload: { location: f.location, scope: "global", spec: "foo" } })
      assert.equal(added.statusCode, 200)
      const duplicate = await app.inject({ method: "POST", url, payload: { location: f.location, scope: "project", spec: "foo@2" } })
      assert.equal(duplicate.statusCode, 409)
      assert.equal(duplicate.json().code, "duplicate")
      const stale = await app.inject({ method: "DELETE", url, payload: { location: f.location, scope: "global", target: "bar", entryIndex: 0 } })
      assert.equal(stale.statusCode, 409)
      assert.equal(stale.json().code, "stale")
      const removed = await app.inject({ method: "DELETE", url, payload: { location: f.location, scope: "global", target: "foo", entryIndex: 0 } })
      assert.equal(removed.statusCode, 200)
      assert.deepEqual(parse(await readFile(f.globalFile, "utf8")).plugins, [])
    } finally { await app.close(); await f.cleanup() }
  })
})
