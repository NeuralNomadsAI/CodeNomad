import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import childProcess from "node:child_process"
import { syncBuiltinESMExports } from "node:module"
import { setTimeout as delay } from "node:timers/promises"
import { promisify } from "node:util"
import {
  AUTOMATION_BRIDGE_PATH,
  automationBridgeDirectory,
  automationBridgeDirectories,
  discoverAutomationBridgeDirectories,
  createAutomationBridgeRegistration,
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
const oneWindow = [{ windowId: "window-1", focused: true, session: "elsewhere" }]

function listen(handler: (body: Record<string, unknown>, response: http.ServerResponse, request: http.IncomingMessage) => Promise<Record<string, unknown>>) {
  return new Promise<{ server: http.Server; url: string }>((resolve) => {
    const server = http.createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)))
      request.on("end", () => {
        void handler(JSON.parse(Buffer.concat(chunks).toString("utf8")), response, request).then((body) => {
          if (response.destroyed) return
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
        // A backend without native browsers claims sessions only for this purpose.
        assert.equal(body.purpose, "mission")
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

test("a mission input runs the caller's own effect only when no backend can own the session", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-mission-unowned-"))
  const restore = isolateAutomationBridgeRegistry(root)
  const removals: Array<() => Promise<void>> = []
  const servers: http.Server[] = []
  try {
    assert.equal(await sendMissionInput("ses_free", "prompt", {}, async () => "own"), "own", "no backend runs")
    let status = 404
    const other = await listen(async (_body, response) => { response.statusCode = status; return { error: "Not this backend" } })
    servers.push(other.server)
    removals.push(await publishAutomationBridge(createAutomationBridgeRegistration(other.url)))
    assert.equal(await sendMissionInput("ses_free", "prompt", {}, async () => "own"), "own", "every backend disowns the session")
    await assert.rejects(sendMissionInput("ses_free", "prompt", {}), /exactly one owning/)
    status = 500
    await assert.rejects(sendMissionInput("ses_free", "prompt", {}, async () => assert.fail("ownership is unknown")), /exactly one owning/)
  } finally {
    await Promise.all(removals.map(remove => remove()))
    await Promise.all(servers.map(closeServer))
    restore()
    await rm(root, { recursive: true, force: true })
  }
})

const fixtureSnapshot = { url: "https://example.test/", snapshot: "WebKit native result", collapsed: 0 }

test("WSL translates the exact Unicode LOCALAPPDATA reported by cmd.exe", { skip: process.platform !== "win32" }, async t => {
  const windowsPath = "C:\\Utilisateurs\\Élodie & 李 🧪\\AppData\\Local"
  const translated = "/fixture-windows/Élodie & 李 🧪/AppData/Local"
  const realExec = childProcess.execFile
  const cmd = path.join(process.env.SystemRoot!, "System32", "cmd.exe")
  t.mock.method(childProcess, "execFile", (file: string, args: string[], options: childProcess.ExecFileOptionsWithStringEncoding,
    callback: (error: Error | null, stdout: string) => void) => {
    if (file === "cmd.exe") return realExec(cmd, args, options, callback)
    assert.equal(file, "wslpath")
    assert.deepEqual(args, ["-u", windowsPath])
    callback(null, `${translated}\n`)
  })
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  assert.deepEqual(await discoverAutomationBridgeDirectories(undefined, {
    platform: "linux", strict: true, env: { SystemRoot: process.env.SystemRoot,
      WSL_DISTRO_NAME: "fixture-unicode", LOCALAPPDATA: windowsPath, LOCALAPPDATA_OTHER: "not the profile",
      XDG_RUNTIME_DIR: "/fixture-linux" },
  }), ["/fixture-linux/codenomad/automation-bridges", `${translated}/CodeNomad/automation-bridges`])
})

test("registers developer tools while execution remains session-gated", async () => {
  const tools: string[] = []
  await setupAutomationPlugin({
    tool: { transform: async (callback) => callback({ add: (value) => tools.push(value.name) }) },
  })

  assert.deepEqual(tools, ["inspect", "act", "screenshot"])
})

test("discovers the Windows bridge registry from a WSL plugin", async () => {
  assert.deepEqual(await automationBridgeDirectories({
    platform: "linux",
    env: { WSL_DISTRO_NAME: "Ubuntu", XDG_RUNTIME_DIR: "/run/user/1000" },
    home: "/home/dev",
    windowsLocalAppData: "/mnt/c/Users/dev/AppData/Local",
  }), [
    "/run/user/1000/codenomad/automation-bridges",
    "/mnt/c/Users/dev/AppData/Local/CodeNomad/automation-bridges",
  ])
})

test("slow WSL registry discovery stays cancellable, retries cancellation and caches a qualified path", async t => {
  const options = { platform: "linux" as const, env: { WSL_DISTRO_NAME: "Ubuntu", XDG_RUNTIME_DIR: "/run/user/1000" }, home: "/home/dev" }
  let calls = 0, aborted = false
  const mock = t.mock.method(childProcess, "execFile", ((_file: string, _args: string[], settings: { signal?: AbortSignal }, callback: (error: Error | null, stdout: string) => void) => {
    calls++
    settings.signal?.addEventListener("abort", () => { aborted = true; callback(new Error("cancelled"), "") }, { once: true })
    return {} as never
  }) as unknown as typeof childProcess.execFile)
  syncBuiltinESMExports()
  try {
    const controller = new AbortController()
    const pending = discoverAutomationBridgeDirectories(controller.signal, options)
    // The first interop command stays held. A real timer must still run.
    await new Promise(resolve => setTimeout(resolve, 10))
    controller.abort(new Error("budget expired"))
    await assert.rejects(pending, /budget expired/)
    assert.equal(aborted, true); assert.equal(calls, 1)
    mock.mock.restore()
    t.mock.method(childProcess, "execFile", ((_file: string, _args: string[], _settings: unknown, callback: (error: null, stdout: string) => void) => {
      calls++; callback(null, calls === 2 ? "LOCALAPPDATA=C:\\Users\\dev\\AppData\\Local\r\n" : "/mnt/c/Users/dev/AppData/Local\n")
      return {} as never
    }) as unknown as typeof childProcess.execFile)
    syncBuiltinESMExports()
    const expected = await automationBridgeDirectories({ ...options, windowsLocalAppData: "/mnt/c/Users/dev/AppData/Local" })
    assert.deepEqual(await discoverAutomationBridgeDirectories(undefined, options), expected)
    assert.deepEqual(await discoverAutomationBridgeDirectories(undefined, options), expected)
    assert.equal(calls, 3, "successful Windows discovery is cached across demands")
  } finally { t.mock.restoreAll(); syncBuiltinESMExports() }
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

for (const restored of [true, false]) test(`restart correlates the next run and ${restored ? "inspects only the original window" : "reports a missing original window"}`, async () => {
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
  let probedPreexisting = false

  try {
    await setupAutomationPlugin({
      tool: { transform: async (callback) => callback({ add: (value) => definitions.push(value as typeof definitions[number]) }) },
    })
    const target = { nativeIdentity: "electron:test", runId: "run-old", windowId: "window-1", windowInstance: "old-incarnation" }
    let restartCommand: Record<string, unknown>
    const replacement = await listen(async (body) => {
      // Its focused window is different. Only the exact reconnect operation can inspect window-1.
      if (body.mode !== "developer-reconnect") return { result: { target: { title: "Wrong window" } } }
      assert.deepEqual(body.command, restartCommand)
      return { developerTarget: { ...target, runId: "run-new", windowInstance: "new-incarnation" }, restartId: restartCommand.restartId,
        windowState: restored ? "inspected" : "missing",
        ...(restored && { result: { target: { id: "page-new", title: "Restarted", url: "http://app.test" }, pin: "pin-new",
          context: { windowId: "window-1", windowInstance: "new-incarnation", instanceId: null, sessionId: null },
          snapshot: "", collapsed: 0, diagnostics: [] } }) }
    })
    newServer = replacement.server
    const preexisting = await listen(async (body) => {
      if (body.mode === "developer-reconnect") {
        probedPreexisting = true
        return { developerTarget: { ...target, runId: "run-preexisting" }, restartId: restartCommand.restartId, windowState: "missing" }
      }
      return { result: { available: restarting, nativeIdentity: target.nativeIdentity, runId: "run-preexisting" } }
    })
    preexistingServer = preexisting.server
    removePreexisting = await publishAutomationBridge(createAutomationBridgeRegistration(preexisting.url))
    const distractors = await Promise.all(Array.from({ length: 5 }, (_, index) => listen(async (body) => {
      if (body.mode !== "developer-reconnect") return { result: { available: false } }
      const developerTarget = { ...target, runId: `run-distractor-${index}`,
        ...(index === 0 && { nativeIdentity: "electron:different-scope" }),
        ...(index === 1 && { runId: target.runId }),
        ...(index === 2 && { windowId: "wrong-window" }) }
      return { developerTarget, windowState: "missing", restartId: index < 3 ? restartCommand.restartId : "unrelated-relaunch" }
    })))
    distractorServers.push(...distractors.map((value) => value.server))
    const old = await listen(async (body) => {
      if (body.mode === "developer-probe") return { result: { available: true, ...target,
        windows: [{ ...oneWindow[0], windowInstance: target.windowInstance }] } }
      if (body.command && (body.command as { action?: unknown }).action === "inspect") {
        return { result: { target: { id: "page-old", title: "Original", url: "http://app.test" }, pin: "pin-old",
          context: { windowId: target.windowId, windowInstance: target.windowInstance, instanceId: null, sessionId: null },
          snapshot: "", collapsed: 0, diagnostics: [] } }
      }
      assert.equal(body.mode, "developer-restart")
      assert.equal(body.pin, "pin-old")
      restartCommand = body.command as Record<string, unknown>
      assert.deepEqual(restartCommand, { ...target, restartId: restartCommand.restartId })
      assert.match(String(restartCommand.restartId), /^[a-f0-9-]{36}$/)
      restarting = true
      removeNew = await publishAutomationBridge(createAutomationBridgeRegistration(replacement.url))
      for (const distractor of distractors) {
        await new Promise((resolve) => setTimeout(resolve, 2))
        removeDistractors.push(await publishAutomationBridge(createAutomationBridgeRegistration(distractor.url)))
      }
      return { result: restartCommand }
    })
    oldServer = old.server
    removeOld = await publishAutomationBridge(createAutomationBridgeRegistration(old.url))

    const inspect = definitions.find((definition) => definition.name === "inspect")!
    await inspect.execute({}, { sessionID: "session-1" })
    const act = definitions.find((definition) => definition.name === "act")!
    const result = await act.execute({ action: "restart" }, { sessionID: "session-1" })
    assert.match(String(result.content), restored ? /Restarted/ : /restarted.*window was not restored/i)
    assert.doesNotMatch(String(result.content), /Wrong window|Pre-existing|Distractor/)
    assert.equal(probedPreexisting, false)
    if (!restored) await assert.rejects(act.execute({ action: "restart" }, { sessionID: "session-1" }), /Run codenomad\.inspect/)
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

for (const windowState of ["inspected", "superseded"]) {
  test(`restart does not present A as selected after inspection B wins (${windowState})`, { timeout: 5_000 }, async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-reconnect-race-"))
    const restoreBridgeRegistry = isolateAutomationBridgeRegistry(root)
    const removals: Array<() => Promise<void>> = []
    const servers: http.Server[] = []
    let reached!: () => void, resume!: () => void
    const paused = new Promise<void>(resolve => { reached = resolve })
    const resumed = new Promise<void>(resolve => { resume = resolve })
    t.after(async () => {
      resume()
      await Promise.all(removals.map(remove => remove()))
      await Promise.all(servers.map(closeServer))
      restoreBridgeRegistry()
      await rm(root, { recursive: true, force: true })
    })
    const targetA = { nativeIdentity: "electron:test", runId: "run-old", windowId: "window-A" }
    const targetB = { ...targetA, runId: "run-new", windowId: "window-B" }
    const inspection = (windowId: string, title: string) => ({
      target: { id: windowId, title, url: "http://app.test" }, context: { windowId, instanceId: null, sessionId: null },
      pin: `pin-${windowId}`, snapshot: "", collapsed: 0, diagnostics: [],
    })
    let restarting = false
    const replacement = await listen(async body => {
      if (body.mode === "developer-probe") return { result: { ...targetB, available: true,
        windows: [{ ...oneWindow[0], windowId: targetB.windowId }] } }
      if (body.mode === "developer-reconnect") {
        reached()
        await resumed
        return { developerTarget: { ...targetA, runId: targetB.runId }, restartId: (body.command as { restartId: string }).restartId,
          windowState, ...(windowState === "inspected" && { result: inspection(targetA.windowId, "Restored A") }) }
      }
      if ((body.command as { action: string }).action === "inspect") {
        return { developerTarget: targetB, result: inspection(targetB.windowId, "New inspection B") }
      }
      assert.equal(body.mode, "developer-execute")
      assert.equal(body.pin, `pin-${targetB.windowId}`)
      return { result: { windowId: targetB.windowId } }
    })
    servers.push(replacement.server)
    const original = await listen(async body => {
      if (body.mode === "developer-probe") return { result: { ...targetA, available: !restarting,
        windows: [{ ...oneWindow[0], windowId: targetA.windowId }] } }
      if (body.mode === "developer-restart") {
        restarting = true
        removals.push(await publishAutomationBridge(createAutomationBridgeRegistration(replacement.url)))
        return { result: body.command }
      }
      return { developerTarget: targetA, result: inspection(targetA.windowId, "Original A") }
    })
    servers.push(original.server)
    removals.push(await publishAutomationBridge(createAutomationBridgeRegistration(original.url)))
    const tools = await collectTools()
    const inspect = tools.find(definition => definition.name === "inspect")!
    const act = tools.find(definition => definition.name === "act")!
    const context = { sessionID: "ses_fixture" }
    await inspect.execute({}, context)
    const restart = act.execute({ action: "restart" }, context)
    await paused
    // A different plugin setup can publish B on the backend without a matching local pin.
    const inspector = windowState === "superseded"
      ? (await collectTools()).find(definition => definition.name === "inspect")! : inspect
    assert.match(String((await inspector.execute({}, context)).content), /New inspection B/)
    resume()
    assert.match(String((await restart).content), /^CodeNomad restarted; the original inspection was not restored\. Inspect again\.$/)
    if (windowState === "inspected") {
      assert.match(JSON.stringify((await act.execute({ action: "press", key: "Enter" }, context)).content), /window-B/)
    } else {
      await assert.rejects(act.execute({ action: "press", key: "Enter" }, context), /Run codenomad\.inspect/)
    }
  })
}

test("keeps inspected targets isolated and refuses follow-ups when a bridge returns no receipt", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-automation-isolation-"))
  const restoreBridgeRegistry = isolateAutomationBridgeRegistry(root)
  let removeBridge: (() => Promise<void>) | undefined
  let server: http.Server | undefined
  try {
    const requests: Record<string, unknown>[] = []
    let issueReceipt = true
    const bridge = await listen(async (body, response) => {
      requests.push(body)
      if (body.mode === "developer-probe") {
        return { result: { available: true, nativeIdentity: "electron:isolation", runId: "run-isolation", windows: oneWindow } }
      }
      if ((body.command as { action: string }).action !== "inspect" || (body.command as { ref?: string }).ref) {
        response.statusCode = 409
        return { error: "An unpinned command reached the bridge" }
      }
      return { result: { target: { id: "isolated", title: "Isolated", url: "http://app.test" },
        context: { windowId: "window-1", instanceId: null, sessionId: null }, snapshot: "", collapsed: 0, diagnostics: [],
        ...(issueReceipt ? { pin: "receipt" } : {}) } }
    })
    server = bridge.server
    removeBridge = await publishAutomationBridge(createAutomationBridgeRegistration(bridge.url))
    const first = await collectTools()
    const second = await collectTools()
    const session = { sessionID: "session-isolation" }
    const inspect = first.find(tool => tool.name === "inspect")!
    const act = first.find(tool => tool.name === "act")!
    const capture = first.find(tool => tool.name === "screenshot")!
    await inspect.execute({}, session)
    await assert.rejects(
      second.find(tool => tool.name === "screenshot")!.execute({}, session),
      /Run codenomad\.inspect/,
    )

    issueReceipt = false
    assert.match(String((await inspect.execute({}, session)).content), /CodeNomad window window-1/)
    const before = requests.length
    for (const [tool, input] of [[capture, {}], [inspect, { ref: "e1" }],
      [act, { action: "press", key: "Enter" }], [act, { action: "restart" }]] as const) {
      await assert.rejects(tool.execute(input, session), /inspect-required/)
    }
    assert.equal(requests.length, before, "legacy responses cannot forward unpinned commands")
    assert.match(String((await inspect.execute({}, session)).content), /CodeNomad window window-1/)
    assert.equal(requests.at(-1)?.target, "electron:isolation/run-isolation/window-1")
  } finally {
    await removeBridge?.()
    await closeServer(server)
    restoreBridgeRegistry()
    await rm(root, { recursive: true, force: true })
  }
})

test("a lost response after a window action asks for inspection without replay", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-automation-input-response-"))
  const restore = isolateAutomationBridgeRegistry(root)
  let attempts = 0
  const bridge = await listen(async (body, response) => {
    if (body.mode === "developer-probe") {
      return { result: { available: true, nativeIdentity: "electron:fixture", runId: "run", windows: oneWindow } }
    }
    if ((body.command as { action: string }).action === "inspect") {
      return { result: { target: { id: "page", title: "Fixture", url: "http://app.test" },
        context: { windowId: "window-1", instanceId: null, sessionId: null }, snapshot: "", collapsed: 0, diagnostics: [], pin: "receipt" } }
    }
    attempts++
    response.destroy()
    return {}
  })
  const remove = await publishAutomationBridge(createAutomationBridgeRegistration(bridge.url))
  try {
    const tools = await collectTools(), session = { sessionID: "session" }
    await tools.find(tool => tool.name === "inspect")!.execute({}, session)
    await assert.rejects(tools.find(tool => tool.name === "act")!.execute({ action: "press", key: "Enter" }, session),
      /outcome is unknown.*inspect.*retry/i)
    assert.equal(attempts, 1)
  } finally {
    await remove()
    await closeServer(bridge.server)
    restore()
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
      const bridge = await listen(async body => {
        if (body.mode === "developer-probe") {
          return { result: { available: body.sessionID === sessionID, nativeIdentity: `electron:${sessionID}`, runId: `run-${sessionID}`, windows: oneWindow } }
        }
        if ((body.command as { action: string }).action === "screenshot") return { result: { receipt: body.pin } }
        return { result: { target: { id: sessionID, title: sessionID, url: "http://app.test" },
          context: { windowId: "window-1", instanceId: null, sessionId: null },
          snapshot: "", collapsed: 0, diagnostics: [], pin: `receipt-${sessionID}` } }
      })
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

test("lists exact window selectors, prefers the visible session and stays pinned without re-probing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-automation-targets-"))
  const restore = isolateAutomationBridgeRegistry(root)
  const calls: Array<Record<string, unknown>> = []
  const removals: Array<() => Promise<void>> = []
  const servers: http.Server[] = []
  let twoVisible = false, closed = false, ignoreSelector = false
  let entered!: () => void, release!: () => void
  const inspecting = new Promise<void>(resolve => { entered = resolve })
  const paused = new Promise<void>(resolve => { release = resolve })
  try {
    for (const profile of ["a", "b"]) {
      const bridge = await listen(async (body, response) => {
        calls.push({ ...body, profile })
        if (body.mode === "developer-probe" && body.purpose === "target") {
          const windowId = body.target === `electron:${profile}/run/window-2` ? "window-2" : undefined
          return { result: { available: !!windowId, nativeIdentity: `electron:${profile}`, runId: "run", windowId } }
        }
        if (body.mode === "developer-probe") return { result: { available: true, nativeIdentity: `electron:${profile}`, runId: "run",
          windows: [{ windowId: "window-1", focused: true, session: profile === "b" && !twoVisible ? "elsewhere" : "visible" },
            { windowId: "window-2", focused: false, session: "open" }] } }
        const action = (body.command as { action: string }).action
        const windowId = ignoreSelector ? "window-1"
          : typeof body.target === "string" ? body.target.split("/")[2]
          : typeof body.pin === "string" ? body.pin.split(":")[1] : "window-1"
        if (action === "screenshot") {
          if (closed) {
            response.statusCode = 404
            return { code: "target-gone", error: "Closed" }
          }
          return { result: { image: { data: Buffer.from(windowId).toString("base64"), mime: "image/png" } } }
        }
        if (action === "press") return { result: { windowId } }
        if (profile === "a" && body.pin === "a:window-1") { entered(); await paused }
        return { result: { target: { id: "page", title: "CodeNomad", url: "http://app.test" },
          context: { windowId, instanceId: null, sessionId: null }, snapshot: "", collapsed: 0, diagnostics: [], pin: `${profile}:${windowId}` } }
      })
      servers.push(bridge.server)
      removals.push(await publishAutomationBridge(createAutomationBridgeRegistration(bridge.url)))
    }
    const tools = await collectTools()
    const inspect = tools.find(tool => tool.name === "inspect")!
    const act = tools.find(tool => tool.name === "act")!
    const capture = tools.find(tool => tool.name === "screenshot")!
    const session = { sessionID: "one" }
    const list = JSON.parse(String((await inspect.execute({ targets: true }, session)).content))
    assert.equal(list.targets.length, 4)
    assert.ok(calls.every(call => call.mode === "developer-probe"), "listing cannot inspect or move a window")
    await inspect.execute({}, session)
    assert.equal(calls.at(-1)?.target, "electron:a/run/window-1")
    twoVisible = true
    await assert.rejects(inspect.execute({}, { sessionID: "two" }), /ambiguous-target/)
    const target = list.targets.find((item: { target: string }) => item.target === "electron:b/run/window-2").target
    ignoreSelector = true
    await assert.rejects(inspect.execute({ target }, { sessionID: "redirected" }), /target-gone/)
    ignoreSelector = false
    const late = assert.rejects(inspect.execute({}, session), /stale-inspection/)
    await inspecting
    try { assert.match(String((await inspect.execute({ target }, session)).content), /CodeNomad window window-2/) }
    finally { release() }
    await late
    assert.ok(calls.some(call => call.mode === "developer-execute" && call.target === target))
    assert.equal(JSON.parse(String((await act.execute({ action: "press", key: "Enter" }, session)).content)).windowId, "window-2")
    const image = (await capture.execute({}, session)).content as Array<{ uri: string }>
    assert.equal(image[1].uri, `data:image/png;base64,${Buffer.from("window-2").toString("base64")}`)
    closed = true
    const before = calls.length
    await assert.rejects(capture.execute({}, session), /target-gone/)
    assert.equal(calls.length, before + 1, "a closed window cannot trigger a new discovery or capture")
    assert.equal(calls.at(-1)?.profile, "b")
    assert.equal(calls.at(-1)?.pin, "b:window-2")
  } finally {
    release()
    await Promise.all(removals.map(remove => remove()))
    await Promise.all(servers.map(closeServer))
    restore()
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
      ? { result: { available: true, nativeIdentity: "electron:live", runId: "run-live", windows: oneWindow } }
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
