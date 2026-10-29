import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import Fastify from "fastify"
import { parse } from "jsonc-parser"
import { PluginControls } from "./plugin-controls"
import { ImageSettings, imageGenerationSelection, imageSettingsCapability } from "./image-settings"
import { registerImageSettingsRoutes } from "../server/routes/image-settings"

const contract = (experimental: Record<string, unknown>) => ({ components: { schemas: { "Config.InfoEncoded": {
  properties: { experimental: { properties: experimental } },
} } } })
const both = { image_generate: { anyOf: [] }, media_blob: { type: "boolean" } }

test("image capabilities follow the configuration contract, never a version", () => {
  assert.deepEqual(imageSettingsCapability(contract(both)), { generation: true, mediaStorage: true })
  assert.deepEqual(imageSettingsCapability(contract({ media_blob: { type: "boolean" } })), { generation: false, mediaStorage: true })
  assert.deepEqual(imageSettingsCapability({}), { generation: false, mediaStorage: false })
})

test("image generation values read as OpenCode reads them", () => {
  for (const value of [undefined, false, null, "x", [], 1]) assert.equal(imageGenerationSelection(value), false)
  assert.equal(imageGenerationSelection(true), true)
  assert.equal(imageGenerationSelection({}), true)
  assert.equal(imageGenerationSelection({ model: "openai/gpt-image-2" }), "openai/gpt-image-2")
  assert.equal(imageGenerationSelection({ model: { providerID: "google", model: "imagen", variant: "hd" } }), "google/imagen#hd")
  assert.equal(imageGenerationSelection({ model: "not a ref" }), true, "an unreadable model still enables automatic selection")
})

test("global image settings edit JSONC in place and report project overrides", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "image-settings-"))
  const app = Fastify()
  try {
    const global = path.join(root, "global"), project = path.join(root, "project")
    await mkdir(global); await mkdir(project)
    const globalFile = path.join(global, "opencode.jsonc"), projectFile = path.join(project, "opencode.jsonc")
    await writeFile(globalFile, '{\n  // preserved\n  "experimental": { "subagent_depth": 2 },\n  "shell": "keep"\n}\n')
    await writeFile(projectFile, "{}")
    const ancestorFile = path.join(root, "opencode.json")
    const lowerFile = path.join(global, "opencode.json")
    let schema: Record<string, unknown> = both, modelReads = 0, catalogStatus = 200, ancestor: unknown, lower: unknown, staleGlobal: unknown
    let current = true, catalogFailure: "status" | "throw" | undefined
    const connection: any = { endpoint: { url: "http://127.0.0.1:1234", auth: { type: "basic", username: "fixture", password: "private" } },
      assertCurrent: () => { if (!current) throw new Error("replaced connection") },
      fetch: async (url: URL, options: RequestInit) => {
        assert.equal(options.redirect, "error")
        if (url.pathname === "/openapi.json") return Response.json(contract(schema))
        modelReads++
        assert.equal(url.pathname, "/api/model")
        assert.equal(url.searchParams.get("types"), "image")
        assert.equal(url.searchParams.get("location[directory]"), project)
        if (catalogFailure) { current = false; if (catalogFailure === "throw") throw new Error("transport") }
        if (catalogStatus !== 200 || catalogFailure) return new Response("unavailable", { status: catalogFailure ? 503 : catalogStatus })
        return Response.json({ location: { directory: project }, data: [
          { providerID: "openai", id: "gpt-image-2", name: "GPT Image 2" }, { providerID: "google", id: "imagen" }, { bad: true },
        ] })
      },
      client: { config: { get: async () => [ { type: "directory", path: global },
        ...(lower ? [{ type: "document", path: lowerFile, info: lower }] : []),
        { type: "document", path: globalFile, info: staleGlobal ?? parse(await readFile(globalFile, "utf8")) },
        ...(ancestor ? [{ type: "document", path: ancestorFile, info: ancestor }] : []),
        { type: "document", path: projectFile, info: parse(await readFile(projectFile, "utf8")) } ] },
      plugin: { list: async () => ({ data: [] }) } },
    }
    const manager: any = {
      get: () => ({}), getSharedServiceConnection: async () => connection,
      getServiceDirectoryForPath: async (_id: string, directory: string) => directory === project ? directory : undefined,
      ownsLocation: async () => true, getWorktreeIdentityForPath: async () => "owned",
      getServicePathStyle: () => process.platform === "win32" ? "win32" : "posix",
      getServiceWslDistro: () => undefined, getHostPathForServicePath: async (_id: string, value: string) => value,
    }
    const controls = new PluginControls({ workspaceManager: manager,
      worktreeDeletionFence: { enter: () => () => {} }, logger: {} as any })
    const settings = new ImageSettings(controls, manager), location = { directory: project }
    registerImageSettingsRoutes(app, settings)

    let snapshot = await settings.read("w", location)
    assert.deepEqual(snapshot.generation, { global: false, effective: false,
      models: [{ ref: "openai/gpt-image-2", name: "GPT Image 2" }, { ref: "google/imagen", name: "imagen" }] })
    assert.deepEqual(snapshot.mediaStorage, { global: false, effective: false })

    await settings.update("w", location, { generation: "openai/gpt-image-2" })
    await settings.update("w", location, { mediaStorage: true })
    let saved = await readFile(globalFile, "utf8")
    assert.match(saved, /\/\/ preserved/)
    assert.deepEqual(parse(saved), { experimental: { subagent_depth: 2, image_generate: { model: "openai/gpt-image-2" }, media_blob: true }, shell: "keep" })
    snapshot = await settings.read("w", location)
    assert.equal(snapshot.generation?.effective, "openai/gpt-image-2")
    assert.equal(snapshot.mediaStorage?.effective, true)

    // A higher `experimental` object hides the global storage choice, but not the per-field generation choice.
    await writeFile(projectFile, '{ "experimental": { "subagent_depth": 1 } }')
    snapshot = await settings.read("w", location)
    assert.equal(snapshot.generation?.effective, "openai/gpt-image-2")
    assert.equal(snapshot.generation?.override, undefined)
    assert.deepEqual(snapshot.mediaStorage, { global: true, effective: false, override: { path: projectFile } })
    await writeFile(projectFile, '{ "experimental": { "image_generate": false } }')
    snapshot = await settings.read("w", location)
    assert.equal(snapshot.generation?.effective, false)
    assert.deepEqual(snapshot.generation?.override, { path: projectFile })
    assert.equal(await readFile(projectFile, "utf8"), '{ "experimental": { "image_generate": false } }', "the project is never written")
    // The deciding document is reported wherever it lives, not only in the selected project's own file.
    await writeFile(projectFile, "{}")
    ancestor = { experimental: { image_generate: false } }
    snapshot = await settings.read("w", location)
    assert.equal(snapshot.generation?.effective, false)
    assert.deepEqual(snapshot.generation?.override, { path: ancestorFile })
    assert.deepEqual(snapshot.mediaStorage, { global: true, effective: false, override: { path: ancestorFile } })
    ancestor = undefined

    // Off is an explicit `false`, so a lower-priority document that enables it stays hidden.
    await settings.update("w", location, { generation: true })
    assert.equal(parse(await readFile(globalFile, "utf8")).experimental.image_generate, true)
    await settings.update("w", location, { generation: false })
    await settings.update("w", location, { mediaStorage: false })
    saved = await readFile(globalFile, "utf8")
    assert.deepEqual(parse(saved).experimental, { subagent_depth: 2, image_generate: false, media_blob: false })
    await assert.rejects(settings.update("w", location, { generation: "no slash" }), /Invalid/)

    // A failed model catalog leaves both choices readable.
    catalogStatus = 503
    snapshot = await settings.read("w", location)
    assert.equal(snapshot.generation?.models, null)
    assert.equal(snapshot.generation?.global, false)
    assert.deepEqual(snapshot.mediaStorage, { global: false, effective: false })
    catalogStatus = 200
    // A connection replaced while the catalog fails still fences the whole snapshot.
    for (const failure of ["status", "throw"] as const) {
      catalogFailure = failure
      await assert.rejects(settings.read("w", location), /replaced connection/)
      catalogFailure = undefined; current = true
    }

    // A new Global `experimental` object would hide a lower-priority one: reads say so and writes are refused.
    await writeFile(globalFile, '{ "shell": "keep" }')
    lower = { experimental: { subagent_depth: 7, todo: true } }
    snapshot = await settings.read("w", location)
    assert.deepEqual(snapshot.blockedBy, { path: lowerFile })
    assert.equal(snapshot.mediaStorage?.effective, false)
    for (const change of [{ generation: true }, { mediaStorage: true }] as const)
      await assert.rejects(settings.update("w", location, change), /hide inherited experimental/)
    assert.equal(await readFile(globalFile, "utf8"), '{ "shell": "keep" }')
    // A project's own object hides the lower Global one only here; other Locations still inherit it.
    await writeFile(projectFile, '{ "experimental": { "subagent_depth": 1 } }')
    assert.deepEqual((await settings.read("w", location)).blockedBy, { path: lowerFile })
    await assert.rejects(settings.update("w", location, { mediaStorage: true }), /hide inherited experimental/)
    await writeFile(projectFile, "{}")
    // A stale native entry for the target cannot authorize a write the fresh document would turn into a mask.
    staleGlobal = { experimental: { subagent_depth: 3 } }
    await assert.rejects(settings.update("w", location, { mediaStorage: true }), /hide inherited experimental/)
    assert.equal(await readFile(globalFile, "utf8"), '{ "shell": "keep" }')
    staleGlobal = undefined
    // Once the Global document has its own object, writes edit it without changing what it already hides.
    await writeFile(globalFile, '{ "experimental": {} }')
    snapshot = await settings.read("w", location)
    assert.equal(snapshot.blockedBy, undefined)
    await settings.update("w", location, { mediaStorage: true })
    assert.deepEqual(parse(await readFile(globalFile, "utf8")).experimental, { media_blob: true })
    lower = undefined

    // Without the contract, nothing is read from the model catalog and nothing is written.
    schema = {}
    const reads = modelReads
    snapshot = await settings.read("w", location)
    assert.equal(snapshot.generation, null)
    assert.equal(snapshot.mediaStorage, null)
    assert.equal(modelReads, reads)
    const before = await readFile(globalFile, "utf8")
    await assert.rejects(settings.update("w", location, { generation: true }), /no such image setting/)
    await assert.rejects(settings.update("w", location, { mediaStorage: true }), /no such image setting/)
    assert.equal(await readFile(globalFile, "utf8"), before)
    schema = both

    const url = "/api/workspaces/w/image-settings"
    for (const payload of [{ location, generation: true, mediaStorage: true }, { location, scope: "project", mediaStorage: true },
      { location, generation: "bad" }, { location, generation: "a/b\u0000" }, { location }])
      assert.equal((await app.inject({ method: "PUT", url, payload })).statusCode, 400, JSON.stringify(payload))
    assert.equal((await app.inject({ method: "PUT", url, payload: { location, mediaStorage: true } })).statusCode, 204)
    const response = await app.inject({ method: "GET", url: `${url}?directory=${encodeURIComponent(project)}` })
    assert.equal(response.statusCode, 200)
    assert.equal(response.json().mediaStorage.global, true)
  } finally { await app.close(); await rm(root, { recursive: true, force: true }) }
})
