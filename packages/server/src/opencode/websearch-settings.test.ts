import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { parse } from "jsonc-parser"
import { PluginControls } from "./plugin-controls"
import { WebSearchSettings } from "./websearch-settings"
import { editNativeSetting, readNativeSetting } from "./native-setting-document"
import { readPluginControlDocument } from "./plugin-control-document"

test("web settings retain foreign fields and comments; scopes, reset and shared writes are explicit", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "web-settings-"))
  try {
    const global = path.join(root, "global"), project = path.join(root, "project")
    await mkdir(global); await mkdir(project)
    const globalFile = path.join(global, "opencode.jsonc"), projectFile = path.join(project, "opencode.jsonc")
    await writeFile(globalFile, '{\n  // keep me\n  "websearch": {"provider":"alpha", "future":42},\n  "plugins":[], "shell":"foreign-shell"\n}\n')
    await writeFile(projectFile, '{"websearch":false, "mcp":{"servers":{"foreign":{"codemode":false}}}}')
    let current = true, owned = true, blocked = false
    const connection: any = { assertCurrent: () => { if (!current) throw new Error("stale") }, client: {
      config: { get: async () => [ { type: "directory", path: global },
        { type: "document", path: globalFile, info: parse(await readFile(globalFile, "utf8")) },
        { type: "document", path: projectFile, info: parse(await readFile(projectFile, "utf8")) } ] },
      plugin: { list: async () => ({ data: [] }) },
    } }
    const controls = new PluginControls({ workspaceManager: {
      get: () => ({}), getSharedServiceConnection: async () => connection,
      getServiceDirectoryForPath: async (_id: string, directory: string) => directory === project ? directory : undefined,
      ownsLocation: async () => owned, getWorktreeIdentityForPath: async () => "owned",
      getServicePathStyle: () => process.platform === "win32" ? "win32" : "posix",
      getServiceWslDistro: () => undefined, getHostPathForServicePath: async (_id: string, value: string) => value,
    } as any, worktreeDeletionFence: { enter: () => blocked ? undefined : () => {} }, logger: {} as any })
    const settings = new WebSearchSettings(controls), location = { directory: project }
    assert.equal((await settings.read("w", location)).effective, false)
    await settings.update("w", location, "global", "beta")
    const updated = await readFile(globalFile, "utf8")
    assert.match(updated, /keep me/)
    assert.deepEqual(parse(updated).websearch, { provider: "beta", future: 42 })
    assert.equal(parse(updated).shell, "foreign-shell")
    assert.equal(parse(await readFile(projectFile, "utf8")).websearch, false)
    await settings.update("w", location, "project", null)
    assert.equal((await settings.read("w", location)).effective, "beta")
    assert.equal(parse(await readFile(projectFile, "utf8")).mcp.servers.foreign.codemode, false)
    await Promise.all([settings.update("w", location, "project", "random"), settings.update("w", location, "project", false)])
    assert.equal((await settings.read("w", location)).scopes.find(item => item.scope === "project")?.selection, false)
    blocked = true
    await assert.rejects(settings.update("w", location, "project", null), /deletion/)
    blocked = false; owned = false
    await assert.rejects(settings.update("w", location, "global", null), /owned/)
    owned = true; current = false
    await assert.rejects(settings.update("w", location, "project", null))
    assert.equal(parse(await readFile(projectFile, "utf8")).websearch, false)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("setting edits reject ambiguous keys and preserve BOM/formatting", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "web-setting-document-"))
  const file = path.join(root, "opencode.jsonc")
  try {
    await writeFile(file, '{"websearch":false,"websearch":{"provider":"alpha"}}')
    assert.throws(() => readNativeSetting({ text: '{"websearch":false,"websearch":{}}' } as any, ["websearch"]), /duplicate/)
    const duplicate = await readPluginControlDocument(file)
    assert.throws(() => editNativeSetting(duplicate, ["websearch"], false), /duplicate/)
    await writeFile(file, '\uFEFF{\r\n\t"websearch":false,\r\n\t"shell":"keep"\r\n}\r\n')
    const text = editNativeSetting(await readPluginControlDocument(file), ["websearch"], { provider: "random" })
    assert.ok(text.startsWith("\uFEFF")); assert.match(text, /\r\n\t/)
    assert.equal(parse(text.slice(1)).shell, "keep")
  } finally { await rm(root, { recursive: true, force: true }) }
})
