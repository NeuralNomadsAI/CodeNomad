import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import {
  automationBridgeDirectories,
  createAutomationBridgeRegistration,
  parseDeveloperAction,
  publishAutomationBridge,
  removeLegacyAutomationPlugin,
  setupAutomationPlugin,
} from "./automation-plugin"

test("validates Developer Mode actions", () => {
  assert.deepEqual(parseDeveloperAction({ action: "type", ref: "e4", text: "CodeNomad" }), {
    action: "type",
    ref: "e4",
    text: "CodeNomad",
  })
  assert.deepEqual(parseDeveloperAction({ action: "restart" }), { action: "restart" })
  assert.throws(() => parseDeveloperAction({ action: "click" }), /click requires ref/)
})

test("registers developer tools while execution remains session-gated", async () => {
  const tools: string[] = []
  await setupAutomationPlugin({
    tool: { transform: async (callback) => callback({ add: (value) => tools.push(value.name) }) },
  })

  assert.deepEqual(tools, ["inspect", "act", "screenshot"])
})

test("discovers the Windows bridge registry from a WSL plugin", () => {
  assert.deepEqual(automationBridgeDirectories({
    platform: "linux",
    env: { WSL_DISTRO_NAME: "Ubuntu", XDG_RUNTIME_DIR: "/run/user/1000" },
    home: "/home/dev",
    windowsLocalAppData: "/mnt/c/Users/dev/AppData/Local",
  }), [
    "/run/user/1000/codenomad/automation-bridges",
    "/mnt/c/Users/dev/AppData/Local/CodeNomad/automation-bridges",
  ])
})

test("removes only the generated legacy global plugin shim", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-legacy-plugin-"))
  const plugin = path.join(root, "opencode", "plugins", "codenomad-automation.ts")
  await mkdir(path.dirname(plugin), { recursive: true })
  try {
    await writeFile(plugin, 'export { default } from "file:///C:/CodeNomad/resources/server/dist/opencode/automation-plugin.js"\n')
    assert.equal(await removeLegacyAutomationPlugin(root), true)
    await assert.rejects(readFile(plugin, "utf8"), { code: "ENOENT" })

    await writeFile(plugin, "export default { id: 'user-plugin' }\n")
    assert.equal(await removeLegacyAutomationPlugin(root), false)
    assert.match(await readFile(plugin, "utf8"), /user-plugin/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("restart waits for a new native generation and returns a fresh inspection", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-automation-restart-"))
  const previousLocalAppData = process.env.LOCALAPPDATA
  process.env.LOCALAPPDATA = root
  const definitions: Array<{ name: string; execute(input: unknown, context: { sessionID: string }): Promise<{ content: unknown }> }> = []
  let removeOld: (() => Promise<void>) | undefined
  let removeNew: (() => Promise<void>) | undefined
  let oldServer: http.Server | undefined
  let newServer: http.Server | undefined

  const listen = (handler: (body: Record<string, unknown>) => Promise<Record<string, unknown>>) => new Promise<{ server: http.Server; url: string }>((resolve) => {
    const server = http.createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)))
      request.on("end", () => {
        void handler(JSON.parse(Buffer.concat(chunks).toString("utf8"))).then((body) => {
          response.setHeader("content-type", "application/json")
          response.end(JSON.stringify(body))
        })
      })
    })
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as { port: number }
      resolve({ server, url: `http://127.0.0.1:${address.port}` })
    })
  })

  try {
    await setupAutomationPlugin({
      tool: { transform: async (callback) => callback({ add: (value) => definitions.push(value as typeof definitions[number]) }) },
    })
    const replacement = await listen(async (body) => body.mode === "developer-probe"
      ? { result: { available: true, nativeIdentity: "electron:test", runId: "run-new" } }
      : { result: { target: { id: "page-new", title: "Restarted", url: "http://app.test" }, nodes: [], diagnostics: [] } })
    newServer = replacement.server
    const old = await listen(async (body) => {
      if (body.mode === "developer-probe") return { result: { available: true, nativeIdentity: "electron:test", runId: "run-old" } }
      removeNew = await publishAutomationBridge(createAutomationBridgeRegistration(replacement.url))
      return { result: { state: "starting" } }
    })
    oldServer = old.server
    removeOld = await publishAutomationBridge(createAutomationBridgeRegistration(old.url))

    const act = definitions.find((definition) => definition.name === "act")!
    const result = await act.execute({ action: "restart" }, { sessionID: "session-1" })
    assert.match(String(result.content), /Restarted/)
  } finally {
    await removeOld?.()
    await removeNew?.()
    await new Promise<void>((resolve) => oldServer?.close(() => resolve()) ?? resolve())
    await new Promise<void>((resolve) => newServer?.close(() => resolve()) ?? resolve())
    if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA
    else process.env.LOCALAPPDATA = previousLocalAppData
    await rm(root, { recursive: true, force: true })
  }
})
