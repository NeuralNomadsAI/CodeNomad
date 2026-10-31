import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import Fastify from "fastify"
import { parse } from "jsonc-parser"
import { PluginControls } from "./plugin-controls"
import { SubagentDepthSettings, subagentDepthCapability } from "./subagent-depth-settings"
import { registerSubagentDepthSettingsRoutes } from "../server/routes/subagent-depth-settings"

const contract = (value: unknown) => ({ components: { schemas: { "Config.InfoEncoded": {
  properties: { experimental: { properties: { subagent_depth: value } } },
} } } })

test("depth capability uses the actual integer contract, never a version or assumed default", () => {
  assert.deepEqual(subagentDepthCapability(contract({ type: "integer", minimum: 0 })), { minimum: 0 })
  assert.deepEqual(subagentDepthCapability(contract({ type: "integer", minimum: 0, maximum: 3, default: 1 })), { minimum: 0, maximum: 3, default: 1 })
  for (const value of [undefined, { type: "number", minimum: 0 }, { type: "integer" },
    { type: "integer", minimum: 0, maximum: 0.5 }, { type: "integer", minimum: 0, maximum: 2, default: 3 }])
    assert.equal(subagentDepthCapability(contract(value)), null)
})

test("owned depth editing preserves JSONC, inherited settings and original draft authority", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "subagent-depth-"))
  const app = Fastify()
  try {
    const global = path.join(root, "global"), project = path.join(root, "project")
    await mkdir(global); await mkdir(project)
    const globalFile = path.join(global, "opencode.jsonc"), projectFile = path.join(project, "opencode.jsonc")
    await writeFile(globalFile, '{"experimental":{"subagent_depth":2}}')
    await writeFile(projectFile, '\uFEFF{\r\n\t// preserved\r\n\t"experimental":{"portable_shell_scanner":false},\r\n\t"shell":"keep"\r\n}\r\n')
    let current = true, owned = true, blocked = false, supported = true, schemaReads = 0
    const connection: any = { endpoint: { url: "http://127.0.0.1:1234", auth: { type: "basic", username: "fixture", password: "private" } },
      assertCurrent: () => { if (!current) throw new Error("replaced") },
      fetch: async (url: URL, options: RequestInit) => {
        schemaReads++
        assert.equal(url.pathname, "/openapi.json")
        assert.equal(options.redirect, "error")
        assert.ok(options.headers && options.signal)
        return Response.json(supported ? contract({ type: "integer", minimum: 0, maximum: 5 }) : {})
      },
      client: { config: { get: async () => [ { type: "directory", path: global },
        { type: "document", path: globalFile, info: parse(await readFile(globalFile, "utf8")) },
        { type: "document", path: projectFile, info: parse((await readFile(projectFile, "utf8")).replace(/^\uFEFF/, "")) } ] },
      plugin: { list: async () => ({ data: [] }) } },
    }
    const manager: any = {
      get: () => ({}), getSharedServiceConnection: async () => connection,
      getServiceDirectoryForPath: async (_id: string, directory: string) => directory === project ? directory : undefined,
      ownsLocation: async () => owned, getWorktreeIdentityForPath: async () => "owned",
      getServicePathStyle: () => process.platform === "win32" ? "win32" : "posix",
      getServiceWslDistro: () => undefined, getHostPathForServicePath: async (_id: string, value: string) => value,
    }
    const controls = new PluginControls({ workspaceManager: manager,
      worktreeDeletionFence: { enter: () => blocked ? undefined : () => {} }, logger: {} as any })
    const settings = new SubagentDepthSettings(controls, manager), location = { directory: project }
    registerSubagentDepthSettingsRoutes(app, settings)
    const snapshot = await settings.read("w", location)
    assert.equal(snapshot.effectiveDepth, null, "the project's own experimental block hides the global depth, as natively")
    assert.equal(snapshot.project?.depth, null)
    assert.equal(snapshot.project?.path, projectFile)
    await settings.update("w", location, 0, snapshot.project!.expectation)
    const saved = await readFile(projectFile, "utf8")
    assert.ok(saved.startsWith("\uFEFF")); assert.match(saved, /\r\n\t\/\/ preserved/)
    assert.deepEqual(parse(saved.slice(1)).experimental, { portable_shell_scanner: false, subagent_depth: 0 })
    assert.equal(parse(saved.slice(1)).shell, "keep")
    assert.equal((await settings.read("w", location)).effectiveDepth, 0)
    await assert.rejects(settings.update("w", location, 3, snapshot.project!.expectation), /changed/)
    let fresh = await settings.read("w", location)
    await writeFile(projectFile, saved.replace('"keep"', '"external"'))
    await assert.rejects(settings.update("w", location, 3, fresh.project!.expectation), /changed/)
    fresh = await settings.read("w", location)
    await settings.update("w", location, null, fresh.project!.expectation)
    assert.deepEqual(parse((await readFile(projectFile, "utf8")).slice(1)).experimental, { portable_shell_scanner: false }, "inheriting keeps other experimental settings")
    assert.equal((await settings.read("w", location)).effectiveDepth, null)
    for (const value of [-1, 0.5, 6, NaN]) await assert.rejects(settings.update("w", location, value, fresh.project!.expectation))
    fresh = await settings.read("w", location)
    blocked = true
    await assert.rejects(settings.update("w", location, 3, fresh.project!.expectation), /deletion/)
    blocked = false; owned = false
    const reads = schemaReads
    await assert.rejects(settings.read("w", location), /owned/)
    assert.equal(schemaReads, reads, "unowned reads never request the schema")
    owned = true; supported = false
    assert.equal((await settings.read("w", location)).capability, null)
    await assert.rejects(settings.update("w", location, 3, fresh.project!.expectation), /unavailable/)
    supported = true; current = false
    await assert.rejects(settings.update("w", location, 3, fresh.project!.expectation))
    current = true
    const url = "/api/workspaces/w/subagent-depth"
    for (const extra of [{ scope: "global" }, { path: globalFile }, { keys: ["permissions"] }]) {
      assert.equal((await app.inject({ method: "PUT", url, payload: {
        location, depth: 1, expectation: fresh.project!.expectation, ...extra,
      } })).statusCode, 400)
    }
    await writeFile(projectFile, '{"experimental":{"subagent_depth":1,"subagent_depth":2}}')
    await assert.rejects(settings.read("w", location), /duplicate/)
    // An empty project block hides the global depth and is flagged; Inherit removes it, keeping its comments.
    await writeFile(projectFile, '{\n  "experimental": {\n    // keep me\n  }\n}\n')
    const masked = await settings.read("w", location)
    assert.equal(masked.effectiveDepth, null)
    assert.equal(masked.project?.depth, null)
    assert.equal(masked.project?.emptyExperimental, true)
    await settings.update("w", location, null, masked.project!.expectation)
    const repaired = await readFile(projectFile, "utf8")
    assert.equal(parse(repaired).experimental, undefined)
    assert.match(repaired, /keep me/)
    const inherited = await settings.read("w", location)
    assert.equal(inherited.effectiveDepth, 2)
    assert.equal(inherited.project?.emptyExperimental, undefined)
    await settings.update("w", location, 3, inherited.project!.expectation)
    await settings.update("w", location, null, (await settings.read("w", location)).project!.expectation)
    assert.equal(parse(await readFile(projectFile, "utf8")).experimental, undefined, "an override cleared to Inherit leaves no empty block")
    await writeFile(globalFile, "{}")
    await writeFile(projectFile, "{}")
    assert.equal((await settings.read("w", location)).effectiveDepth, null, "missing default stays unknown")
  } finally { await app.close(); await rm(root, { recursive: true, force: true }) }
})

/** A project and Global document under a simulated native runtime whose General rules resolve as OpenCode
 * does: the base policy and the built-in denial, every document's top-level rules, then every document's
 * General rules. */
async function nestingFixture(run: (fixture: {
  app: ReturnType<typeof Fastify>; project: string; projectFile: string; globalFile: string; native: { agents: boolean }
  save: (value: number | null) => Promise<void>; saved: () => Promise<any>; nesting: () => Promise<unknown>
}) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "subagent-depth-nesting-"))
  const app = Fastify()
  try {
    const global = path.join(root, "global"), project = path.join(root, "project")
    await mkdir(global); await mkdir(project)
    const globalFile = path.join(global, "opencode.jsonc"), projectFile = path.join(project, "opencode.jsonc")
    await writeFile(globalFile, "{}"); await writeFile(projectFile, '{\n  // kept\n  "shell": "keep"\n}\n')
    const native = { agents: true }
    const entries = async () => [{ type: "document", path: globalFile, info: parse(await readFile(globalFile, "utf8")) },
      { type: "directory", path: global }, { type: "document", path: projectFile, info: parse(await readFile(projectFile, "utf8")) }]
    const resolve = async () => {
      const documents = (await entries()).filter((entry: any) => entry.type === "document") as any[]
      return [{ action: "*", resource: "*", effect: "allow" }, { action: "question", resource: "*", effect: "deny" },
        { action: "subagent", resource: "*", effect: "deny" }, ...documents.flatMap(entry => entry.info.permissions ?? []),
        ...documents.flatMap(entry => entry.info.agents?.general?.permissions ?? [])]
    }
    const connection: any = { endpoint: { url: "http://127.0.0.1:1234", auth: { type: "basic", username: "fixture", password: "private" } },
      assertCurrent: () => {}, fetch: async () => Response.json(contract({ type: "integer", minimum: 0, default: 1 })),
      client: { config: { get: entries }, plugin: { list: async () => ({ data: [] }) }, agent: { list: async () => {
        if (!native.agents) throw new Error("unavailable")
        return { data: [{ id: "build", permissions: [] }, { id: "general", permissions: await resolve() }] }
      } } },
    }
    const manager: any = {
      get: () => ({}), getSharedServiceConnection: async () => connection,
      getServiceDirectoryForPath: async (_id: string, directory: string) => directory === project ? directory : undefined,
      ownsLocation: async () => true, getWorktreeIdentityForPath: async () => "owned",
      getServicePathStyle: () => process.platform === "win32" ? "win32" : "posix",
      getServiceWslDistro: () => undefined, getHostPathForServicePath: async (_id: string, value: string) => value,
    }
    const controls = new PluginControls({ workspaceManager: manager, worktreeDeletionFence: { enter: () => () => {} }, logger: {} as any })
    const settings = new SubagentDepthSettings(controls, manager), location = { directory: project }
    registerSubagentDepthSettingsRoutes(app, settings)
    await run({ app, project, projectFile, globalFile, native,
      save: async value => settings.update("w", location, value, (await settings.read("w", location)).project!.expectation),
      saved: async () => parse(await readFile(projectFile, "utf8")),
      nesting: async () => (await settings.read("w", location)).nesting })
  } finally { await app.close(); await rm(root, { recursive: true, force: true }) }
}
const rule = (action: string, resource: string, effect: string) => ({ action, resource, effect })
const allowRule = { general: { permissions: [rule("subagent", "*", "allow")] } }

test("any project depth override writes CodeNomad's marked rule once, and Inherit removes only that rule", () => nestingFixture(async ({
  app, project, projectFile, save, saved, nesting,
}) => {
  const original = await readFile(projectFile, "utf8")
  assert.deepEqual(await nesting(), { effect: "deny" }, "OpenCode's built-in rule stops General")
  for (const value of [1, 0, 3]) {
    await save(value)
    assert.deepEqual((await saved()).agents, allowRule, `depth ${value} writes the rule once`)
    assert.equal((await saved()).experimental.subagent_depth, value)
  }
  assert.match(await readFile(projectFile, "utf8"), /\/\/ kept[\s\S]*\/\/ Added by CodeNomad with the project subagent depth; Inherit removes it\./)
  assert.deepEqual(await nesting(), { effect: "allow" })
  const reply = await app.inject({ method: "GET", url: `/api/workspaces/w/subagent-depth?directory=${encodeURIComponent(project)}` })
  assert.deepEqual(reply.json().nesting, { effect: "allow" })
  await save(null)
  assert.equal(await readFile(projectFile, "utf8"), original, "Inherit removes the depth and the rule, restoring the file")
  assert.deepEqual(await nesting(), { effect: "deny" })
}))

test("the override writes the rule whatever else decides, and Inherit leaves every other rule", () => nestingFixture(async ({
  projectFile, globalFile, native, save, saved, nesting,
}) => {
  // A Global General denial stays; the project rule, resolved after it, wins.
  const denial = JSON.stringify({ agents: { general: { permissions: [rule("subagent", "*", "deny")] } } })
  await writeFile(globalFile, denial)
  await save(2)
  assert.deepEqual((await saved()).agents, allowRule)
  assert.deepEqual(await nesting(), { effect: "allow" })
  assert.equal(await readFile(globalFile, "utf8"), denial, "the Global document is never edited")
  await save(null)
  assert.deepEqual(await nesting(), { effect: "deny" })
  await writeFile(globalFile, "{}")
  // An unreadable agent list reports nothing and changes nothing written.
  native.agents = false
  await save(2)
  assert.deepEqual((await saved()).agents, allowRule)
  assert.equal(await nesting(), null)
  native.agents = true
  await save(null)
  // The user's own identical rule is not CodeNomad's: an override adds the marked one, Inherit removes only that.
  const own = '{ "agents": { "general": { "permissions": [{ "action": "subagent", "resource": "*", "effect": "allow" }] } } }\n'
  await writeFile(projectFile, own)
  await save(3)
  assert.equal((await saved()).agents.general.permissions.length, 2)
  await save(null)
  assert.deepEqual(await saved(), parse(own))
}))

test("Inherit removes a block left with only the Global image storage, only when that is certain", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "subagent-depth-media-"))
  try {
    const global = path.join(root, "global"), project = path.join(root, "project")
    await mkdir(global); await mkdir(project)
    const globalFile = path.join(global, "opencode.jsonc"), projectFile = path.join(project, "opencode.jsonc")
    await writeFile(globalFile, '{"experimental":{"subagent_depth":2,"media_blob":true}}')
    await writeFile(projectFile, '{\n  // kept\n  "shell": "keep"\n}\n')
    let media = true, staleGlobal: unknown
    const connection: any = { endpoint: { url: "http://127.0.0.1:1234", auth: { type: "basic", username: "fixture", password: "private" } },
      assertCurrent: () => {},
      fetch: async () => Response.json({ components: { schemas: { "Config.InfoEncoded": { properties: { experimental: { properties: {
        subagent_depth: { type: "integer", minimum: 0 }, ...(media ? { media_blob: { type: "boolean" } } : {}),
      } } } } } } }),
      client: { config: { get: async () => [
        { type: "document", path: globalFile, info: staleGlobal ?? parse(await readFile(globalFile, "utf8")) },
        { type: "directory", path: global },
        { type: "document", path: projectFile, info: parse((await readFile(projectFile, "utf8")).replace(/^﻿/, "")) } ] },
      plugin: { list: async () => ({ data: [] }) } },
    }
    const manager: any = {
      get: () => ({}), getSharedServiceConnection: async () => connection,
      getServiceDirectoryForPath: async (_id: string, directory: string) => directory === project ? directory : undefined,
      ownsLocation: async () => true, getWorktreeIdentityForPath: async () => "owned",
      getServicePathStyle: () => process.platform === "win32" ? "win32" : "posix",
      getServiceWslDistro: () => undefined, getHostPathForServicePath: async (_id: string, value: string) => value,
    }
    const controls = new PluginControls({ workspaceManager: manager, worktreeDeletionFence: { enter: () => () => {} }, logger: {} as any })
    const settings = new SubagentDepthSettings(controls, manager), location = { directory: project }
    const save = async (value: number | null) => settings.update("w", location, value, (await settings.read("w", location)).project!.expectation)
    const experimental = async () => parse((await readFile(projectFile, "utf8")).replace(/^﻿/, "")).experimental

    // A depth is written as it is; Images, not the depth editor, writes storage into the block.
    await save(3)
    assert.match(await readFile(projectFile, "utf8"), /\/\/ kept/)
    assert.deepEqual(await experimental(), { subagent_depth: 3 })
    await writeFile(projectFile, '{ "experimental": { "subagent_depth": 3, "media_blob": true } }')
    assert.equal((await settings.read("w", location)).project?.emptyExperimental, undefined)
    await save(null)
    assert.equal(await experimental(), undefined, "Inherit removes a block left with only the Global storage")
    assert.equal((await settings.read("w", location)).effectiveDepth, 2)

    // A block holding only the Global storage still hides the Global depth: flagged so Inherit repairs it.
    await writeFile(projectFile, '﻿{\r\n  "experimental": {\r\n    // keep me\r\n    "media_blob": true\r\n  },\r\n  "shell": "keep"\r\n}\r\n')
    assert.equal((await settings.read("w", location)).project?.emptyExperimental, true)
    await save(null)
    const repaired = await readFile(projectFile, "utf8")
    assert.ok(repaired.startsWith("﻿")); assert.match(repaired, /keep me/)
    assert.deepEqual(parse(repaired.slice(1)), { shell: "keep" })
    // A different project choice is the user's own and stays.
    await writeFile(projectFile, '{ "experimental": { "media_blob": false } }')
    assert.equal((await settings.read("w", location)).project?.emptyExperimental, undefined)
    await save(null)
    assert.deepEqual(await experimental(), { media_blob: false })
    // Uncertain exposure keeps the block, which hides nothing new: lagging or normalized native
    // entries, another deciding document, or a runtime without the setting.
    const kept = async (message: string) => {
      await writeFile(projectFile, '{ "experimental": { "subagent_depth": 3, "media_blob": true } }')
      await save(null)
      assert.deepEqual(await experimental(), { media_blob: true }, message)
    }
    staleGlobal = { experimental: { subagent_depth: 2, media_blob: false } }
    await kept("native entries lagging behind the Global document")
    staleGlobal = { experimental: { subagent_depth: 2 } }
    await kept("native entries that differ from the Global document in any way")
    staleGlobal = undefined
    await writeFile(globalFile, "{}")
    await kept("no Global experimental object below")
    await writeFile(globalFile, '{"experimental":{"subagent_depth":2,"media_blob":true}}')
    media = false
    await kept("a runtime without the setting")
  } finally { await rm(root, { recursive: true, force: true }) }
})
