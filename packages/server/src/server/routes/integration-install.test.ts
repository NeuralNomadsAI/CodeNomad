import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import Fastify from "fastify"
import { parse } from "jsonc-parser"
import pino from "pino"
import { registerRequestLogging } from "../request-logging"
import type { IntegrationCatalogView } from "../../opencode/integrations/catalog"
import { catalogEntry, catalogOf } from "../../opencode/integrations/catalog-fixture"
import { IntegrationInstaller } from "../../opencode/integrations/install"
import { PluginControls } from "../../opencode/plugin-controls"
import { PluginSources } from "../../opencode/plugin-sources"
import { registerIntegrationInstallRoutes } from "./integration-install"

const NATIVE = "@neuralnomads/opencode-fixture@^0.1"
const API = "@neuralnomads/opencode-mail@^0.1"
const GIT = "github:NeuralNomadsAI/opencode-integrations#"
const catalog = catalogOf(catalogEntry("fixture", { sources: { git: [GIT] } }), catalogEntry("mail", { family: "api" }))

it("explicit projects refuse installation before connection, catalog or config access", async () => {
  let reads = 0
  const unexpected = async () => { reads++; throw new Error("Unexpected host work") }
  const installer = new IntegrationInstaller({
    workspaceManager: { requireWorkspaceCapability: () => { throw new Error("Explicit host controls unavailable") },
      getSharedServiceConnection: unexpected, ownsLocation: unexpected },
    controls: { read: unexpected }, catalog: { read: unexpected }, sources: { add: unexpected },
  })
  await assert.rejects(installer.install("remote", "fixture", { directory: "/repo" }, "global"), { code: "forbidden" })
  assert.equal(reads, 0)
})

/** Real route, installer, plugin sources and configuration documents on disk, with a fake native connection. */
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "integration-install-"))
  const global = path.join(root, "global"), project = path.join(root, "project")
  await mkdir(global, { recursive: true })
  await mkdir(path.join(project, ".opencode"), { recursive: true })
  const globalFile = path.join(global, "opencode.jsonc"), projectFile = path.join(project, ".opencode", "opencode.jsonc")
  const state = {
    runtime: [] as unknown[], hideProject: false, current: true, owns: (_call: number) => true, ownership: 0,
    catalog: { state: "fresh", fetchedAt: "2026-11-01T00:00:00.000Z", catalog } as IntegrationCatalogView,
    afterWrite: undefined as (() => void) | undefined, rpcCalls: 0, adds: 0,
    beforeAdd: undefined as (() => Promise<void>) | undefined,
  }
  const documentEntry = async (file: string) => readFile(file, "utf8").then(text => [{ type: "document", path: file, info: parse(text) }], () => [])
  const connection = {
    assertCurrent: () => { if (!state.current) throw new Error(`replaced connection ${root}`) },
    client: {
      config: { get: async () => [{ type: "directory", path: global }, ...await documentEntry(globalFile),
        ...(state.hideProject ? [] : await documentEntry(projectFile))] },
      plugin: { list: async () => ({ data: state.runtime }) },
      rpc: { call: async () => { state.rpcCalls += 1; throw new Error("installation never calls an integration") } },
    },
  }
  const manager = {
    requireWorkspaceCapability: () => new AbortController().signal,
    get: (id: string) => id === "w" ? {} : undefined,
    getSharedServiceConnection: async () => connection,
    getServiceDirectoryForPath: async (_id: string, directory: string) => directory === project ? directory : undefined,
    ownsLocation: async () => state.owns(state.ownership++),
    getWorktreeIdentityForPath: async () => "owned",
    getServicePathStyle: () => process.platform === "win32" ? "win32" : "posix",
    getServiceWslDistro: () => undefined,
    getHostPathForServicePath: async (_id: string, value: string) => value,
  }
  const logs: string[] = []
  const logger = pino({ level: "trace" }, { write: (line: string) => { logs.push(line) } })
  const controls = new PluginControls({ workspaceManager: manager as never, worktreeDeletionFence: { enter: () => () => {} }, logger })
  const sources = new PluginSources({ documents: controls, logger, catalog: { read: async () => state.catalog } })
  const add = sources.add.bind(sources)
  sources.add = async (...args) => { await state.beforeAdd?.(); const result = await add(...args); state.afterWrite?.(); return result }
  const installer = new IntegrationInstaller({ controls, workspaceManager: manager as never, catalog: { read: async () => state.catalog }, sources })
  // Production disables Fastify's own logging; its completion hook and route warnings use the API logger.
  const app = Fastify({ logger: false, disableRequestLogging: true })
  registerRequestLogging(app, logger)
  app.addHook("onRequest", async request => { request.log = logger })
  registerIntegrationInstallRoutes(app, { installer })
  const install = (integration: string, payload: unknown, query = `directory=${encodeURIComponent(project)}`) =>
    app.inject({ method: "POST", url: `/api/workspaces/w/integrations/${integration}/install?${query}`, payload: payload as never })
  const plugins = async (file: string) => readFile(file, "utf8").then(text => parse(text).plugins as unknown[], () => undefined)
  return { root, project, globalFile, projectFile, state, logs, install, plugins,
    cleanup: async () => { await app.close(); await rm(root, { recursive: true, force: true }) } }
}

function assertQuietLogs(f: Awaited<ReturnType<typeof fixture>>, expected: string[] = [], forbidden: string[] = []) {
  const text = f.logs.join("\n")
  for (const value of forbidden) assert.equal(text.includes(value), false, `logs never contain the client value ${value}`)
  // Positive controls: the capture sees the completion records and every expected message.
  assert.match(text, /"url":"\/api\/workspaces\/:id\/integrations\/:integrationId\/install"/)
  for (const message of expected) assert.equal(text.includes(message), true, `logs contain ${message}`)
  for (const secret of [f.root, f.project, f.globalFile, JSON.stringify(f.root).slice(1, -1), NATIVE, API, "^0.1", GIT]) {
    assert.equal(text.includes(secret), false, `logs never contain ${secret}`)
  }
}

describe("integration install route", () => {
  it("writes the catalog's `<package>@<range>` through the plugin sources in the requested scope", async () => {
    const f = await fixture()
    try {
      await writeFile(f.globalFile, '{\n  // keep\n  "plugins": ["other-plugin"]\n}\n')
      const response = await f.install("fixture", { scope: "global" })
      assert.equal(response.statusCode, 200)
      assert.equal(response.headers["cache-control"], "no-store")
      assert.deepEqual(response.json(), { scope: "global", spec: NATIVE, reloadPending: true })
      assert.match(await readFile(f.globalFile, "utf8"), /\/\/ keep/)
      assert.deepEqual(await f.plugins(f.globalFile), ["other-plugin", NATIVE])
      const project = await f.install("mail", { scope: "project" })
      assert.deepEqual(project.json(), { scope: "project", spec: API, reloadPending: true })
      assert.deepEqual(await f.plugins(f.projectFile), [API])
      assert.equal(f.state.rpcCalls, 0)
      assertQuietLogs(f, ["Added OpenCode plugin source"])
    } finally { await f.cleanup() }
  })

  it("installs from a valid stale catalog, and answers 503 without a catalog and 404 for an unknown ID", async () => {
    const f = await fixture()
    try {
      f.state.catalog = { state: "unavailable", catalog: catalogOf() }
      const unavailable = await f.install("fixture", { scope: "global" })
      assert.equal(unavailable.statusCode, 503)
      assert.deepEqual(unavailable.json(), { error: "Integration install unavailable", code: "unavailable" })
      f.state.catalog = { state: "stale", fetchedAt: "2026-10-01T00:00:00.000Z", catalog }
      const unknown = await f.install("houdini", { scope: "global" })
      assert.equal(unknown.statusCode, 404)
      assert.equal(unknown.json().code, "not-found")
      assert.equal(await f.plugins(f.globalFile), undefined, "refusals write nothing")
      assert.deepEqual((await f.install("fixture", { scope: "global" })).json(), { scope: "global", spec: NATIVE, reloadPending: true })
      assert.deepEqual(await f.plugins(f.globalFile), [NATIVE])
      assertQuietLogs(f, ["Added OpenCode plugin source", "Integration install refused"])
    } finally { await f.cleanup() }
  })

  it("refuses a native integration in Project with 422 and no write", async () => {
    const f = await fixture()
    try {
      const response = await f.install("fixture", { scope: "project" })
      assert.equal(response.statusCode, 422)
      assert.equal(response.json().code, "global-only")
      assert.equal(await f.plugins(f.projectFile), undefined)
      assert.equal(await f.plugins(f.globalFile), undefined)
    } finally { await f.cleanup() }
  })

  it("refuses a declared package in either scope and form, a loaded plugin and an ambiguous recognition with 409", async () => {
    const cases: Array<{ name: string; global?: unknown[]; project?: unknown[]; runtime?: unknown[]; hideProject?: boolean; integration?: string; scope?: string; code?: string }> = [
      { name: "declared in Global", global: ["@neuralnomads/opencode-fixture@0.1.0"] },
      { name: "declared in Project, installing Global", project: ["@neuralnomads/opencode-fixture"] },
      { name: "an object declaration", global: [{ package: "@neuralnomads/opencode-mail", options: { a: 1 } }], integration: "mail", scope: "project" },
      { name: "a Git declaration", global: [`${GIT}main::path:integrations/fixture/plugin`] },
      { name: "an npm alias", project: ["mailer@npm:@neuralnomads/opencode-mail@0.1.0"], integration: "mail" },
      { name: "a write the daemon has not reloaded", project: ["@neuralnomads/opencode-mail"], hideProject: true, integration: "mail" },
      { name: "loaded from a local build", runtime: [{ id: "neuralnomads.fixture", source: { type: "local", path: "/builds/fixture/index.js" }, features: {}, state: { status: "active" } }] },
      { name: "failed while loading", global: ["@neuralnomads/opencode-fixture"],
        runtime: [{ source: { type: "package", target: "@neuralnomads/opencode-fixture" }, features: {}, state: { status: "failed", error: "boom" } }] },
      { name: "a source of two integrations", global: ["@neuralnomads/opencode-mail"], code: "ambiguous",
        runtime: [{ id: "neuralnomads.fixture", source: { type: "package", target: "@neuralnomads/opencode-mail" }, features: {}, state: { status: "active" } }] },
      { name: "two loaded copies", code: "ambiguous", runtime: Array.from({ length: 2 }, (_, index) => ({ id: "neuralnomads.fixture",
        source: { type: "local", path: `/builds/fixture-${index}/index.js` }, features: {}, state: { status: "active" } })) },
    ]
    for (const item of cases) {
      const f = await fixture()
      try {
        if (item.global) await writeFile(f.globalFile, JSON.stringify({ plugins: item.global }))
        if (item.project) await writeFile(f.projectFile, JSON.stringify({ plugins: item.project }))
        const before = [await readFile(f.globalFile, "utf8").catch(() => undefined), await readFile(f.projectFile, "utf8").catch(() => undefined)]
        f.state.runtime = item.runtime ?? []
        f.state.hideProject = item.hideProject ?? false
        const response = await f.install(item.integration ?? "fixture", { scope: item.scope ?? "global" })
        assert.equal(response.statusCode, 409, item.name)
        assert.equal(response.json().code, item.code ?? "duplicate", item.name)
        assert.deepEqual([await readFile(f.globalFile, "utf8").catch(() => undefined), await readFile(f.projectFile, "utf8").catch(() => undefined)], before, item.name)
        assertQuietLogs(f, ["Integration install refused"])
      } finally { await f.cleanup() }
    }
  })

  it("maps a duplicate found by the serialized add queue to 409", async () => {
    const f = await fixture()
    try {
      // Both requests pass recognition before either writes; the queue refuses the second whatever its scope.
      let release!: () => void
      const gate = new Promise<void>(resolve => { release = resolve })
      // The first add waits for the second to arrive (bounded, so a missing arrival fails the count below).
      f.state.beforeAdd = async () => { if (++f.state.adds === 2) release(); await Promise.race([gate, delay(5_000, undefined, { ref: false })]) }
      const [first, second] = await Promise.all([f.install("mail", { scope: "global" }), f.install("mail", { scope: "project" })])
      assert.equal(f.state.adds, 2, "both requests reached the add queue")
      assert.deepEqual([first.statusCode, second.statusCode].sort(), [200, 409])
      assert.equal([first, second].find(response => response.statusCode === 409)!.json().code, "duplicate")
      assert.deepEqual([...await f.plugins(f.globalFile) ?? [], ...await f.plugins(f.projectFile) ?? []], [API])
      assertQuietLogs(f, ["Added OpenCode plugin source", "Integration install refused"])
    } finally { await f.cleanup() }
  })

  it("reinstalls after a removal that kept `id` and `-id` rules, preserving them", async () => {
    for (const rules of [["-neuralnomads.fixture"], ["neuralnomads.fixture"], ["-neuralnomads.fixture", "neuralnomads.fixture"]]) {
      const f = await fixture()
      try {
        await writeFile(f.globalFile, JSON.stringify({ plugins: rules, keep: true }))
        const response = await f.install("fixture", { scope: "global" })
        assert.equal(response.statusCode, 200, rules.join())
        assert.deepEqual(parse(await readFile(f.globalFile, "utf8")), { plugins: [...rules, NATIVE], keep: true })
      } finally { await f.cleanup() }
    }
  })

  it("refuses an extra field, a spec, a path, an option or a malformed request with 400 and no write", async () => {
    const f = await fixture()
    try {
      const directory = `directory=${encodeURIComponent(f.project)}`
      for (const [payload, query, integration] of [
        [{ scope: "global", spec: "evil@1" }], [{ scope: "global", path: "/tmp/x" }], [{ scope: "global", options: { a: 1 } }],
        [{ scope: "global", expectedRevision: "a".repeat(64) }], [{}], [{ scope: "inline" }], [undefined], [["global"]],
        [{ scope: "global" }, `${directory}&workspaceID=other`], [{ scope: "global" }, `${directory}&spec=evil`], [{ scope: "global" }, ""],
        [{ scope: "global" }, directory, "Fixture"], [{ scope: "global" }, directory, "fixture%2F..%2Fother"],
      ] as Array<[unknown, string?, string?]>) {
        const response = await f.install(integration ?? "fixture", payload, query ?? directory)
        assert.equal(response.statusCode, 400, JSON.stringify([payload, query, integration]))
        assert.deepEqual(response.json(), { error: "Invalid integration install request", code: "invalid" })
      }
      assert.equal(await f.plugins(f.globalFile), undefined)
      assert.equal(await f.plugins(f.projectFile), undefined)
      assertQuietLogs(f, [], ["evil", "/tmp/x", "workspaceID", "expectedRevision", "inline"])
    } finally { await f.cleanup() }
  })

  it("checks Location ownership and the connection before writing and again after", async () => {
    const f = await fixture()
    try {
      const outside = await f.install("fixture", { scope: "global" }, `directory=${encodeURIComponent(path.join(f.root, "elsewhere"))}`)
      assert.equal(outside.statusCode, 403)
      for (const [integration, scope] of [["houdini", "global"], ["fixture", "project"]]) {
        const response = await f.install(integration, { scope }, `directory=${encodeURIComponent(path.join(f.root, "elsewhere"))}`)
        assert.equal(response.statusCode, 403, "ownership is refused before any catalog-derived answer")
      }
      f.state.owns = call => call === 0
      const disowned = await f.install("fixture", { scope: "global" })
      assert.deepEqual([disowned.statusCode, disowned.json().code], [403, "forbidden"])
      assert.equal(await f.plugins(f.globalFile), undefined, "ownership lost before the write writes nothing")
      f.state.owns = () => true
      f.state.current = false
      const replaced = await f.install("fixture", { scope: "global" })
      assert.deepEqual([replaced.statusCode, replaced.json().code], [503, "unavailable"])
      assert.equal(await f.plugins(f.globalFile), undefined)
      f.state.current = true
      // After the write the answer is refused, leaving an outcome the client reconciles by a new read.
      f.state.afterWrite = () => { f.state.current = false }
      const replacedAfter = await f.install("fixture", { scope: "global" })
      assert.deepEqual([replacedAfter.statusCode, replacedAfter.json().code], [503, "uncertain"], "a refusal after the write is uncertain")
      assert.deepEqual(await f.plugins(f.globalFile), [NATIVE])
      f.state.afterWrite = undefined
      f.state.current = true
      await writeFile(f.globalFile, "{}")
      let after = false
      f.state.afterWrite = () => { after = true }
      f.state.owns = () => !after
      const disownedAfter = await f.install("fixture", { scope: "global" })
      assert.deepEqual([disownedAfter.statusCode, disownedAfter.json().code], [503, "uncertain"])
      assert.deepEqual(await f.plugins(f.globalFile), [NATIVE])
      assertQuietLogs(f, ["Added OpenCode plugin source", "Integration install refused"])
    } finally { await f.cleanup() }
  })
})
