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
  parseBrowserAction,
  parseDeveloperAction,
  formatInspection,
  publishAutomationBridge,
  removeLegacyAutomationPlugin,
  setupAutomationPlugin,
  sendMissionInput,
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

function isolateAutomationBridgeRegistry(root: string): () => void {
  const previousLocalAppData = process.env.LOCALAPPDATA
  const previousXdgRuntimeDir = process.env.XDG_RUNTIME_DIR
  const previousWslDistroName = process.env.WSL_DISTRO_NAME
  process.env.LOCALAPPDATA = root
  process.env.XDG_RUNTIME_DIR = root
  delete process.env.WSL_DISTRO_NAME
  return () => {
    if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA
    else process.env.LOCALAPPDATA = previousLocalAppData
    if (previousXdgRuntimeDir === undefined) delete process.env.XDG_RUNTIME_DIR
    else process.env.XDG_RUNTIME_DIR = previousXdgRuntimeDir
    if (previousWslDistroName === undefined) delete process.env.WSL_DISTRO_NAME
    else process.env.WSL_DISTRO_NAME = previousWslDistroName
  }
}

test("validates Developer Mode actions", () => {
  assert.deepEqual(parseDeveloperAction({ action: "type", ref: "e4", text: "CodeNomad" }), {
    action: "type",
    ref: "e4",
    text: "CodeNomad",
    clear: true,
  })
  assert.deepEqual(parseDeveloperAction({ action: "type", ref: "e4", text: " more", clear: false }), { action: "type", ref: "e4", text: " more", clear: false })
  assert.throws(() => parseDeveloperAction({ action: "type", ref: "e4", text: "x", clear: "no" }), /clear must be true or false/)
  assert.deepEqual(parseDeveloperAction({ action: "select", ref: "e5", values: ["Exploration"] }), { action: "select", ref: "e5", values: ["Exploration"] })
  assert.throws(() => parseDeveloperAction({ action: "select", ref: "e5", values: "Exploration" }), /select requires ref and values/)
  assert.throws(() => parseDeveloperAction({ action: "select", ref: "e5", values: [1] }), /select requires ref and values/)
  assert.deepEqual(parseDeveloperAction({ action: "inspect", ref: "e9", query: "  " }), { action: "inspect", ref: "e9" })
  assert.deepEqual(parseDeveloperAction({ action: "inspect", query: "Playbook" }), { action: "inspect", query: "Playbook" })
  assert.throws(() => parseDeveloperAction({ action: "inspect", query: "x".repeat(201) }), /at most 200 characters/)
  assert.deepEqual(parseDeveloperAction({ action: "restart" }), { action: "restart" })
  assert.throws(() => parseDeveloperAction({ action: "click" }), /click requires ref/)
})

test("validates trusted-input actions, and parsing is idempotent across the bridge", () => {
  const cases: Array<[Record<string, unknown>, unknown]> = [
    [{ action: "click", ref: "e1", button: "right" }, { action: "click", ref: "e1", button: "right" }],
    [{ action: "click", ref: "e1", button: "left" }, { action: "click", ref: "e1" }],
    [{ action: "hover", ref: "e2" }, { action: "hover", ref: "e2" }],
    [{ action: "drag", ref: "e2", to: "e3" }, { action: "drag", ref: "e2", to: "e3" }],
    [{ action: "scroll", direction: "down" }, { action: "scroll", direction: "down", amount: 600 }],
    [{ action: "scroll", ref: "e4", direction: "left", amount: 120 }, { action: "scroll", ref: "e4", direction: "left", amount: 120 }],
    [{ action: "press", key: "Shift+Tab" }, { action: "press", key: "Shift+Tab" }],
    [{ action: "press", key: "Enter", ref: "e5" }, { action: "press", key: "Enter", ref: "e5" }],
    [{ action: "wait", text: "Ready" }, { action: "wait", text: "Ready", gone: false, timeout: 5_000 }],
    [{ action: "wait", text: "Saving", gone: true, timeout: 0 }, { action: "wait", text: "Saving", gone: true, timeout: 0 }],
  ]
  for (const [input, expected] of cases) {
    assert.deepEqual(parseDeveloperAction(input), expected)
    assert.deepEqual(parseDeveloperAction(parseDeveloperAction(input)), expected, "the backend re-parses the same flat command")
  }
  assert.throws(() => parseDeveloperAction({ action: "click", ref: "e1", button: "middle" }), /left or right/)
  assert.throws(() => parseDeveloperAction({ action: "drag", ref: "e1" }), /drag requires to/)
  assert.throws(() => parseDeveloperAction({ action: "scroll", direction: "sideways" }), /up, down, left or right/)
  assert.throws(() => parseDeveloperAction({ action: "scroll", direction: "up", amount: 10_001 }), /from 1 to 10000/)
  assert.throws(() => parseDeveloperAction({ action: "press", key: "" }), /press requires key/)
  assert.throws(() => parseDeveloperAction({ action: "press", key: "Hyper+Q" }), /Unknown modifier/)
  assert.throws(() => parseDeveloperAction({ action: "wait", text: " " }), /wait requires text/)
  assert.throws(() => parseDeveloperAction({ action: "wait", text: "x", timeout: 20_000 }), /from 0 to 15000/)
})

test("an inspection reads as a plain outline with its window, collapse note and diagnostics", () => {
  const text = formatInspection({
    target: { title: "CodeNomad", url: "http://127.0.0.1:9899/" },
    context: { windowId: "window-1", instanceId: null, sessionId: "ses_1" },
    snapshot: "- main [e1]\n  - log \"Transcript\" [e2] (+40 hidden)",
    collapsed: 1,
    diagnostics: [{ level: "error", text: "boom" }],
  })
  assert.equal(text, [
    "CodeNomad window window-1 · workspace none · conversation ses_1",
    "CodeNomad — http://127.0.0.1:9899/",
    "",
    "- main [e1]",
    "  - log \"Transcript\" [e2] (+40 hidden)",
    "",
    "A line ending in (+N hidden) collapses that element: inspect its ref to expand it. (+N more) stands for omitted siblings: inspect their parent's ref, or use query to find them.",
    "",
    "Runtime diagnostics:",
    "- error: boom",
  ].join("\n"))
})

test("mission discovery waits for cold ownership validation and still rejects competing owners", { timeout: 20_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-mission-cold-owner-"))
  const restore = isolateAutomationBridgeRegistry(root)
  const removals: Array<() => Promise<void>> = []
  const servers: http.Server[] = []
  let admissions = 0
  let cold = true
  try {
    const owner = await listen(async body => {
      if (body.mode === "browser-claim") {
        if (cold) await new Promise(resolve => setTimeout(resolve, 5_200))
        return { result: { available: true } }
      }
      admissions++
      return { result: { admitted: true } }
    })
    servers.push(owner.server)
    removals.push(await publishAutomationBridge(createAutomationBridgeRegistration(owner.url)))
    assert.deepEqual(await sendMissionInput("ses_cold", "prompt", {}), { admitted: true })
    cold = false
    const competing = await listen(async () => ({ result: { available: true } }))
    servers.push(competing.server)
    removals.push(await publishAutomationBridge(createAutomationBridgeRegistration(competing.url)))
    await assert.rejects(sendMissionInput("ses_cold", "prompt", {}), /exactly one owning/)
    assert.equal(admissions, 1)
  } finally {
    await Promise.all(removals.map(remove => remove()))
    await Promise.all(servers.map(closeServer))
    restore()
    await rm(root, { recursive: true, force: true })
  }
})

test("validates browser actions", () => {
  assert.deepEqual(parseBrowserAction({ action: "open", url: "https://example.com" }), {
    action: "open",
    url: "https://example.com",
  })
  assert.deepEqual(parseBrowserAction({ action: "type", ref: "e2", text: "hello", clear: false }), {
    action: "type",
    ref: "e2",
    text: "hello",
    clear: false,
  })
  assert.throws(() => parseBrowserAction({ action: "open" }), /open requires url/)
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
  const restoreBridgeRegistry = isolateAutomationBridgeRegistry(root)
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
      : { result: { target: { id: "page-new", title: "Restarted", url: "http://app.test" }, context: { windowId: "window-1", instanceId: null, sessionId: null }, snapshot: "", collapsed: 0, diagnostics: [] } })
    newServer = replacement.server
    const preexisting = await listen(async (body) => body.mode === "developer-probe" && restarting
      ? { result: { available: true, nativeIdentity: "electron:test", runId: "run-preexisting" } }
      : body.mode === "developer-probe"
        ? { result: { available: false } }
        : { result: { target: { id: "page-wrong", title: "Pre-existing", url: "http://app.test" }, context: { windowId: "window-1", instanceId: null, sessionId: null }, snapshot: "", collapsed: 0, diagnostics: [] } })
    preexistingServer = preexisting.server
    removePreexisting = await publishAutomationBridge(createAutomationBridgeRegistration(preexisting.url))
    const distractors = await Promise.all(Array.from({ length: 5 }, (_, index) => listen(async (body) => body.mode === "developer-probe"
      ? { result: { available: true, nativeIdentity: `electron:distractor-${index}`, runId: `run-distractor-${index}` } }
      : { result: { target: { id: `page-${index}`, title: "Distractor", url: "http://app.test" }, context: { windowId: "window-1", instanceId: null, sessionId: null }, snapshot: "", collapsed: 0, diagnostics: [] } })))
    distractorServers.push(...distractors.map((value) => value.server))
    const old = await listen(async (body) => {
      if (body.mode === "developer-probe") return { result: { available: true, nativeIdentity: "electron:test", runId: "run-old" } }
      if (body.command && (body.command as { action?: unknown }).action === "inspect") {
        return { result: { target: { id: "page-old", title: "Original", url: "http://app.test" }, context: { windowId: "window-1", instanceId: null, sessionId: null }, snapshot: "", collapsed: 0, diagnostics: [] } }
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
    restoreBridgeRegistry()
    await rm(root, { recursive: true, force: true })
  }
})

test("keeps inspected targets isolated per plugin setup", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-automation-isolation-"))
  const restoreBridgeRegistry = isolateAutomationBridgeRegistry(root)
  let removeBridge: (() => Promise<void>) | undefined
  let server: http.Server | undefined
  try {
    const bridge = await listen(async (body) => body.mode === "developer-probe"
      ? { result: { available: true, nativeIdentity: "electron:isolation", runId: "run-isolation" } }
      : { result: { target: { id: "isolated", title: "Isolated", url: "http://app.test" }, context: { windowId: "window-1", instanceId: null, sessionId: null }, snapshot: "", collapsed: 0, diagnostics: [] } })
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
    restoreBridgeRegistry()
    await rm(root, { recursive: true, force: true })
  }
})

test("pins parallel sessions to their independently inspected bridges", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-automation-sessions-"))
  const restoreBridgeRegistry = isolateAutomationBridgeRegistry(root)
  const removals: Array<() => Promise<void>> = []
  const servers: http.Server[] = []
  try {
    for (const sessionID of ["session-a", "session-b"]) {
      const bridge = await listen(async (body) => body.mode === "developer-probe"
        ? { result: { available: body.sessionID === sessionID, nativeIdentity: `electron:${sessionID}`, runId: `run-${sessionID}` } }
        : { result: { target: { id: sessionID, title: sessionID, url: "http://app.test" }, context: { windowId: "window-1", instanceId: null, sessionId: null }, snapshot: "", collapsed: 0, diagnostics: [] } })
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
    restoreBridgeRegistry()
    await rm(root, { recursive: true, force: true })
  }
})

test("prunes stale registry pressure before limiting discovery", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-automation-stale-"))
  const restoreBridgeRegistry = isolateAutomationBridgeRegistry(root)
  let removeBridge: (() => Promise<void>) | undefined
  let server: http.Server | undefined
  try {
    const bridge = await listen(async (body) => body.mode === "developer-probe"
      ? { result: { available: true, nativeIdentity: "electron:live", runId: "run-live" } }
      : { result: { target: { id: "live", title: "Live", url: "http://app.test" }, context: { windowId: "window-1", instanceId: null, sessionId: null }, snapshot: "", collapsed: 0, diagnostics: [] } })
    server = bridge.server
    removeBridge = await publishAutomationBridge(createAutomationBridgeRegistration(bridge.url))
    const directory = automationBridgeDirectory()
    assert.equal(path.dirname(path.dirname(directory)), root)
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
    restoreBridgeRegistry()
    await rm(root, { recursive: true, force: true })
  }
})
