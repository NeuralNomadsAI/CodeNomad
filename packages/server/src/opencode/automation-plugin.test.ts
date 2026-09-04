import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import {
  AUTOMATION_BRIDGE_PATH,
  automationBridgeDirectory,
  automationBridgeDirectories,
  createAutomationBridgeRegistration,
  parseDeveloperAction,
  publishAutomationBridge,
  removeLegacyAutomationPlugin,
  setupAutomationPlugin,
} from "./automation-plugin"

type ToolDefinition = {
  name: string
  execute(input: unknown, context: { sessionID: string }): Promise<{ content: unknown }>
}

function listen(handler: (body: Record<string, unknown>) => Promise<Record<string, unknown>>) {
  return new Promise<{ server: http.Server; url: string }>((resolve) => {
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
}

async function collectTools(): Promise<ToolDefinition[]> {
  const definitions: ToolDefinition[] = []
  await setupAutomationPlugin({
    tool: { transform: async (callback) => callback({ add: (value) => definitions.push(value as ToolDefinition) }) },
  })
  return definitions
}

function closeServer(server: http.Server | undefined): Promise<void> {
  return new Promise((resolve) => server?.close(() => resolve()) ?? resolve())
}

function scopeAutomationBridgeRoot(root: string): () => void {
  const previousLocalAppData = process.env.LOCALAPPDATA
  const previousXdgRuntimeDir = process.env.XDG_RUNTIME_DIR
  process.env.LOCALAPPDATA = root
  process.env.XDG_RUNTIME_DIR = root
  return () => {
    if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA
    else process.env.LOCALAPPDATA = previousLocalAppData
    if (previousXdgRuntimeDir === undefined) delete process.env.XDG_RUNTIME_DIR
    else process.env.XDG_RUNTIME_DIR = previousXdgRuntimeDir
  }
}

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
  const restoreAutomationBridgeRoot = scopeAutomationBridgeRoot(root)
  const definitions: ToolDefinition[] = []
  let removeOld: (() => Promise<void>) | undefined
  let removeNew: (() => Promise<void>) | undefined
  let removePreexisting: (() => Promise<void>) | undefined
  const removeDistractors: Array<() => Promise<void>> = []
  let oldServer: http.Server | undefined
  let newServer: http.Server | undefined
  let preexistingServer: http.Server | undefined
  const distractorServers: http.Server[] = []
  let restarting = false

  try {
    await setupAutomationPlugin({
      tool: { transform: async (callback) => callback({ add: (value) => definitions.push(value as typeof definitions[number]) }) },
    })
    const replacement = await listen(async (body) => body.mode === "developer-probe"
      ? { result: { available: true, nativeIdentity: "electron:test", runId: "run-new" } }
      : { result: { target: { id: "page-new", title: "Restarted", url: "http://app.test" }, nodes: [], diagnostics: [] } })
    newServer = replacement.server
    const preexisting = await listen(async (body) => body.mode === "developer-probe" && restarting
      ? { result: { available: true, nativeIdentity: "electron:test", runId: "run-preexisting" } }
      : body.mode === "developer-probe"
        ? { result: { available: false } }
        : { result: { target: { id: "page-wrong", title: "Pre-existing", url: "http://app.test" }, nodes: [], diagnostics: [] } })
    preexistingServer = preexisting.server
    removePreexisting = await publishAutomationBridge(createAutomationBridgeRegistration(preexisting.url))
    const distractors = await Promise.all(Array.from({ length: 5 }, (_, index) => listen(async (body) => body.mode === "developer-probe"
      ? { result: { available: true, nativeIdentity: `electron:distractor-${index}`, runId: `run-distractor-${index}` } }
      : { result: { target: { id: `page-${index}`, title: "Distractor", url: "http://app.test" }, nodes: [], diagnostics: [] } })))
    distractorServers.push(...distractors.map((value) => value.server))
    const old = await listen(async (body) => {
      if (body.mode === "developer-probe") return { result: { available: true, nativeIdentity: "electron:test", runId: "run-old" } }
      if (body.command && (body.command as { action?: unknown }).action === "inspect") {
        return { result: { target: { id: "page-old", title: "Original", url: "http://app.test" }, nodes: [], diagnostics: [] } }
      }
      restarting = true
      removeNew = await publishAutomationBridge(createAutomationBridgeRegistration(replacement.url))
      for (const distractor of distractors) {
        await new Promise((resolve) => setTimeout(resolve, 2))
        removeDistractors.push(await publishAutomationBridge(createAutomationBridgeRegistration(distractor.url)))
      }
      return { result: { state: "starting" } }
    })
    oldServer = old.server
    removeOld = await publishAutomationBridge(createAutomationBridgeRegistration(old.url))

    const inspect = definitions.find((definition) => definition.name === "inspect")!
    await inspect.execute({}, { sessionID: "session-1" })
    const act = definitions.find((definition) => definition.name === "act")!
    const result = await act.execute({ action: "restart" }, { sessionID: "session-1" })
    assert.match(String(result.content), /Restarted/)
  } finally {
    await removeOld?.()
    await removeNew?.()
    await removePreexisting?.()
    await Promise.all(removeDistractors.map((remove) => remove()))
    await closeServer(oldServer)
    await closeServer(newServer)
    await closeServer(preexistingServer)
    await Promise.all(distractorServers.map(closeServer))
    restoreAutomationBridgeRoot()
    await rm(root, { recursive: true, force: true })
  }
})

test("keeps inspected targets isolated per plugin setup", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-automation-isolation-"))
  const restoreAutomationBridgeRoot = scopeAutomationBridgeRoot(root)
  let removeBridge: (() => Promise<void>) | undefined
  let server: http.Server | undefined
  try {
    const bridge = await listen(async (body) => body.mode === "developer-probe"
      ? { result: { available: true, nativeIdentity: "electron:isolation", runId: "run-isolation" } }
      : { result: { target: { id: "isolated", title: "Isolated", url: "http://app.test" }, nodes: [], diagnostics: [] } })
    server = bridge.server
    removeBridge = await publishAutomationBridge(createAutomationBridgeRegistration(bridge.url))
    const first = await collectTools()
    const second = await collectTools()
    await first.find((definition) => definition.name === "inspect")!.execute({}, { sessionID: "session-isolation" })
    await assert.rejects(
      second.find((definition) => definition.name === "screenshot")!.execute({}, { sessionID: "session-isolation" }),
      /Run codenomad\.inspect/,
    )
  } finally {
    await removeBridge?.()
    await closeServer(server)
    restoreAutomationBridgeRoot()
    await rm(root, { recursive: true, force: true })
  }
})

test("pins parallel sessions to their independently inspected bridges", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-automation-sessions-"))
  const restoreAutomationBridgeRoot = scopeAutomationBridgeRoot(root)
  const removals: Array<() => Promise<void>> = []
  const servers: http.Server[] = []
  try {
    for (const sessionID of ["session-a", "session-b"]) {
      const bridge = await listen(async (body) => body.mode === "developer-probe"
        ? { result: { available: body.sessionID === sessionID, nativeIdentity: `electron:${sessionID}`, runId: `run-${sessionID}` } }
        : { result: { target: { id: sessionID, title: sessionID, url: "http://app.test" }, nodes: [], diagnostics: [] } })
      servers.push(bridge.server)
      removals.push(await publishAutomationBridge(createAutomationBridgeRegistration(bridge.url)))
    }
    const tools = await collectTools()
    const inspect = tools.find((definition) => definition.name === "inspect")!
    const screenshot = tools.find((definition) => definition.name === "screenshot")!
    await inspect.execute({}, { sessionID: "session-a" })
    await inspect.execute({}, { sessionID: "session-b" })
    assert.match(String((await screenshot.execute({}, { sessionID: "session-a" })).content), /session-a/)
    assert.match(String((await screenshot.execute({}, { sessionID: "session-b" })).content), /session-b/)
  } finally {
    await Promise.all(removals.map((remove) => remove()))
    await Promise.all(servers.map(closeServer))
    restoreAutomationBridgeRoot()
    await rm(root, { recursive: true, force: true })
  }
})

test("prunes stale registry pressure before limiting discovery", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-automation-stale-"))
  const restoreAutomationBridgeRoot = scopeAutomationBridgeRoot(root)
  let removeBridge: (() => Promise<void>) | undefined
  let server: http.Server | undefined
  try {
    const bridge = await listen(async (body) => body.mode === "developer-probe"
      ? { result: { available: true, nativeIdentity: "electron:live", runId: "run-live" } }
      : { result: { target: { id: "live", title: "Live", url: "http://app.test" }, nodes: [], diagnostics: [] } })
    server = bridge.server
    removeBridge = await publishAutomationBridge(createAutomationBridgeRegistration(bridge.url))
    const directory = automationBridgeDirectory()
    const base = Date.now() + 10_000
    for (let index = 0; index < 70; index += 1) {
      const startedAt = base + index
      const token = `dead${String(index).padStart(8, "0")}`
      await writeFile(path.join(directory, `${startedAt}-99999999-${token}.json`), JSON.stringify({
        version: 1,
        url: new URL(AUTOMATION_BRIDGE_PATH, bridge.url).href,
        token,
        pid: 99_999_999,
        startedAt,
      }))
    }
    const inspect = (await collectTools()).find((definition) => definition.name === "inspect")!
    assert.match(String((await inspect.execute({}, { sessionID: "session-live" })).content), /Live/)
    assert.equal((await readdir(directory)).length, 1)
  } finally {
    await removeBridge?.()
    await closeServer(server)
    restoreAutomationBridgeRoot()
    await rm(root, { recursive: true, force: true })
  }
})
