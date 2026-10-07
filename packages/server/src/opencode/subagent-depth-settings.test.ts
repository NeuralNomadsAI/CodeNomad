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
    await writeFile(projectFile, '\uFEFF{\r\n\t// preserved\r\n\t"experimental":{"foreign":true},\r\n\t"shell":"keep"\r\n}\r\n')
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
    assert.equal(snapshot.effectiveDepth, 2)
    assert.equal(snapshot.project?.depth, null)
    assert.equal(snapshot.project?.path, projectFile)
    await settings.update("w", location, 0, snapshot.project!.expectation)
    const saved = await readFile(projectFile, "utf8")
    assert.ok(saved.startsWith("\uFEFF")); assert.match(saved, /\r\n\t\/\/ preserved/)
    assert.deepEqual(parse(saved.slice(1)).experimental, { foreign: true, subagent_depth: 0 })
    assert.equal(parse(saved.slice(1)).shell, "keep")
    assert.equal((await settings.read("w", location)).effectiveDepth, 0)
    await assert.rejects(settings.update("w", location, 3, snapshot.project!.expectation), /changed/)
    let fresh = await settings.read("w", location)
    await writeFile(projectFile, saved.replace('"keep"', '"external"'))
    await assert.rejects(settings.update("w", location, 3, fresh.project!.expectation), /changed/)
    fresh = await settings.read("w", location)
    await settings.update("w", location, null, fresh.project!.expectation)
    assert.equal((await settings.read("w", location)).effectiveDepth, 2)
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
    await writeFile(globalFile, "{}")
    await writeFile(projectFile, "{}")
    assert.equal((await settings.read("w", location)).effectiveDepth, null, "missing default stays unknown")
  } finally { await app.close(); await rm(root, { recursive: true, force: true }) }
})
