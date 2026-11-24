import assert from "node:assert/strict"
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import { pathToFileURL } from "node:url"
import { setImmediate as nextTurn } from "node:timers/promises"
import Fastify from "fastify"
import { parse } from "jsonc-parser"
import { hostPluginControlDocumentFileSystem, type PluginControlDocumentFileSystem } from "./plugin-control-document"
import { PluginControls } from "./plugin-controls"
import { PluginSources } from "./plugin-sources"
import { registerPluginSourceRoutes } from "../server/routes/plugin-sources"
import { catalogEntry, catalogOf } from "./integrations/catalog-fixture"
import type { IntegrationCatalog } from "./integrations/contract"

async function fixture(options: { sameScopes?: boolean; catalog?: IntegrationCatalog } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "plugin-sources-"))
  const global = path.join(root, "global")
  const project = options.sameScopes ? global : path.join(root, "project")
  await mkdir(global, { recursive: true })
  await mkdir(project, { recursive: true })
  const globalFile = path.join(global, "opencode.jsonc")
  const projectFile = path.join(project, ".opencode", "opencode.jsonc")
  const state = { runtime: [] as unknown[], hideProject: false, current: true, gate: undefined as Promise<void> | undefined, normalized: undefined as unknown,
    rpcOutput: undefined as unknown, rpcError: undefined as unknown, rpcCalls: [] as string[],
    onConfigRead: undefined as (() => void) | undefined }
  const documentEntry = async (file: string) => readFile(file, "utf8").then(text => [{ type: "document", path: file, info: state.normalized ?? parse(text) }], () => [])
  const connection: any = {
    assertCurrent: () => { if (!state.current) throw new Error("replaced connection") },
    client: {
      config: { get: async () => {
        const gate = state.gate
        state.onConfigRead?.()
        await gate
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
  const sources = new PluginSources({ documents: controls, logger: { info() {} } as any, catalog })
  return { root, globalFile, projectFile, project, state, controls, sources, manager, connection, location: { directory: project },
    cleanup: () => rm(root, { recursive: true, force: true }) }
}

const code = (expected: string, kind?: string) => (error: any) => error?.code === expected && (!kind || error.kind === kind)
async function revision(f: Awaited<ReturnType<typeof fixture>>, scope = "global") {
  return (await f.controls.read("w", f.location)).targets.find(target => target.scope === scope)!.expectedRevision!
}

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

  it("keeps plugin source editing on the selected JSONC target while native settings require one document per layer", async () => {
    const f = await fixture()
    try {
      const lower = path.join(path.dirname(f.globalFile), "opencode.json")
      await writeFile(lower, '{"plugins":["lower-plugin"]}')
      await writeFile(f.globalFile, '{"plugins":[]}')
      await assert.rejects(f.controls.readConfigDocuments("w", f.location, undefined, true), /JSON and JSONC coexist/)
      await f.sources.add("w", { location: f.location, scope: "global", spec: "fixture-plugin" })
      assert.deepEqual(parse(await readFile(f.globalFile, "utf8")).plugins, ["fixture-plugin"])
      await f.sources.remove("w", { location: f.location, scope: "global", target: "fixture-plugin", entryIndex: 0, expectedRevision: await revision(f) })
      assert.deepEqual(parse(await readFile(f.globalFile, "utf8")).plugins, [])
      assert.equal(await readFile(lower, "utf8"), '{"plugins":["lower-plugin"]}')
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

  it("refuses an add whose OpenCode reads stall, releases the queue, and never writes it later", async t => {
    const f = await fixture()
    try {
      await writeFile(f.globalFile, "{}")
      t.mock.timers.enable({ apis: ["setTimeout"] })
      // This fake client ignores the abort signal: the grace period still releases the queue.
      const sources = new PluginSources({ documents: f.controls, logger: { info() {} } as any, addTimeoutMs: 500, abortGraceMs: 50 })
      let release!: () => void, enter!: () => void, reads = 0
      const admitted = new Promise<void>(resolve => { enter = resolve })
      f.state.onConfigRead = () => { if (++reads === 2) enter() }
      const pendingReads: Promise<unknown>[] = []
      const track = <T>(pending: Promise<T>) => { pendingReads.push(pending); return pending }
      const read = f.controls.read.bind(f.controls), readDocuments = f.controls.readConfigDocuments.bind(f.controls)
      t.mock.method(f.controls, "read", (...args: Parameters<typeof read>) => track(read(...args)))
      t.mock.method(f.controls, "readConfigDocuments", (...args: Parameters<typeof readDocuments>) => track(readDocuments(...args)))
      f.state.gate = new Promise<void>(resolve => { release = resolve })
      const stalled = sources.add("w", { location: f.location, scope: "global", spec: "stalled-plugin" })
      const refused = assert.rejects(stalled, code("timeout", "unavailable"))
      // Both parallel reads must hold the old gate before the next turn can proceed.
      await admitted
      f.state.gate = undefined
      const next = sources.add("w2", { location: f.location, scope: "global", spec: "next-plugin" })
      t.mock.timers.tick(500)
      t.mock.timers.tick(50)
      await refused
      await next
      release()
      await Promise.allSettled(pendingReads)
      await nextTurn()
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

  it("removes a plugin's exact rules with its source, in that document only, for active and failed plugins", async () => {
    const f = await fixture()
    try {
      const text = '{\n  // keep\n  "plugins": [\n    "@acme/ponytail@4.13.0",\n    "broken@1",\n    "keep@1",\n    "-ponytail",\n    "ponytail",\n'
        + '    "-broken.id",\n    "broken.id",\n    "-keep.id",\n    "keep.id",\n    "*",\n    "-ponytail.*"\n  ]\n}\n'
      await writeFile(f.globalFile, text)
      await mkdir(path.dirname(f.projectFile), { recursive: true })
      await writeFile(f.projectFile, JSON.stringify({ plugins: ["-ponytail", "ponytail"] }))
      f.state.runtime = [
        { id: "ponytail", source: { type: "package", target: "@acme/ponytail@4.13.0" }, features: {}, state: { status: "active" } },
        { id: "broken.id", source: { type: "package", target: "broken@1" }, features: {}, state: { status: "failed", error: "incompatible" } },
        { id: "keep.id", source: { type: "package", target: "keep@1" }, features: {}, state: { status: "active" } },
      ]
      await f.sources.remove("w", { location: f.location, scope: "global", target: "@acme/ponytail@4.13.0", entryIndex: 0, expectedRevision: await revision(f) })
      const saved = await readFile(f.globalFile, "utf8")
      assert.match(saved, /\/\/ keep\n/)
      assert.deepEqual(parse(saved).plugins, ["broken@1", "keep@1", "-broken.id", "broken.id", "-keep.id", "keep.id", "*", "-ponytail.*"])
      // Project's bare "ponytail" followed only the removed Global definition: it would become a package spec.
      assert.deepEqual(parse(await readFile(f.projectFile, "utf8")).plugins, ["-ponytail"], "the Project disable stays, its bare ID goes")
      await f.sources.remove("w", { location: f.location, scope: "global", target: "broken@1", entryIndex: 0, expectedRevision: await revision(f) })
      assert.deepEqual(parse(await readFile(f.globalFile, "utf8")).plugins, ["keep@1", "-keep.id", "keep.id", "*", "-ponytail.*"])
    } finally { await f.cleanup() }
  })

  it("reads a bare name OpenCode loaded as a package as a removable source, and removes orphan rules on request", async () => {
    const f = await fixture()
    try {
      // The state an uninstall used to leave: the rules outlived the package, and OpenCode installed the bare name.
      await writeFile(f.globalFile, JSON.stringify({ plugins: ["keep@1", "-ponytail", "ponytail", "-keep.id"] }))
      f.state.runtime = [
        { id: "keep.id", source: { type: "package", target: "keep@1" }, features: {}, state: { status: "active" } },
        { source: { type: "package", target: "ponytail" }, features: {}, state: { status: "failed", error: "Plugin must export a default definition" } },
      ]
      let snapshot = await f.controls.read("w", f.location)
      assert.deepEqual(snapshot.configured.sources.map(({ target, entryIndex }) => ({ target, entryIndex })),
        [{ target: "keep@1", entryIndex: 0 }, { target: "ponytail", entryIndex: 2 }])
      // A failed package that exported no ID may still define any ID: nothing is orphan while it is declared.
      assert.deepEqual(snapshot.controls.map(({ id, orphan }) => ({ id, orphan })), [{ id: "keep.id", orphan: undefined }, { id: "ponytail", orphan: undefined }])
      for (const pluginId of ["keep.id", "ponytail"]) {
        await assert.rejects(f.sources.remove("w", { location: f.location, scope: "global", pluginId, expectedRevision: await revision(f) }), code("stale"), pluginId)
      }
      await f.sources.remove("w", { location: f.location, scope: "global", target: "ponytail", entryIndex: 2, expectedRevision: await revision(f) })
      assert.deepEqual(parse(await readFile(f.globalFile, "utf8")).plugins, ["keep@1", "-ponytail", "-keep.id"])
      f.state.runtime = f.state.runtime.slice(0, 1)
      assert.equal((await f.controls.read("w", f.location)).controls.find(control => control.id === "ponytail")?.orphan, true)
      const response = await f.sources.remove("w", { location: f.location, scope: "global", pluginId: "ponytail", expectedRevision: await revision(f) })
      assert.deepEqual(response, { scope: "global", spec: "ponytail", reloadPending: true })
      assert.deepEqual(parse(await readFile(f.globalFile, "utf8")).plugins, ["keep@1", "-keep.id"])
      // A declaration OpenCode does not report (disabled, installing) may define the ID: its rules stay.
      await writeFile(f.globalFile, JSON.stringify({ plugins: ["disabled-package", "-hidden.id"] }))
      snapshot = await f.controls.read("w", f.location)
      assert.equal(snapshot.controls.find(control => control.id === "hidden.id")?.orphan, undefined)
      await assert.rejects(f.sources.remove("w", { location: f.location, scope: "global", pluginId: "hidden.id", expectedRevision: await revision(f) }), code("stale"))
      assert.deepEqual(parse(await readFile(f.globalFile, "utf8")).plugins, ["disabled-package", "-hidden.id"])
    } finally { await f.cleanup() }
  })

  it("keeps the disabling rule of a declared package that failed before exporting its ID", async () => {
    const f = await fixture()
    try {
      // When the package recovers, removing "-acme.real" now would let it run despite the disable.
      await writeFile(f.globalFile, JSON.stringify({ plugins: ["@acme/real-plugin", "-acme.real"] }))
      f.state.runtime = [{ source: { type: "package", target: "@acme/real-plugin" }, features: {}, state: { status: "failed", error: "incompatible" } }]
      assert.equal((await f.controls.read("w", f.location)).controls.find(control => control.id === "acme.real")?.orphan, undefined)
      await assert.rejects(f.sources.remove("w", { location: f.location, scope: "global", pluginId: "acme.real", expectedRevision: await revision(f) }), code("stale"))
      assert.deepEqual(parse(await readFile(f.globalFile, "utf8")).plugins, ["@acme/real-plugin", "-acme.real"])
    } finally { await f.cleanup() }
  })

  it("removes a bare ID that would precede the remaining definition, keeping its disabling rule", async () => {
    const f = await fixture()
    try {
      const runtime = [{ id: "acme.plugin", source: { type: "package", target: "@acme/plugin@1" }, features: {}, state: { status: "active" } }]
      await mkdir(path.dirname(f.projectFile), { recursive: true })
      for (const [globalPlugins, expected] of [
        // Only the Project declaration remains, after Global: "acme.plugin" in Global would become a package spec.
        [["@acme/plugin@1", "-acme.plugin", "acme.plugin"], ["-acme.plugin"]],
        // An earlier Global declaration still defines it: the bare ID stays a selector.
        [["@acme/plugin@1", "@acme/plugin@1", "-acme.plugin", "acme.plugin"], ["@acme/plugin@1", "-acme.plugin", "acme.plugin"]],
      ] as const) {
        await writeFile(f.globalFile, JSON.stringify({ plugins: globalPlugins }))
        await writeFile(f.projectFile, JSON.stringify({ plugins: ["@acme/plugin@^1"] }))
        f.state.runtime = runtime
        await f.sources.remove("w", { location: f.location, scope: "global", target: "@acme/plugin@1",
          entryIndex: globalPlugins.length === 3 ? 0 : 1, expectedRevision: await revision(f) })
        assert.deepEqual(parse(await readFile(f.globalFile, "utf8")).plugins, expected, String(globalPlugins))
        assert.deepEqual(parse(await readFile(f.projectFile, "utf8")).plugins, ["@acme/plugin@^1"])
      }
    } finally { await f.cleanup() }
  })

  it("deletes the Project's bare ID that loses its Global definition in the same removal, or refuses writing nothing", async () => {
    const f = await fixture()
    try {
      // "keep" is loaded with its own ID, so it cannot be another loader of acme.plugin.
      const runtime = [{ id: "acme.plugin", source: { type: "package", target: "@acme/plugin@1" }, features: {}, state: { status: "active" } },
        { id: "keep.id", source: { type: "package", target: "keep" }, features: {}, state: { status: "active" } }]
      await mkdir(path.dirname(f.projectFile), { recursive: true })
      const global = '{\n  // keep\n  "plugins": ["@acme/plugin@1", "-acme.plugin"]\n}\n'
      const project = '{\n  // project\n  "plugins": ["keep", "acme.plugin", "-acme.plugin"]\n}\n'
      await writeFile(f.globalFile, global)
      await writeFile(f.projectFile, project)
      f.state.runtime = runtime
      await f.sources.remove("w", { location: f.location, scope: "global", target: "@acme/plugin@1", entryIndex: 0, expectedRevision: await revision(f) })
      assert.deepEqual(parse(await readFile(f.globalFile, "utf8")).plugins, [])
      const saved = await readFile(f.projectFile, "utf8")
      assert.match(saved, /\/\/ project/)
      assert.deepEqual(parse(saved).plugins, ["keep", "-acme.plugin"], "the bare ID would follow no definition: a package spec")
      // A verified Project declaration before the bare ID still defines it: nothing changes there.
      await writeFile(f.globalFile, global)
      await writeFile(f.projectFile, JSON.stringify({ plugins: ["@acme/plugin@^1", "acme.plugin"] }))
      f.state.runtime = [...runtime, { ...runtime[0]!, source: { type: "package", target: "@acme/plugin@^1" } }]
      await f.sources.remove("w", { location: f.location, scope: "global", target: "@acme/plugin@1", entryIndex: 0, expectedRevision: await revision(f) })
      assert.deepEqual(parse(await readFile(f.projectFile, "utf8")).plugins, ["@acme/plugin@^1", "acme.plugin"])
      // A dependent bare ID in a document CodeNomad does not edit (a daemon-reported inline document) refuses the removal.
      await writeFile(f.globalFile, global)
      await writeFile(f.projectFile, project)
      f.state.runtime = runtime
      const inline = { type: "document", info: { plugins: ["acme.plugin"] } }
      const get = f.connection.client.config.get
      f.connection.client.config.get = async () => [...await get(), inline]
      await assert.rejects(f.sources.remove("w", { location: f.location, scope: "global", target: "@acme/plugin@1", entryIndex: 0, expectedRevision: await revision(f) }),
        code("dependent-rule", "invalid"))
      assert.equal(await readFile(f.globalFile, "utf8"), global, "a refusal writes nothing")
      assert.equal(await readFile(f.projectFile, "utf8"), project)
    } finally { await f.cleanup() }
  })

  it("commits the dependent cleanup before the source removal, so a failed last commit leaves a valid configuration", async t => {
    const f = await fixture()
    try {
      f.state.runtime = [{ id: "acme.plugin", source: { type: "package", target: "@acme/plugin@1" }, features: {}, state: { status: "active" } }]
      await mkdir(path.dirname(f.projectFile), { recursive: true })
      const global = JSON.stringify({ plugins: ["@acme/plugin@1", "-acme.plugin"] })
      await writeFile(f.globalFile, global)
      await writeFile(f.projectFile, JSON.stringify({ plugins: ["keep", "acme.plugin"] }))
      const expectedRevision = await revision(f)
      let commits = 0
      const fileSystem = hostPluginControlDocumentFileSystem as Required<PluginControlDocumentFileSystem>
      const prepare = fileSystem.prepare.bind(fileSystem)
      t.mock.method(fileSystem, "prepare", async (...args: Parameters<typeof prepare>) => {
        const write = await prepare(...args)
        return { ...write, commit: async () => { if (++commits === 2) throw new Error("injected commit failure"); await write.commit() } }
      })
      await assert.rejects(f.sources.remove("w", { location: f.location, scope: "global", target: "@acme/plugin@1", entryIndex: 0, expectedRevision }), /injected/)
      // The Global source still defines the plugin; the Project's bare ID that depended on it is already gone.
      assert.equal(await readFile(f.globalFile, "utf8"), global)
      assert.deepEqual(parse(await readFile(f.projectFile, "utf8")).plugins, ["keep"])
    } finally { await f.cleanup() }
  })

  it("keeps the disabling rule while a plugin(s)/ folder still discovers the plugin", async () => {
    const f = await fixture()
    try {
      // Removing the explicit declaration leaves the discovered plugin loaded in every project: its disable still applies.
      // plugin.list reports the resolved server entrypoint of the discovered plugins/reviewer folder.
      const discovered = path.join(path.dirname(f.globalFile), "plugins", "reviewer", "index.js")
      await mkdir(path.dirname(discovered), { recursive: true })
      await writeFile(discovered, "export default {}\n")
      f.state.runtime = [{ id: "acme.reviewer", source: { type: "local", path: discovered }, features: {}, state: { status: "active" } }]
      await mkdir(path.dirname(f.projectFile), { recursive: true })
      await writeFile(f.globalFile, JSON.stringify({ plugins: ["./plugins/reviewer", "-acme.reviewer"] }))
      await writeFile(f.projectFile, JSON.stringify({ plugins: ["acme.reviewer"] }))
      await f.sources.remove("w", { location: f.location, scope: "global", target: "./plugins/reviewer", entryIndex: 0, expectedRevision: await revision(f) })
      assert.deepEqual(parse(await readFile(f.globalFile, "utf8")).plugins, ["-acme.reviewer"])
      assert.deepEqual(parse(await readFile(f.projectFile, "utf8")).plugins, ["acme.reviewer"], "discovery still defines it before Project")
    } finally { await f.cleanup() }
  })

  it("keeps the disabling rule unless no other loader is provable: a junctioned discovery child or another inventory entry", async t => {
    const f = await fixture()
    try {
      const external = path.join(f.root, "external-reviewer")
      await mkdir(external, { recursive: true })
      await writeFile(path.join(external, "index.js"), "export default {}\n")
      const reviewer = { id: "acme.reviewer", source: { type: "local", path: path.join(external, "index.js") }, features: {}, state: { status: "active" } }
      await mkdir(path.dirname(f.projectFile), { recursive: true })
      const remove = async (runtime: unknown[]) => {
        await writeFile(f.globalFile, JSON.stringify({ plugins: [external, "-acme.reviewer"] }))
        await writeFile(f.projectFile, JSON.stringify({ plugins: ["acme.reviewer"] }))
        f.state.runtime = runtime
        await f.sources.remove("w", { location: f.location, scope: "global", target: external, entryIndex: 0, expectedRevision: await revision(f) })
        return parse(await readFile(f.globalFile, "utf8")).plugins
      }
      // Provably no other loader: the disabling rule goes with the source.
      assert.deepEqual(await remove([reviewer]), [])
      // Another inventory entry of the ID, whatever its path, may still load it.
      assert.deepEqual(await remove([reviewer, { ...reviewer, source: { type: "local", path: path.join(f.root, "elsewhere", "index.js") } }]), ["-acme.reviewer"])
      // global/plugins/reviewer junctions to the declared folder: native discovery still loads it in every project.
      await mkdir(path.join(path.dirname(f.globalFile), "plugins"), { recursive: true })
      try {
        await symlink(external, path.join(path.dirname(f.globalFile), "plugins", "reviewer"), process.platform === "win32" ? "junction" : "dir")
      } catch (error) {
        t.skip(`symbolic links unavailable: ${(error as NodeJS.ErrnoException).code}`)
        return
      }
      assert.deepEqual(await remove([reviewer]), ["-acme.reviewer"], "the disable still applies to the discovered plugin")
      // The bare ID lost its only verified definition, so it would be a package spec: it still goes.
      assert.deepEqual(parse(await readFile(f.projectFile, "utf8")).plugins, [])
    } finally { await f.cleanup() }
  })

  it("applies one loader proof to orphan rows, rule-only removal and source removal", async () => {
    const f = await fixture()
    try {
      // A disabled discovered plugin is absent from the inventory, but its file still loads it once the disable goes.
      const discovered = path.join(path.dirname(f.globalFile), "plugins", "reviewer.js")
      await mkdir(path.dirname(discovered), { recursive: true })
      await writeFile(discovered, "export default {}\n")
      const text = JSON.stringify({ plugins: ["-acme.reviewer"] })
      await writeFile(f.globalFile, text)
      assert.equal((await f.controls.read("w", f.location)).controls.find(control => control.id === "acme.reviewer")?.orphan, undefined)
      await assert.rejects(f.sources.remove("w", { location: f.location, scope: "global", pluginId: "acme.reviewer", expectedRevision: await revision(f) }), code("stale"))
      assert.equal(await readFile(f.globalFile, "utf8"), text, "the disable stays")
      // Without the file, nothing can load it: the row is orphan and its rule removable.
      await rm(discovered)
      assert.equal((await f.controls.read("w", f.location)).controls.find(control => control.id === "acme.reviewer")?.orphan, true)
      await f.sources.remove("w", { location: f.location, scope: "global", pluginId: "acme.reviewer", expectedRevision: await revision(f) })
      assert.deepEqual(parse(await readFile(f.globalFile, "utf8")).plugins, [])
      // A declaration without an exported ID may be another loader: removing a source keeps the disable.
      f.state.runtime = [{ id: "acme.plugin", source: { type: "package", target: "@acme/plugin@1" }, features: {}, state: { status: "active" } }]
      await writeFile(f.globalFile, JSON.stringify({ plugins: ["@acme/plugin@1", "unreported-package", "-acme.plugin"] }))
      await f.sources.remove("w", { location: f.location, scope: "global", target: "@acme/plugin@1", entryIndex: 0, expectedRevision: await revision(f) })
      assert.deepEqual(parse(await readFile(f.globalFile, "utf8")).plugins, ["unreported-package", "-acme.plugin"])
    } finally { await f.cleanup() }
  })

  it("identifies a discovery child only by its own entrypoint, never by a nested plugin's inventory", async () => {
    const f = await fixture()
    try {
      // plugins/bundle/index.js is the disabled outer plugin (absent from the inventory); plugins/bundle/other is a
      // separate plugin declared in Project. The child "bundle" still loads bundle.disabled once its disable goes.
      const bundle = path.join(path.dirname(f.globalFile), "plugins", "bundle")
      await mkdir(path.join(bundle, "other"), { recursive: true })
      await writeFile(path.join(bundle, "index.js"), "export default {}\n")
      await writeFile(path.join(bundle, "other", "index.js"), "export default {}\n")
      f.state.runtime = [{ id: "bundle.other", source: { type: "local", path: path.join(bundle, "other", "index.js") }, features: {}, state: { status: "active" } }]
      await mkdir(path.dirname(f.projectFile), { recursive: true })
      await writeFile(f.projectFile, JSON.stringify({ plugins: [path.join(bundle, "other")] }))
      const text = JSON.stringify({ plugins: ["-bundle.disabled"] })
      await writeFile(f.globalFile, text)
      assert.equal((await f.controls.read("w", f.location)).controls.find(control => control.id === "bundle.disabled")?.orphan, undefined)
      await assert.rejects(f.sources.remove("w", { location: f.location, scope: "global", pluginId: "bundle.disabled", expectedRevision: await revision(f) }), code("stale"))
      assert.equal(await readFile(f.globalFile, "utf8"), text)
      // The child's own entrypoint identifies it: with the outer plugin reported under another ID, nothing loads bundle.disabled.
      f.state.runtime.push({ id: "bundle.outer", source: { type: "local", path: path.join(bundle, "index.js") }, features: {}, state: { status: "active" } })
      assert.equal((await f.controls.read("w", f.location)).controls.find(control => control.id === "bundle.disabled")?.orphan, true)
    } finally { await f.cleanup() }
  })

  it("maps a discovery folder only to its selected entrypoint, server before index", async t => {
    const f = await fixture()
    try {
      // Host.resolve(bundle) selects server.js (the disabled bundle.disabled, absent from the inventory); the index.js
      // module reported as bundle.other does not identify the child.
      const plugins = path.join(path.dirname(f.globalFile), "plugins")
      const bundle = path.join(plugins, "bundle")
      await mkdir(bundle, { recursive: true })
      await writeFile(path.join(bundle, "server.js"), "export default {}\n")
      await writeFile(path.join(bundle, "index.js"), "export default {}\n")
      f.state.runtime = [{ id: "bundle.other", source: { type: "local", path: path.join(bundle, "index.js") }, features: {}, state: { status: "active" } }]
      const text = JSON.stringify({ plugins: ["-bundle.disabled"] })
      await writeFile(f.globalFile, text)
      const orphan = async () => (await f.controls.read("w", f.location)).controls.find(control => control.id === "bundle.disabled")?.orphan
      assert.equal(await orphan(), undefined)
      await assert.rejects(f.sources.remove("w", { location: f.location, scope: "global", pluginId: "bundle.disabled", expectedRevision: await revision(f) }), code("stale"))
      assert.equal(await readFile(f.globalFile, "utf8"), text)
      // A separate discovered other.js linked to that index file is identified by it through its resolved path.
      try {
        await symlink(path.join(bundle, "index.js"), path.join(plugins, "other.js"), "file")
        assert.equal(await orphan(), undefined, "the bundle child still selects server.js")
      } catch (error) {
        if (!["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error
        t.diagnostic("file symbolic links unavailable: other.js case skipped")
      }
    } finally { await f.cleanup() }
  })

  it("decides that discovery skips a folder only on proof; every doubt keeps the disable", async t => {
    const f = await fixture()
    try {
      const bundle = path.join(path.dirname(f.globalFile), "plugins", "bundle")
      const text = JSON.stringify({ plugins: ["-bundle.disabled"] })
      await writeFile(f.globalFile, text)
      const orphan = async () => (await f.controls.read("w", f.location)).controls.find(control => control.id === "bundle.disabled")?.orphan
      const kept = async (label: string) => {
        assert.equal(await orphan(), undefined, label)
        await assert.rejects(f.sources.remove("w", { location: f.location, scope: "global", pluginId: "bundle.disabled", expectedRevision: await revision(f) }), code("stale"), label)
        assert.equal(await readFile(f.globalFile, "utf8"), text, label)
        await rm(bundle, { recursive: true, force: true })
      }
      // Proof: a folder with no entry that could resolve as server or index is skipped natively.
      await mkdir(bundle, { recursive: true })
      await writeFile(path.join(bundle, "readme.md"), "")
      assert.equal(await orphan(), true)
      await rm(bundle, { recursive: true, force: true })
      // Case-insensitive file systems resolve Server.js for "server".
      await mkdir(bundle, { recursive: true })
      await writeFile(path.join(bundle, "Server.js"), "export default {}\n")
      await kept("Server.js")
      // A link to an internal file whose name starts with "..", and a link leaving the folder.
      for (const [label, target] of [["..entry.js", path.join(bundle, "..entry.js")], ["outside", path.join(f.root, "outside.js")]] as const) {
        await mkdir(bundle, { recursive: true })
        await writeFile(target, "export default {}\n")
        try {
          await symlink(target, path.join(bundle, "server.js"), "file")
        } catch (error) {
          if (!["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error
          t.diagnostic(`file symbolic links unavailable: ${label} case skipped`)
          continue
        }
        await kept(label)
      }
    } finally { await f.cleanup() }
  })

  it("identifies an explicit local declaration only by its own selected entrypoint", async () => {
    const f = await fixture()
    try {
      // bundle/index.js is the disabled outer plugin (absent from the inventory); bundle/other is a separate plugin.
      const bundle = path.join(f.root, "bundle")
      await mkdir(path.join(bundle, "other"), { recursive: true })
      await writeFile(path.join(bundle, "index.js"), "export default {}\n")
      await writeFile(path.join(bundle, "other", "index.js"), "export default {}\n")
      const other = { id: "bundle.other", source: { type: "local", path: path.join(bundle, "other", "index.js") }, features: {}, state: { status: "active" } }
      f.state.runtime = [other]
      await mkdir(path.dirname(f.projectFile), { recursive: true })
      await writeFile(f.projectFile, JSON.stringify({ plugins: [path.join(bundle, "other")] }))
      const text = JSON.stringify({ plugins: [bundle, "-bundle.disabled"] })
      await writeFile(f.globalFile, text)
      const snapshot = await f.controls.read("w", f.location)
      assert.deepEqual(snapshot.configured.sources.map(({ target, pluginId }) => ({ target, pluginId })),
        [{ target: bundle, pluginId: undefined }, { target: path.join(bundle, "other"), pluginId: "bundle.other" }], "the nested plugin does not identify the outer declaration")
      assert.equal(snapshot.controls.find(control => control.id === "bundle.disabled")?.orphan, undefined)
      await assert.rejects(f.sources.remove("w", { location: f.location, scope: "global", pluginId: "bundle.disabled", expectedRevision: await revision(f) }), code("stale"))
      assert.equal(await readFile(f.globalFile, "utf8"), text)
      // The removed source accounts only for the entry at its own entrypoint: another entry of its ID inside it is
      // another loader, so its disable stays.
      const outer = { id: "bundle.outer", source: { type: "local", path: path.join(bundle, "index.js") }, features: {}, state: { status: "active" } }
      f.state.runtime = [outer, { ...outer, source: { type: "local", path: path.join(bundle, "other", "index.js") } }]
      await writeFile(f.projectFile, JSON.stringify({ plugins: [] }))
      await writeFile(f.globalFile, JSON.stringify({ plugins: [bundle, "-bundle.outer"] }))
      await f.sources.remove("w", { location: f.location, scope: "global", target: bundle, entryIndex: 0, expectedRevision: await revision(f) })
      assert.deepEqual(parse(await readFile(f.globalFile, "utf8")).plugins, ["-bundle.outer"])
    } finally { await f.cleanup() }
  })

  it("reads a bare name after its own -rule as a package declaration, never an orphan rule", async () => {
    const f = await fixture()
    try {
      // "-foo" defines nothing: OpenCode installs "foo" from the registry, so it is a source whose ID is unknown.
      const text = JSON.stringify({ plugins: ["-foo", "foo"] })
      await writeFile(f.globalFile, text)
      const snapshot = await f.controls.read("w", f.location)
      assert.deepEqual(snapshot.configured.sources.map(({ target, entryIndex }) => ({ target, entryIndex })), [{ target: "foo", entryIndex: 1 }])
      assert.equal(snapshot.controls.find(control => control.id === "foo")?.orphan, undefined)
      await assert.rejects(f.sources.remove("w", { location: f.location, scope: "global", pluginId: "foo", expectedRevision: await revision(f) }), code("stale"))
      assert.equal(await readFile(f.globalFile, "utf8"), text)
    } finally { await f.cleanup() }
  })

  it("keeps a plugin's rules while another declaration of it remains in any applicable document", async () => {
    const f = await fixture()
    try {
      const runtime = [{ id: "acme.plugin", source: { type: "package", target: "@acme/plugin@1" }, features: {}, state: { status: "active" } }]
      await mkdir(path.dirname(f.projectFile), { recursive: true })
      for (const [globalPlugins, projectPlugins, entryIndex, expected] of [
        // A second Global declaration, enabled only in this Project: other projects keep it disabled.
        [["@acme/plugin@1", "@acme/plugin@1", "-acme.plugin"], ["acme.plugin"], 0, ["@acme/plugin@1", "-acme.plugin"]],
        [["@acme/plugin@1", "@acme/plugin@1", "-acme.plugin"], ["acme.plugin"], 1, ["@acme/plugin@1", "-acme.plugin"]],
        // Another spec of the same package in Project.
        [["@acme/plugin@1", "-acme.plugin"], ["@acme/plugin@^1"], 0, ["-acme.plugin"]],
      ] as const) {
        await writeFile(f.globalFile, JSON.stringify({ plugins: globalPlugins }))
        await writeFile(f.projectFile, JSON.stringify({ plugins: projectPlugins }))
        f.state.runtime = runtime
        await f.sources.remove("w", { location: f.location, scope: "global", target: "@acme/plugin@1", entryIndex, expectedRevision: await revision(f) })
        assert.deepEqual(parse(await readFile(f.globalFile, "utf8")).plugins, expected, `${globalPlugins} / ${projectPlugins} @${entryIndex}`)
      }
    } finally { await f.cleanup() }
  })

  it("removes exactly the displayed entry, keeps the rules of an unknown plugin ID, and refuses a stale index", async () => {
    const f = await fixture()
    try {
      const text = '{\n  "plugins": [\n    "keep",\n    { "package": "fixture-plugin", "options": { "x": 1 } },\n    "-fixture.package"\n  ]\n}\n'
      await writeFile(f.globalFile, text)
      const expectedRevision = await revision(f)
      await assert.rejects(f.sources.remove("w", { location: f.location, scope: "global", target: "fixture-plugin", entryIndex: 0, expectedRevision }), code("stale", "conflict"))
      assert.equal(await readFile(f.globalFile, "utf8"), text)
      const response = await f.sources.remove("w", { location: f.location, scope: "global", target: "fixture-plugin", entryIndex: 1, expectedRevision })
      assert.deepEqual(response, { scope: "global", spec: "fixture-plugin", reloadPending: true })
      assert.deepEqual(parse(await readFile(f.globalFile, "utf8")).plugins, ["keep", "-fixture.package"])
      await assert.rejects(f.sources.remove("w", { location: f.location, scope: "global", target: "fixture-plugin", entryIndex: 1, expectedRevision }), code("stale"))
    } finally { await f.cleanup() }
  })

  it("removes native sources for unknown, nonzero and zero bindings without any catalogue or RPC reads", async () => {
    const f = await fixture({ catalog: catalogOf(catalogEntry("fixture")) })
    const app = Fastify()
    const sources = new PluginSources({ documents: f.controls, logger: { info() {} } as any,
      catalog: { read: async () => { assert.fail("removal must not read the catalogue") } } })
    registerPluginSourceRoutes(app, { sources })
    try {
      const target = "@neuralnomads/opencode-fixture"
      const original = JSON.stringify({ plugins: [target, "-neuralnomads.fixture"], keep: true })
      await writeFile(f.globalFile, original)
      f.state.runtime = [{ id: "neuralnomads.fixture", source: { type: "package", target, version: "0.1.0" }, features: {}, state: { status: "active" } }]
      const status = (attachedSessions?: number) => ({ contract: 1, integration: { id: "fixture", version: "0.1.0", family: "native", spec: 0 },
        host: { state: "ok" }, connection: { state: "attached", ...(attachedSessions === undefined ? {} : { attachedSessions }) } })
      for (const output of [status(2), status(0), status(), { ...status(0), integration: { ...status(0).integration, family: "unknown" } }, { invalid: "SECRET_SENTINEL" }]) {
        await writeFile(f.globalFile, original)
        f.state.rpcOutput = output
        f.state.rpcError = new Error("SECRET_SENTINEL")
        const response = await app.inject({ method: "DELETE", url: "/api/workspaces/w/plugin-sources", payload: {
          location: f.location, scope: "global", target, entryIndex: 0, expectedRevision: await revision(f),
        } })
        assert.equal(response.statusCode, 200)
        assert.equal(response.body.includes("SECRET_SENTINEL"), false)
        assert.deepEqual(parse(await readFile(f.globalFile, "utf8")), { plugins: [], keep: true }, "its rule goes with the source")
        assert.equal(f.state.runtime.length, 1, "durable removal never claims all runtimes stopped")
      }
      assert.deepEqual(f.state.rpcCalls, [], "zero status, binding, detach or census RPCs")
    } finally { await app.close(); await f.cleanup() }
  })

  it("removes existing local and Project-native declarations without recognition authority", async () => {
    const f = await fixture({ catalog: catalogOf(catalogEntry("fixture")) })
    try {
      const localPath = path.join(f.root, "builds", "fixture", "index.js")
      const target = pathToFileURL(localPath).href
      const original = JSON.stringify({ plugins: [target] })
      f.state.runtime = [{ id: "neuralnomads.fixture", source: { type: "local", path: localPath }, features: {}, state: { status: "active" } }]
      await mkdir(path.dirname(f.projectFile), { recursive: true })
      for (const scope of ["global", "project"] as const) {
        const file = scope === "global" ? f.globalFile : f.projectFile
        await writeFile(file, original)
        await f.sources.remove("w", { location: f.location, scope, target, entryIndex: 0, expectedRevision: await revision(f, scope) })
        assert.deepEqual(parse(await readFile(file, "utf8")).plugins, [])
      }
      assert.deepEqual(f.state.rpcCalls, [])
    } finally { await f.cleanup() }
  })

  it("refuses a confirmed document after a queued edit without reading attachment authority", async () => {
    const catalog = catalogOf(catalogEntry("fixture"))
    const f = await fixture({ catalog })
    const target = "@neuralnomads/opencode-fixture"
    const original = JSON.stringify({ plugins: [target] })
    try {
      await writeFile(f.globalFile, original)
      f.state.runtime = [{ id: "neuralnomads.fixture", source: { type: "package", target, version: "0.1.0" }, features: {}, state: { status: "active" } }]
      const expectedRevision = await revision(f)
      let enter!: () => void, release!: () => void
      const entered = new Promise<void>(resolve => { enter = resolve })
      const gate = new Promise<void>(resolve => { release = resolve })
      const firstEdit = f.controls.editConfigDocument("w", f.location, "global", async document => {
        enter(); await gate; return document.text + "\n"
      })
      await entered
      const removal = f.sources.remove("w", { location: f.location, scope: "global", target, entryIndex: 0, expectedRevision })
      assert.equal(f.state.rpcCalls.length, 0, "no preflight authority is taken outside the edit queue")
      release()
      await firstEdit
      await assert.rejects(removal, code("stale"))
      assert.equal(await readFile(f.globalFile, "utf8"), original + "\n")
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
  it("binds confirmation to full options, document bytes, native mode, scope, Location and connection", async () => {
    const f = await fixture()
    const app = Fastify()
    registerPluginSourceRoutes(app, { sources: f.sources })
    try {
      const original = '\uFEFF{\r\n // keep\r\n "plugins": [{"package":"foo","options":{"secret":"PRIVATE_CONFIG_SENTINEL"}}, "other", "-foo.id"], "keep":true\r\n}\r\n'
      const url = "/api/workspaces/w/plugin-sources"
      const request = async () => ({ location: f.location, scope: "global" as const, target: "foo", entryIndex: 0, expectedRevision: await revision(f) })
      for (const change of [
        (text: string) => text.replace("PRIVATE_CONFIG_SENTINEL", "CHANGED_CONFIG_SENTINEL"),
        (text: string) => text + " ",
        (text: string) => text.slice(1),
        (text: string) => text.replace(/\r\n/g, "\n"),
      ]) {
        await writeFile(f.globalFile, original)
        const payload = await request()
        assert.match(payload.expectedRevision, /^[a-f0-9]{64}$/)
        assert.equal(JSON.stringify(await f.controls.read("w", f.location)).includes("PRIVATE_CONFIG_SENTINEL"), false)
        const changed = change(original)
        await writeFile(f.globalFile, changed)
        const response = await app.inject({ method: "DELETE", url, payload })
        assert.equal(response.statusCode, 409)
        assert.equal(response.json().code, "stale")
        assert.equal(await readFile(f.globalFile, "utf8"), changed)
        assert.equal(response.body.includes("SENTINEL"), false)
      }
      await writeFile(f.globalFile, original)
      let payload = await request()
      f.manager.getSharedServiceConnection = async () => ({ ...f.connection, client: { ...f.connection.client } })
      assert.equal((await app.inject({ method: "DELETE", url, payload })).statusCode, 409, "same endpoint and bytes, new client")
      f.manager.getSharedServiceConnection = async () => f.connection
      for (const altered of [{ ...payload, expectedRevision: "0".repeat(64) }, { ...payload, scope: "project" },
        { ...payload, location: { directory: path.join(f.root, "foreign") } }, { ...payload, entryIndex: 1 }, { ...payload, target: "wrong" }]) {
        assert.ok([403, 409].includes((await app.inject({ method: "DELETE", url, payload: altered })).statusCode))
        assert.equal(await readFile(f.globalFile, "utf8"), original)
      }
      for (const expectedRevision of [undefined, "x", "SECRET_SENTINEL"]) {
        assert.equal((await app.inject({ method: "DELETE", url, payload: { ...payload, expectedRevision } })).statusCode, 400)
      }
      f.state.current = false
      assert.equal((await app.inject({ method: "DELETE", url, payload })).statusCode, 503)
      f.state.current = true
      await writeFile(f.globalFile, "{ malformed SECRET_SENTINEL")
      const malformed = await app.inject({ method: "DELETE", url, payload })
      assert.equal(malformed.statusCode, 422)
      assert.equal(malformed.body.includes("SECRET_SENTINEL"), false)
      await writeFile(f.globalFile, original)
      if (process.platform !== "win32") {
        await chmod(f.globalFile, 0o600)
        payload = await request()
        await chmod(f.globalFile, 0o640)
        assert.equal((await app.inject({ method: "DELETE", url, payload })).statusCode, 409)
      }
      payload = await request()
      assert.equal((await app.inject({ method: "DELETE", url, payload })).statusCode, 200)
      const saved = await readFile(f.globalFile, "utf8")
      assert.ok(saved.startsWith('\uFEFF'))
      assert.match(saved, /\/\/ keep\r\n/)
      assert.deepEqual(parse(saved), { plugins: ["other", "-foo.id"], keep: true })
      assert.deepEqual(f.state.rpcCalls, [])
    } finally { await app.close(); await f.cleanup() }
  })

  it("withholds confirmation authority for watcher lag or normalized/raw options divergence", async () => {
    const f = await fixture()
    try {
      await writeFile(f.globalFile, JSON.stringify({ plugins: [{ package: "foo", options: { value: "new" } }] }))
      f.state.normalized = { plugins: [{ package: "foo", options: { value: "old" } }] }
      assert.equal(await revision(f), undefined)
      await assert.rejects(f.sources.remove("w", { location: f.location, scope: "global", target: "foo", entryIndex: 0, expectedRevision: undefined! }), code("stale"))
    } finally { await f.cleanup() }
  })

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
      assert.equal((await app.inject({ method: "DELETE", url, payload: { location: f.location, scope: "global", target: "x", entryIndex: 0,
        pluginId: "x", expectedRevision: "a".repeat(64) } })).statusCode, 400, "a source or an ID, never both")
      const local = await app.inject({ method: "POST", url, payload: { location: f.location, scope: "global", spec: "./local" } })
      assert.equal(local.statusCode, 422)
      assert.equal(local.json().code, "local-path")
      const added = await app.inject({ method: "POST", url, payload: { location: f.location, scope: "global", spec: "foo" } })
      assert.equal(added.statusCode, 200)
      const duplicate = await app.inject({ method: "POST", url, payload: { location: f.location, scope: "project", spec: "foo@2" } })
      assert.equal(duplicate.statusCode, 409)
      assert.equal(duplicate.json().code, "duplicate")
      const expectedRevision = await revision(f)
      const stale = await app.inject({ method: "DELETE", url, payload: { location: f.location, scope: "global", target: "bar", entryIndex: 0, expectedRevision } })
      assert.equal(stale.statusCode, 409)
      assert.equal(stale.json().code, "stale")
      const removed = await app.inject({ method: "DELETE", url, payload: { location: f.location, scope: "global", target: "foo", entryIndex: 0, expectedRevision } })
      assert.equal(removed.statusCode, 200)
      assert.deepEqual(parse(await readFile(f.globalFile, "utf8")).plugins, [])
    } finally { await app.close(); await f.cleanup() }
  })
})
