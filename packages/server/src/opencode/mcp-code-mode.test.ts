import assert from "node:assert/strict"
import { test } from "node:test"
import { parse } from "jsonc-parser"
import Fastify from "fastify"
import { McpCodeMode } from "./mcp-code-mode"
import { registerMcpCodeModeRoutes } from "../server/routes/mcp-code-mode"
import { PluginControlsError } from "./plugin-controls"
import { PluginControls } from "./plugin-controls"
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

test("MCP source editing preserves whole-server precedence, substitutions and unrelated fields", async () => {
  let global = '{// retain\n"mcp":{"servers":{"same":{"type":"remote","url":"https://example.invalid","headers":{"secret":"{env:KEY}"},"codemode":false},"global-only":{"type":"local","command":["fixture"]}}},"shell":"unchanged"}'
  let project = '{"mcp":{"servers":{"same":{"type":"local","command":["fixture"],"disabled":true}}}}'
  const document = (text: string) => ({ text, byteOrderMark: false }) as any
  const settings = new McpCodeMode({
    readConfigDocuments: async () => ({ entries: [{ type: "document", info: parse(global) }, { type: "document", info: parse(project) }],
      documents: [{ scope: "global", path: "/global", document: document(global) }, { scope: "project", path: "/project", document: document(project) }] }) as any,
    editConfigDocument: async (_id, _location, scope, edit) => { if (scope === "global") global = edit(document(global)); else project = edit(document(project)) },
  })
  const location = { directory: "/project" }
  assert.equal((await settings.read("w", location)).find(item => item.server === "same")!.effective, true)
  await settings.update("w", location, "global", "same", true)
  assert.match(global, /retain/)
  assert.equal(parse(global).mcp.servers.same.headers.secret, "{env:KEY}")
  assert.equal(parse(global).shell, "unchanged")
  await settings.update("w", location, "project", "same", false)
  assert.equal((await settings.read("w", location)).find(item => item.server === "same")!.effective, false)
  await settings.update("w", location, "project", "same", null)
  assert.equal(Object.prototype.hasOwnProperty.call(parse(project).mcp.servers.same, "codemode"), false)
  assert.deepEqual(parse(project).mcp.servers.same, { type: "local", command: ["fixture"], disabled: true })
  assert.equal((await settings.read("w", location)).find(item => item.server === "same")!.effective, true)
  await assert.rejects(settings.update("w", location, "project", "global-only", false), /not configured/)
  assert.equal(JSON.stringify(await settings.read("w", location)).includes("{env:KEY}"), false)
})

test("MCP route admits only bounded tri-state source mutations and maps authority errors", async () => {
  const app = Fastify(), writes: unknown[] = []
  registerMcpCodeModeRoutes(app, { read: async () => [], update: async (...args) => {
    if (args[1].directory === "/foreign") throw new PluginControlsError("not owned", "forbidden")
    writes.push(args)
  } })
  try {
    for (const mode of [true, false, null]) assert.equal((await app.inject({ method: "PUT", url: "/api/workspaces/w/mcp-code-mode", payload: { location: { directory: "/project" }, scope: "project", server: "s", mode } })).statusCode, 204)
    for (const patch of [{ mode: "default" }, { scope: "other" }, { location: { directory: "/project", workspaceID: "old" } }, { extra: true }, { server: "" }]) {
      assert.equal((await app.inject({ method: "PUT", url: "/api/workspaces/w/mcp-code-mode", payload: { location: { directory: "/project" }, scope: "global", server: "s", mode: null, ...patch } })).statusCode, 400)
    }
    assert.equal((await app.inject({ method: "PUT", url: "/api/workspaces/w/mcp-code-mode", payload: { location: { directory: "/foreign" }, scope: "global", server: "s", mode: false } })).statusCode, 403)
    assert.equal(writes.length, 3)
  } finally { await app.close() }
})

test("MCP finds declarations below unrelated higher-priority config files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-sources-"))
  try {
    const global = path.join(root, "global"), project = path.join(root, "project")
    await mkdir(global); await mkdir(path.join(project, ".opencode"), { recursive: true })
    const files = [path.join(global, "opencode.json"), path.join(global, "opencode.jsonc"), path.join(project, "opencode.json"), path.join(project, ".opencode", "opencode.jsonc")]
    const definition = '{"mcp":{"servers":{"fixture":{"type":"local","command":["fixture"],"disabled":true}}}}'
    for (let i = 0; i < files.length; i++) await writeFile(files[i], i % 2 ? '{"plugins":[]}' : definition)
    const controls = new PluginControls({ workspaceManager: {
      get: () => ({}), getSharedServiceConnection: async () => ({ assertCurrent() {}, client: {
        config: { get: async () => [{ type: "directory", path: global }, ...await Promise.all(files.map(async file => ({ type: "document", path: file, info: parse(await readFile(file, "utf8")) }))) ] }, plugin: { list: async () => ({ data: [] }) },
      } }), getServiceDirectoryForPath: async (_id: string, directory: string) => directory === project ? directory : undefined,
      ownsLocation: async () => true, getWorktreeIdentityForPath: async () => "owned", getServicePathStyle: () => process.platform === "win32" ? "win32" : "posix",
      getServiceWslDistro: () => undefined, getHostPathForServicePath: async (_id: string, directory: string) => directory,
    } as any, worktreeDeletionFence: { enter: () => () => {} }, logger: {} as any })
    const settings = new McpCodeMode(controls), location = { directory: project }
    assert.deepEqual((await settings.read("w", location))[0].scopes.map(item => item.path), [files[0], files[2]])
    await settings.update("w", location, "global", "fixture", false)
    await settings.update("w", location, "project", "fixture", true)
    assert.equal(parse(await readFile(files[0], "utf8")).mcp.servers.fixture.codemode, false)
    assert.equal(parse(await readFile(files[2], "utf8")).mcp.servers.fixture.codemode, true)
    for (const file of [files[1], files[3]]) assert.equal(await readFile(file, "utf8"), '{"plugins":[]}')
  } finally { await rm(root, { recursive: true, force: true }) }
})
