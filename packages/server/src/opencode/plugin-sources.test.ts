import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import Fastify from "fastify"
import { parse } from "jsonc-parser"
import { PluginControls } from "./plugin-controls"
import { PluginSources } from "./plugin-sources"
import { registerPluginSourceRoutes } from "../server/routes/plugin-sources"

async function fixture(options: { sameScopes?: boolean } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "plugin-sources-"))
  const global = path.join(root, "global")
  const project = options.sameScopes ? global : path.join(root, "project")
  await mkdir(global, { recursive: true })
  await mkdir(project, { recursive: true })
  const globalFile = path.join(global, "opencode.jsonc")
  const projectFile = path.join(project, ".opencode", "opencode.jsonc")
  const state = { runtime: [] as unknown[], hideProject: false, current: true }
  const documentEntry = async (file: string) => readFile(file, "utf8").then(text => [{ type: "document", path: file, info: parse(text) }], () => [])
  const connection: any = {
    assertCurrent: () => { if (!state.current) throw new Error("replaced connection") },
    client: {
      config: { get: async () => [{ type: "directory", path: global }, ...await documentEntry(globalFile),
        ...(options.sameScopes || state.hideProject ? [] : await documentEntry(projectFile))] },
      plugin: { list: async () => ({ data: state.runtime }) },
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
  const sources = new PluginSources({ documents: controls, logger: { info() {} } as any })
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
