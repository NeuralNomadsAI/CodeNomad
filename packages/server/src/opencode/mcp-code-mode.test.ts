import assert from "node:assert/strict"
import { test } from "node:test"
import { parse } from "jsonc-parser"
import Fastify from "fastify"
import { McpCodeMode } from "./mcp-code-mode"
import { registerMcpCodeModeRoutes } from "../server/routes/mcp-code-mode"
import { PluginControlsError } from "./plugin-controls"

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
