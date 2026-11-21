import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import fs from "node:fs/promises"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { PassThrough } from "node:stream"
import test, { type TestContext } from "node:test"
import childProcess from "node:child_process"
import { syncBuiltinESMExports } from "node:module"
import { setTimeout as delay } from "node:timers/promises"
import { promisify } from "node:util"
import type { Plugin } from "@opencode/plugin"
import { desktopPlugin } from "./automation/desktop-plugin"
import {
  AUTOMATION_BRIDGE_PATH,
  automationBridgeDirectory,
  automationBridgeDirectories,
  discoverAutomationBridgeDirectories,
  createAutomationBridgeRegistration,
  parseBrowserAction,
  parseDeveloperAction,
  formatInspection,
  formatBrowserSnapshot,
  publishAutomationBridge,
  removeLegacyAutomationPlugin,
  setupAutomationPlugin,
  sendMissionInput,
  createBrowserToolExecutor,
  executeBrowserTool,
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

async function browserTool(t: TestContext, leaseDirectory: string) {
  await writeFile(path.join(leaseDirectory, "01.lease"), "")
  const tools: Array<ToolDefinition & { options: { namespace: string } }> = []
  type Transform = Plugin.Context["tool"]["transform"]
  const editor: Pick<Parameters<Parameters<Transform>[0]>[0], "add"> = {
    add: value => { tools.push(value as typeof tools[number]) },
  }
  const stop = await desktopPlugin(leaseDirectory).setup({
    tool: { transform: async (callback: Parameters<Transform>[0]) => {
      callback(editor as never)
      return { dispose: async () => undefined }
    } },
    skill: { transform: async () => ({ dispose: async () => undefined }) },
  } as unknown as Plugin.Context)
  t.after(async () => { await stop?.() })
  const browser = tools.find(tool => tool.name === "browser" && tool.options.namespace === "codenomad")
  assert.ok(browser)
  return (input: unknown) => browser.execute(input, { sessionID: "fixture" })
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

const fixtureSnapshot = { url: "https://example.test/", snapshot: "WebKit native result", collapsed: 0 }

test("browser discovery executes native WebKit open, snapshot and screenshot actions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-webkit-browser-"))
  const restore = isolateAutomationBridgeRegistry(root)
  const calls: unknown[] = []
  let remove: (() => Promise<void>) | undefined
  const { server, url } = await listen(async (body, response) => {
    calls.push([body.mode, body.target])
    return { result: body.mode !== "browser-execute" ? { available: true, target: "webkit-document" }
      : (body.command as { action: string }).action === "snapshot" ? fixtureSnapshot : { text: "WebKit native result" } }
  })
  try {
    remove = await publishAutomationBridge(createAutomationBridgeRegistration(url))
    for (const command of [{ action: "open", url: "https://example.com" }, { action: "snapshot" }, { action: "screenshot" }]) {
      assert.match((await executeBrowserTool("ses_webkit", command)).content as string, /WebKit native result/)
    }
    assert.deepEqual(calls, [["browser-claim", undefined], ["browser-execute", undefined],
      ["browser-probe", undefined], ["browser-execute", "webkit-document"],
      ["browser-probe", undefined], ["browser-execute", "webkit-document"]])
  } finally {
    await remove?.()
    await closeServer(server)
    restore()
    await rm(root, { recursive: true, force: true })
  }
})

test("multiple visible previews at one backend are reported as ambiguous without sending input", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-browser-ambiguity-"))
  const restore = isolateAutomationBridgeRegistry(root)
  t.after(async () => { restore(); await rm(root, { recursive: true, force: true }) })
  let executions = 0
  const registration = await listen(async (body, reply) => {
    if (body.mode !== "browser-probe") executions++
    reply.statusCode = 409
    return { code: "ambiguous-target", error: "Several visible previews match this session" }
  })
  const remove = await publishAutomationBridge(createAutomationBridgeRegistration(registration.url))
  t.after(async () => { await closeServer(registration.server); await remove() })
  await assert.rejects(executeBrowserTool("session", { action: "press", key: "Enter" }), /ambiguous-target/)
  assert.equal(executions, 0)
})

test("preview discovery cannot dispatch past unverified profiles", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-preview-inventory-"))
  const restore = isolateAutomationBridgeRegistry(root)
  t.after(async () => { restore(); await rm(root, { recursive: true, force: true }) })
  let executions = 0
  let refusal: readonly [number, string?] | "closed response" = [404, "browser-not-owner"]
  const bridge = await listen(async (body, reply, request) => {
    if (body.mode === "browser-execute") {
      executions++
      return { result: (body.command as { action: string }).action === "snapshot" ? fixtureSnapshot : { ok: true } }
    }
    if (request.headers["x-codenomad-automation-token"] === owner.token) return { result: { available: true, target: "document" } }
    if (refusal === "closed response") { reply.destroy(); return {} }
    reply.statusCode = refusal[0]
    return { code: refusal[1] }
  })
  t.after(() => closeServer(bridge.server))
  const owner = createAutomationBridgeRegistration(bridge.url)
  const other = createAutomationBridgeRegistration(bridge.url)
  await publishAutomationBridge(owner)
  const browser = createBrowserToolExecutor()
  await browser("session", { action: "snapshot" })
  await publishAutomationBridge(other)
  const press = () => browser("session", { action: "press", key: "Enter" })
  const opener = createBrowserToolExecutor()
  const open = () => opener("session", { action: "open", url: "https://example.test" })
  for (refusal of [[404, "browser-not-owner"], [404, "no-preview-host"]] as const) {
    await press()
    await open()
  }
  const refused = await listen(async () => ({}))
  await closeServer(refused.server)
  const removeRefused = await publishAutomationBridge(createAutomationBridgeRegistration(refused.url))
  await press()
  await open()
  await removeRefused()
  refusal = [404, "hidden-preview"]
  await press()
  const before = executions
  for (const response of [[401], [404], [503, "inventory-unavailable"], "closed response"] as const) {
    refusal = response
    for (const [kind, run] of [["probe", press], ["claim", open]] as const) {
      await t.test(`${kind} ${typeof response === "string" ? response : `HTTP ${response[0]}`}`, async () => {
        const count = executions
        await assert.rejects(run(), /inventory could not be verified/)
        assert.equal(executions, count)
      })
    }
  }
  assert.equal(executions, before)
})

test("preview discovery refuses a redirect to a different, refused HTTP endpoint", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-preview-redirect-"))
  const restore = isolateAutomationBridgeRegistry(root)
  t.after(async () => { restore(); await rm(root, { recursive: true, force: true }) })
  let executions = 0
  const owner = await listen(async body => {
    if (body.mode === "browser-execute") executions++
    return { result: { available: true, target: "document" } }
  })
  t.after(() => closeServer(owner.server))
  const blockedDestination = await listen(async () => ({}))
  await closeServer(blockedDestination.server)
  const redirector = await listen(async (_body, reply) => {
    reply.statusCode = 307
    reply.setHeader("location", new URL(AUTOMATION_BRIDGE_PATH, blockedDestination.url).href)
    return {}
  })
  t.after(() => closeServer(redirector.server))
  const browser = await browserTool(t, root)
  await publishAutomationBridge(createAutomationBridgeRegistration(owner.url))
  await publishAutomationBridge(createAutomationBridgeRegistration(redirector.url))
  for (const command of [{ action: "snapshot" }, { action: "open", url: "https://example.test" }]) {
    await t.test(command.action, async () => {
      await assert.rejects(browser(command), /inventory could not be verified/)
      assert.equal(executions, 0)
    })
  }
})

test("browser execution keeps its exact loopback destination and never replays a redirected action", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-browser-execute-redirect-"))
  const restore = isolateAutomationBridgeRegistry(root)
  t.after(async () => { restore(); await rm(root, { recursive: true, force: true }) })
  const received: unknown[] = []
  const other = await listen(async (body, reply, request) => {
    if (body.mode === "browser-probe") {
      reply.statusCode = 404
      return { code: "browser-not-owner" }
    }
    received.push(["other", request.headers["x-codenomad-automation-token"], body])
    return { result: { text: "unexpected replay" } }
  })
  t.after(() => closeServer(other.server))
  const command = { action: "press", key: "Enter" }
  const owner = await listen(async (body, reply, request) => {
    if (body.mode === "browser-probe") return { result: { available: true, target: "exact-document" } }
    if ((body.command as { action: string }).action === "snapshot") return { result: fixtureSnapshot }
    received.push(["owner", request.headers["x-codenomad-automation-token"], body.mode, body.sessionID, body.target, body.command])
    reply.statusCode = 307
    reply.setHeader("location", new URL(AUTOMATION_BRIDGE_PATH, other.url).href)
    return {}
  })
  t.after(() => closeServer(owner.server))
  const registration = createAutomationBridgeRegistration(owner.url)
  await publishAutomationBridge(registration)
  await publishAutomationBridge(createAutomationBridgeRegistration(other.url))
  const browser = createBrowserToolExecutor()
  await browser("exact-session", { action: "snapshot" })
  const result = await browser("exact-session", command).then(() => "accepted", () => "refused")
  assert.deepEqual({ result, received }, {
    result: "refused",
    received: [["owner", registration.token, "browser-execute", "exact-session", "exact-document", command]],
  })
})

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
    platform: "linux", strict: "browser", env: { SystemRoot: process.env.SystemRoot,
      WSL_DISTRO_NAME: "fixture-unicode", LOCALAPPDATA: windowsPath, LOCALAPPDATA_OTHER: "not the profile",
      XDG_RUNTIME_DIR: "/fixture-linux" },
  }), ["/fixture-linux/codenomad/automation-bridges", `${translated}/CodeNomad/automation-bridges`])
})

test("WSL preview discovery keeps malformed and redirecting Windows advertisements indeterminate", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-preview-wsl-inventory-"))
  const restore = isolateAutomationBridgeRegistry(root)
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!
  t.after(async () => {
    restore()
    Object.defineProperty(process, "platform", platform)
    t.mock.restoreAll()
    syncBuiltinESMExports()
    await rm(root, { recursive: true, force: true })
  })
  const browser = await browserTool(t, root)
  Object.defineProperty(process, "platform", { value: "linux" })
  process.env.WSL_DISTRO_NAME = "fixture-preview-inventory"
  process.env.XDG_RUNTIME_DIR = "/fixture-linux"
  let foreignContents = "{unparseable", vanished = false, redirects = true, windowsOwner = false, mounted = true
  let executions = 0, curlCalls = 0
  const bridge = await listen(async (body, reply) => {
    if (body.mode === "browser-execute") executions++
    if (windowsOwner) { reply.statusCode = 404; return { code: "browser-not-owner" } }
    if ((body.command as { action: string } | undefined)?.action === "snapshot") return { result: fixtureSnapshot }
    return { result: { available: true, target: "document" } }
  })
  t.after(() => closeServer(bridge.server))
  const local = createAutomationBridgeRegistration(bridge.url)
  const foreign = { ...createAutomationBridgeRegistration("http://127.0.0.1:2"), pid: 0x80000000 }
  const registrationName = ({ startedAt, pid }: typeof local, suffix: string) => `${startedAt}-${pid}-${suffix}.json`
  const localName = registrationName(local, "local"), foreignName = registrationName(foreign, "windows")
  let missing: { file: string; code: string } | undefined
  t.mock.method(childProcess, "execFile", (file: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout?: string) => void) => {
    if (missing?.file === file) callback(Object.assign(new Error("Fixture command unavailable"), { code: missing.code }))
    else callback(null, file === "cmd.exe" ? "LOCALAPPDATA=C:/fixture-windows\r\n" : "/fixture-windows\n")
  })
  t.mock.method(fs, "opendir", async (directory: string) => {
    const localDirectory = directory.startsWith("/fixture-linux/")
    if (!localDirectory && !mounted) throw Object.assign(new Error("Mount missing"), { code: "ENOENT" })
    return (async function* () {
      yield { name: localDirectory ? localName : foreignName, isFile: () => true }
    })()
  })
  t.mock.method(fs, "stat", async (directory: string) => {
    assert.equal(directory, "/fixture-windows")
    if (!mounted) throw Object.assign(new Error("Mount missing"), { code: "ENOENT" })
    return { isDirectory: () => true }
  })
  t.mock.method(fs, "open", async (file: string) => {
    const windows = file.endsWith(foreignName)
    if (windows && vanished) throw Object.assign(new Error("File vanished"), { code: "ENOENT" })
    const bytes = Buffer.from(windows ? foreignContents : JSON.stringify(local))
    return { read: async (buffer: Buffer) => ({ bytesRead: bytes.copy(buffer) }), close: async () => undefined }
  })
  t.mock.method(fs, "rm", async () => assert.fail("Windows advertisements are left to their publishers"))
  const windowsActions: unknown[] = [], forwarded: unknown[] = []
  t.mock.method(childProcess, "spawn", (command: string, args: string[]) => {
    curlCalls++
    assert.equal(command, "curl.exe")
    assert.ok(args.includes("--globoff"), "curl cannot expand one bridge address into several requests")
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true,
    })
    let input = ""
    child.stdin.on("data", chunk => { input += chunk.toString() })
    child.stdin.on("finish", () => {
      if (windowsOwner) {
        const body = JSON.parse(input)
        if (body.mode === "browser-probe") child.stdout.write('{"result":{"available":true,"target":"windows-document"}}\n200')
        else if (body.command.action === "snapshot") child.stdout.write(`${JSON.stringify({ result: fixtureSnapshot })}\n200`)
        else {
          const request = [args.at(-1), args.find(arg => arg.startsWith("x-codenomad-automation-token: ")),
            body.mode, body.sessionID, body.target, body.command]
          windowsActions.push(request)
          // Model a curlrc with --location: the redirected POST carries the same payload and custom header.
          if (args[0] === "--disable") child.stdout.write('{"result":{"text":"redirect response"}}\n307')
          else {
            forwarded.push(request)
            child.stdout.write('{"result":{"text":"redirect destination"}}\n200')
          }
        }
        child.emit("close", 0)
        return
      }
      // A user's curl config can enable --location unless the first argument disables it.
      if (redirects && args[0] === "--disable") {
        child.stdout.write('{"code":"browser-not-owner"}\n307')
        child.emit("close", 0)
      } else {
        child.stderr.write(`* connect to 127.0.0.1 port ${redirects ? 3 : 2} failed: Connection refused`)
        child.stdout.write("\n000")
        child.emit("close", 7)
      }
    })
    return child
  })
  syncBuiltinESMExports()
  await t.test("missing cmd.exe leaves Windows browser discovery unverified", async () => {
    missing = { file: "cmd.exe", code: "ENOENT" }
    const before = executions
    await assert.rejects(browser({ action: "snapshot" }), /inventory could not be verified/)
    assert.equal(executions, before)
  })
  for (const code of ["ENOENT", "ENOEXEC"]) {
    await t.test(`${code} from wslpath after cmd.exe succeeds prevents any browser dispatch`, async () => {
      missing = { file: "wslpath", code }
      assert.deepEqual(await automationBridgeDirectories({ strict: true }), ["/fixture-linux/codenomad/automation-bridges"],
        "the Missions rule still permits local discovery")
      const before = executions
      const result = await browser({ action: "snapshot" }).then(() => "accepted", error => error.message)
      assert.deepEqual({ result, executions }, {
        result: "browser-unavailable: The preview inventory could not be verified; take a new snapshot", executions: before,
      })
    })
  }
  missing = undefined
  await t.test("missing Windows mount cannot be treated as an empty registry", async () => {
    mounted = false
    try {
      const before = executions
      await assert.rejects(browser({ action: "open", url: "https://example.test" }), /inventory could not be verified/)
      assert.equal(executions, before)
    } finally { mounted = true }
  })
  await t.test("unreadable JSON", async () => {
    const before = executions
    await assert.rejects(browser({ action: "snapshot" }), /inventory could not be verified/)
    assert.equal(curlCalls, 0)
    assert.equal(executions, before)
  })
  await t.test("redirect", async () => {
    foreignContents = JSON.stringify(foreign)
    const before = executions
    await assert.rejects(browser({ action: "open", url: "https://example.test" }), /inventory could not be verified/)
    assert.equal(curlCalls, 1)
    assert.equal(executions, before)
  })
  redirects = false
  await browser({ action: "snapshot" })
  assert.equal(curlCalls, 2, "a direct connection refusal proves absence")
  vanished = true
  const before = executions
  await browser({ action: "snapshot" })
  assert.equal(executions, before + 1, "a file that vanished before the read is absent")
  await t.test("redirected execution cannot leak its token or replay on another destination", async () => {
    vanished = false
    windowsOwner = true
    const before = executions
    await browser({ action: "snapshot" })
    const command = { action: "press", key: "Enter" }
    const result = await browser(command).then(() => "accepted", () => "refused")
    assert.deepEqual({ result, executions, windowsActions, forwarded }, {
      result: "refused", executions: before, forwarded: [],
      windowsActions: [[foreign.url, `x-codenomad-automation-token: ${foreign.token}`,
        "browser-execute", "fixture", "windows-document", command]],
    })
  })
})

test("preview discovery refuses a 65-profile inventory rather than dropping the oldest owner", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-preview-inventory-cap-"))
  const restore = isolateAutomationBridgeRegistry(root)
  t.after(async () => { restore(); await rm(root, { recursive: true, force: true }) })
  let executions = 0
  const bridge = await listen(async (body, reply, request) => {
    const token = request.headers["x-codenomad-automation-token"]
    if (body.mode === "browser-execute") {
      executions++
      return { result: (body.command as { action: string }).action === "snapshot" ? fixtureSnapshot : { ok: true } }
    }
    if (token === owner.token || token === "oldest") return { result: { available: true, target: token } }
    reply.statusCode = 404
    return { code: "no-preview-host" }
  })
  t.after(() => closeServer(bridge.server))
  const owner = createAutomationBridgeRegistration(bridge.url)
  await publishAutomationBridge(owner)
  const browser = createBrowserToolExecutor()
  await browser("session", { action: "snapshot" })
  const directory = automationBridgeDirectory()
  const add = (token: string, startedAt: number) => writeFile(path.join(directory, `${startedAt}-${process.pid}-${token}.json`),
    JSON.stringify({ ...owner, token, startedAt }))
  await Promise.all(Array.from({ length: 63 }, (_, i) => add(`other${i}`, owner.startedAt + i + 10)))
  const press = () => browser("session", { action: "press", key: "Enter" })
  await press()
  await add("oldest", owner.startedAt - 10)
  await assert.rejects(press(), /inventory could not be verified/)
  assert.equal(executions, 2)
})

test("preview probes carry the smaller of their HTTP budget and the command deadline", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-preview-probe-budget-"))
  const restore = isolateAutomationBridgeRegistry(root)
  t.after(async () => { restore(); await rm(root, { recursive: true, force: true }) })
  const now = Date.now()
  const probes: unknown[] = []
  const bridge = await listen(async body => {
    if (body.mode === "browser-execute") return { result: fixtureSnapshot }
    probes.push(body.deadline)
    return { result: { available: true, target: "document" } }
  })
  t.after(() => closeServer(bridge.server))
  await publishAutomationBridge(createAutomationBridgeRegistration(bridge.url))
  t.mock.method(Date, "now", () => now)
  await executeBrowserTool("session", { action: "snapshot" })
  await executeBrowserTool("session", { action: "snapshot" }, undefined, now + 1_000)
  assert.deepEqual(probes, [now + 5_000, now + 1_000])
})

test("late HTTP responses cannot establish or execute a preview selection", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-preview-http-deadline-"))
  const restore = isolateAutomationBridgeRegistry(root)
  t.after(async () => { restore(); await rm(root, { recursive: true, force: true }) })
  let now = Date.now(), delayProbe = true, executions = 0
  const bridge = await listen(async body => {
    if (body.mode === "browser-probe") {
      if (delayProbe) now = Number(body.deadline) + 1
      return { result: { available: true, target: "document" } }
    }
    executions++
    now = Number(body.deadline) + 1
    return { result: fixtureSnapshot }
  })
  t.after(() => closeServer(bridge.server))
  await publishAutomationBridge(createAutomationBridgeRegistration(bridge.url))
  t.mock.method(Date, "now", () => now)
  const snapshot = { action: "snapshot" }
  await assert.rejects(executeBrowserTool("session", snapshot, undefined, now + 30_000), /inventory could not be verified/)
  assert.equal(executions, 0)
  delayProbe = false
  const browser = createBrowserToolExecutor()
  await assert.rejects(browser("session", snapshot), /preview-expired/)
  await assert.rejects(browser("session", { action: "screenshot" }), /snapshot-required/)
  assert.equal(executions, 1)
})

test("a blocked registry syscall expires without holding the next browser command", { timeout: 10_000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-preview-registry-deadline-"))
  const restore = isolateAutomationBridgeRegistry(root)
  t.after(async () => { restore(); await rm(root, { recursive: true, force: true }) })
  const received: unknown[] = []
  const bridge = await listen(async body => {
    received.push(body.mode)
    return { result: body.mode === "browser-probe" ? { available: true, target: "document" } : fixtureSnapshot }
  })
  t.after(() => closeServer(bridge.server))
  await publishAutomationBridge(createAutomationBridgeRegistration(bridge.url))
  for (const syscall of ["opendir", "open"] as const) await t.test(syscall, async t => {
    let entered!: () => void, release!: () => void, closed!: () => void, resumed = 0
    const started = new Promise<void>(resolve => { entered = resolve })
    const blocker = new Promise<void>(resolve => { release = resolve })
    const handleClosed = new Promise<void>(resolve => { closed = resolve })
    const real = fs[syscall]
    let first = true
    t.mock.method(fs, syscall, async (file: string, flag: "r") => {
      if (!first) return syscall === "open" ? (real as typeof fs.open)(file, flag) : (real as typeof fs.opendir)(file)
      first = false
      entered()
      await blocker
      return {
        close: async () => closed(),
        read: async () => { resumed++; return { bytesRead: 0 } },
        async *[Symbol.asyncIterator]() { resumed++; closed() },
      }
    })
    syncBuiltinESMExports()
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
    const browser = createBrowserToolExecutor()
    const realNow = Date.now
    t.mock.method(Date, "now", () => realNow() - 95_000 + 250, { times: 1 })
    const snapshot = () => browser("fixture", { action: "snapshot" })
    const expired = snapshot().then(() => "unexpected success", (error: Error) => error.message)
    await started
    const next = snapshot()
    const pair = Promise.all([expired, next])
    try {
      const result = await Promise.race([pair, delay(1_500, "held the queue", { ref: false })])
      assert.ok(Array.isArray(result), "expired filesystem work must release the queue")
      assert.match(result[0], /preview-expired/)
      assert.deepEqual(received.splice(0), ["browser-probe", "browser-execute"])
    } finally {
      release()
      await pair
    }
    await handleClosed
    assert.equal(resumed, 0, "a late handle is closed without opening or reading another entry")
    assert.deepEqual(received, [], "an expired discovery cannot dispatch")
  })
})

test("strict browser requests reach loopback even with Node's environment proxy enabled", {
  skip: !process.allowedNodeEnvironmentFlags.has("--use-env-proxy"),
}, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-preview-direct-loopback-"))
  const restore = isolateAutomationBridgeRegistry(root)
  t.after(async () => { restore(); await rm(root, { recursive: true, force: true }) })
  const requests: unknown[] = []
  const bridge = await listen(async (body, _reply, request) => {
    requests.push([body.mode, request.headers["x-codenomad-automation-token"]])
    return { result: body.mode === "browser-execute" ? fixtureSnapshot : { available: true, target: "document" } }
  })
  t.after(() => closeServer(bridge.server))
  const registration = createAutomationBridgeRegistration(bridge.url)
  await publishAutomationBridge(registration)
  let proxyRequests = 0
  const proxy = http.createServer((_request, response) => { proxyRequests++; response.writeHead(502).end() })
  proxy.on("connect", (_request, socket) => { proxyRequests++; socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n") })
  await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve))
  t.after(() => closeServer(proxy))
  const proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`
  await promisify(childProcess.execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import assert from "node:assert/strict"
    import { executeBrowserTool } from ${JSON.stringify(new URL("./automation-plugin.ts", import.meta.url).href)}
    await assert.rejects(fetch(${JSON.stringify(registration.url)}, { method: "POST", body: "{}" }))
    await executeBrowserTool("fixture", { action: "open", url: "https://example.test" })
    await executeBrowserTool("fixture", { action: "snapshot" })
  `], { windowsHide: true, timeout: 10_000, env: {
    ...process.env, NODE_USE_ENV_PROXY: "1", HTTP_PROXY: proxyUrl, http_proxy: proxyUrl, NO_PROXY: "", no_proxy: "",
  } })
  assert.equal(proxyRequests, 1, "only the ordinary fetch reaches the proxy")
  assert.deepEqual(requests, ["browser-claim", "browser-execute", "browser-probe", "browser-execute"].map(mode => [mode, registration.token]))
})

test("a preview pin requires a snapshot result and retains its bridge address", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-preview-pinned-bridge-"))
  const restore = isolateAutomationBridgeRegistry(root)
  t.after(async () => { restore(); await rm(root, { recursive: true, force: true }) })
  let valid = false
  const executed: string[] = []
  const endpoints = await Promise.all(["original", "replacement"].map(name => listen(async body => {
    if (body.mode === "browser-probe") return { result: { available: true, target: "document" } }
    executed.push(name)
    return valid ? { result: fixtureSnapshot } : {}
  })))
  t.after(() => Promise.all(endpoints.map(({ server }) => closeServer(server))))
  const original = createAutomationBridgeRegistration(endpoints[0].url)
  const remove = await publishAutomationBridge(original)
  const browser = createBrowserToolExecutor()
  const snapshot = { action: "snapshot" }, capture = { action: "screenshot" }
  await assert.rejects(browser("session", snapshot), /snapshot result/)
  await assert.rejects(browser("session", capture), /snapshot-required/)
  valid = true
  await browser("session", snapshot)
  await remove()
  await publishAutomationBridge({ ...original, url: new URL(AUTOMATION_BRIDGE_PATH, endpoints[1].url).href })
  await assert.rejects(browser("session", capture), /stale-preview/)
  assert.deepEqual(executed, ["original", "original"])
})

test("an invalid replacement snapshot does not change the preview pin", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-preview-invalid-snapshot-"))
  const restore = isolateAutomationBridgeRegistry(root)
  t.after(async () => { restore(); await rm(root, { recursive: true, force: true }) })
  let reply: unknown = fixtureSnapshot
  const captures: unknown[] = []
  const bridge = await listen(async (body, response, request) => {
    const token = request.headers["x-codenomad-automation-token"]
    if (body.mode === "browser-probe") {
      if (token === active.token) return { result: { available: true, target: active.token } }
      response.statusCode = 404
      return { code: "hidden-preview" }
    }
    if ((body.command as { action: string }).action === "screenshot") captures.push(token)
    return { result: reply }
  })
  t.after(() => closeServer(bridge.server))
  const original = createAutomationBridgeRegistration(bridge.url)
  const replacement = createAutomationBridgeRegistration(bridge.url)
  let active = original
  await publishAutomationBridge(original)
  await publishAutomationBridge(replacement)
  const browser = createBrowserToolExecutor()
  const takeSnapshot = () => browser("session", { action: "snapshot" })
  await takeSnapshot()
  active = replacement
  for (reply of [{ url: "", snapshot: "" }, { ...fixtureSnapshot, collapsed: "unknown" }]) {
    await assert.rejects(takeSnapshot(), /snapshot result/)
  }
  await assert.rejects(browser("session", { action: "screenshot" }), /stale-preview/)
  active = original
  await browser("session", { action: "screenshot" })
  assert.deepEqual(captures, [original.token])
})

test("unscoped snapshots change the preview pin; ref-free actions stay on that pin", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-browser-pin-"))
  const restore = isolateAutomationBridgeRegistry(root)
  t.after(async () => { restore(); await rm(root, { recursive: true, force: true }) })
  let current = "one", probes = 0
  const messages: unknown[] = []
  let seeingNewSnapshot!: () => void, releaseSnapshot!: () => void
  const entered = new Promise<void>(resolve => { seeingNewSnapshot = resolve })
  const hold = new Promise<void>(resolve => { releaseSnapshot = resolve })
  t.after(releaseSnapshot)
  const registration = await listen(async (body, reply) => {
    if (body.mode === "browser-probe") {
      probes++
      return { result: { target: current, available: true } }
    }
    messages.push(body.target)
    if (current === "two" && (body.command as { action: string }).action === "snapshot") {
      seeingNewSnapshot()
      await hold
    }
    if (body.target !== current) {
      reply.statusCode = 409
      return { code: "stale-preview", error: "The preview changed" }
    }
    return { result: { url: "https://example.test", snapshot: "Page" } }
  })
  const remove = await publishAutomationBridge(createAutomationBridgeRegistration(registration.url))
  t.after(async () => { await closeServer(registration.server); await remove() })
  const browser = createBrowserToolExecutor()
  await assert.rejects(browser("session", { action: "press", key: "Enter" }), /snapshot-required/)
  await browser("session", { action: "snapshot" })
  current = "two"
  await assert.rejects(browser("session", { action: "press", key: "Enter" }), /stale-preview/)
  assert.equal(probes, 2)
  const newer = browser("session", { action: "snapshot" })
  await entered
  const queued = assert.rejects(browser("session", { action: "press", key: "Enter" }), /selection changed/)
  releaseSnapshot()
  await newer
  await queued
  await browser("session", { action: "press", key: "Enter" })
  await Promise.all([
    browser("session", { action: "snapshot" }),
    browser("session", { action: "snapshot", ref: "e1" }),
  ])
  assert.equal(probes, 6)
  assert.deepEqual(messages, ["one", "two", "two", "two", "two"])
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
  for (const input of [
    { action: "select", ref: "e1", values: ["Exploration"] },
    { action: "hover", ref: "e1" },
    { action: "press", key: "Shift+Tab" },
    { action: "scroll", ref: "e1", direction: "down", amount: 120 },
    { action: "drag", ref: "e1", to: "e2" },
    { action: "wait", text: "Ready", timeout: 1000, gone: false },
  ]) {
    assert.deepEqual(parseBrowserAction(input), parseDeveloperAction(input), "both surfaces use the same page action contract")
  }
  assert.deepEqual(parseBrowserAction({ action: "snapshot", query: "dialog", ref: "e1" }), { action: "snapshot", query: "dialog", ref: "e1" })
  assert.throws(() => parseBrowserAction({ action: "type", ref: "e1", text: "x", clear: "no" }), /clear must be/)
  assert.throws(() => parseBrowserAction({ action: "snapshot", query: "x".repeat(201) }), /at most 200/)
  assert.throws(() => parseBrowserAction({ action: "evaluate", expression: "document.cookie" }), /Unsupported browser action/)
  assert.equal(formatBrowserSnapshot({ url: "https://example.test", snapshot: '- button "Go" [e1]', collapsed: 0 }),
    'https://example.test\n\n- button "Go" [e1]', "browser outlines are plain text too, not escaped JSON")
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
    assert.match(String((await restart).content), /^CodeNomad restarted; a newer inspection superseded reconnection\.$/)
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
