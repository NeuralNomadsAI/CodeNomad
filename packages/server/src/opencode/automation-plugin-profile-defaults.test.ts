import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import Fastify from "fastify"
import childProcess from "node:child_process"
import { syncBuiltinESMExports } from "node:module"
import fs from "node:fs/promises"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { MissionControlError } from "../missions/control-error"
import { registerAutomationPluginRoute } from "../server/routes/automation-plugin"
import { setupMissionsPlugin } from "./missions-plugin"
import { AUTOMATION_BRIDGE_PATH, automationBridgeDirectories, createAutomationBridgeRegistration, publishAutomationBridge, resolveMissionProfileDefaults, sendMissionInput } from "./automation-plugin"

test("profile defaults distinguish absent owners from ambiguous, failed and unreadable owners", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-profile-default-bridge-"))
  const previous = { LOCALAPPDATA: process.env.LOCALAPPDATA, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, WSL_DISTRO_NAME: process.env.WSL_DISTRO_NAME }
  process.env.LOCALAPPDATA = root
  process.env.XDG_RUNTIME_DIR = root
  delete process.env.WSL_DISTRO_NAME
  const app = Fastify()
  const removals: Array<() => Promise<void>> = []
  t.after(async () => {
    await app.close()
    await Promise.all(removals.map(remove => remove()))
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(root, { recursive: true, force: true })
  })
  const registration = createAutomationBridgeRegistration("http://127.0.0.1:54321")
  let preferences: unknown = [], unreadable = false, denied = false, posts = 0, reads = 0, calls = 0, owned = true, ownershipFailure = false, noWorkspaces = false
  let sessionFailure: "missing" | "unavailable" | undefined
  let probeFailure: "network" | "refused" | "timeout" | "http" | "malformed" | "unproven-negative" | undefined
  let inventoryFailure = false
  let failureCode: string | undefined
  registerAutomationPluginRoute(app, {
    authManager: { isLoopbackRequest: () => true }, bridgeToken: registration.token, nativeParent: {}, developerCdp: {},
    settings: { getRawConfigOwner: () => {
      reads++
      if (unreadable) throw new Error("secret preferences path")
      return { settings: { missionProfileDefaults: preferences } }
    } },
    workspaceManager: {
      getSharedServiceClient: async () => ({ session: { get: async () => {
        if (sessionFailure === "missing") throw Object.assign(new Error("Not found"), { _tag: "SessionNotFoundError", sessionID: "ses_owner" })
        if (sessionFailure) throw new Error("secret native error")
        return { location: { directory: "/repo" } }
      } } }),
      list: () => { if (inventoryFailure) throw new Error("secret inventory failure"); return noWorkspaces ? [] : [{ id: "owner" }] },
      ownsLocation: async (_id: string, _location: unknown, _client: unknown, { strict }: { strict?: boolean }) => {
        if (ownershipFailure) { if (strict) throw new Error("Ownership unavailable"); return false }
        return owned
      },
    },
  } as never)
  t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
    calls++
    const body = JSON.parse(String(options.body))
    const token = new Headers(options.headers).get("x-codenomad-automation-token")
    if (token !== registration.token) return new Response(JSON.stringify({ result: { available: true } }), { status: 200 })
    if (body.mode === "browser-claim") {
      if (probeFailure === "network") throw new Error("secret network error")
      if (probeFailure === "refused") throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("refused"), { code: "ECONNREFUSED" }) })
      if (probeFailure === "timeout") throw Object.assign(new Error("deadline"), { code: "ETIMEDOUT" })
      if (probeFailure === "http") return new Response(JSON.stringify({ error: "secret backend error" }), { status: 503 })
      if (probeFailure === "malformed") return new Response(JSON.stringify({ result: {} }), { status: 200 })
      if (probeFailure === "unproven-negative") return new Response(JSON.stringify({ error: "Session not found" }), { status: 404 })
    }
    if (body.mode === "mission-input") {
      posts++
      assert.equal(body.command.kind, "profile-defaults")
      if (denied) return new Response(JSON.stringify({ error: "secret backend refusal" }), { status: 403 })
      if (failureCode) return new Response(JSON.stringify({ code: failureCode, error: "secret backend detail" }), { status: 409 })
    }
    const response = await app.inject({ method: "POST", url: AUTOMATION_BRIDGE_PATH,
      headers: { "x-codenomad-automation-token": token! }, payload: body })
    return new Response(response.body, { status: response.statusCode })
  })
  const request = () => resolveMissionProfileDefaults("ses_owner", { template: "custom" })
  const unavailable = (error: unknown) => error instanceof MissionControlError
    && error.code === "mission-preferences-unavailable"
    && error.message === "Reload or correct the Missions preferences before creating a mission"
  const fallback = { profiles: { coordinator: {}, roles: { specialist: {} } }, taskMode: "native",
    origins: { coordinator: "opencode-default", roles: { specialist: "opencode-default" }, taskMode: "opencode-default" }, preferences: "unavailable" }
  assert.deepEqual(await request(), fallback, "without a registered owner, the tool reports its explicit fallback")
  const explicit = await resolveMissionProfileDefaults("ses_owner", { template: "custom", profiles: { coordinator: { agent: "lead" } }, taskMode: "independent" }) as any
  assert.deepEqual(explicit.profiles.coordinator, { agent: "lead" })
  assert.equal(explicit.origins.coordinator, "explicit")
  assert.equal(explicit.origins.taskMode, "explicit")
  assert.equal(explicit.preferences, "unavailable")
  await assert.rejects(resolveMissionProfileDefaults("ses_owner", { template: "debug", profiles: { roles: { specialist: {} } } }),
    (error: unknown) => error instanceof MissionControlError && error.code === "invalid-execution")
  await assert.rejects(sendMissionInput("ses_owner", "prepare", {}), (error: unknown) => error instanceof MissionControlError
    && error.code === "prepare-refused", "a prepare with no owner has not been dispatched")
  await assert.rejects(sendMissionInput("ses_owner", "prompt", {}), /exactly one owning/, "other commands keep their error")

  const values = new Map<string, any>(), tools = new Map<string, any>()
  let handlers: any
  const cleanup = await setupMissionsPlugin({
    location: { directory: "/standalone", project: { id: "standalone", canonical: "/standalone" } },
    storage: {
      get: async (key: string) => structuredClone(values.get(key)),
      set: async (key: string, value: unknown) => { values.set(key, structuredClone(value)) },
      remove: async (key: string) => { values.delete(key) },
      scan: async ({ prefix }: { prefix: string }) => ({ entries: [...values].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })) }),
    },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, agent: "lead", projectID: "standalone", location: { directory: "/standalone" } }),
      create: async () => assert.fail("Standalone inspect attaches its caller"),
      prompt: async () => assert.fail("Creation never prompts"), synthetic: async () => assert.fail("Creation never resumes"),
      hook: async () => ({ dispose: async () => {} }),
    },
    agent: { list: async () => ({ data: [{ id: "lead", mode: "primary" }] }) }, model: { list: async () => ({ data: [] }) },
    tool: { transform: async (callback: any) => { callback({ namespace() {}, add(tool: any) { tools.set(tool.name, tool) } }); return { dispose: async () => {} } } },
    rpc: { register: async (_definition: unknown, registered: unknown) => { handlers = registered; return { dispose: async () => {}, events: { emit: async () => {} } } } },
  } as never, {
    prompt: async () => assert.fail("Creation never prompts"), synthetic: async () => assert.fail("Creation never resumes"),
    resolveCreationDefaults: resolveMissionProfileDefaults,
    prepare: (id, input) => sendMissionInput(id, "prepare", input),
  })
  t.after(cleanup)
  const toolContext = { sessionID: "ses_standalone", messageID: "msg_standalone", id: "standalone-start", progress: async () => {} }
  const start = { start: { objective: "Standalone creation", template: "custom" } }
  const started = JSON.parse((await tools.get("inspect").execute(start, toolContext)).content)
  assert.deepEqual(started.selection, fallback)
  const saved = (await handlers.snapshot()).missions[0]
  assert.equal(saved.creationDefaults.preferences, "unavailable")
  const explicitContext = { ...toolContext, sessionID: "ses_explicit", id: "explicit-start" }
  const explicitStart = { start: { objective: "Explicit standalone", template: "custom", profiles: { coordinator: { agent: "lead" } }, taskMode: "independent" } }
  const explicitCreated = JSON.parse((await tools.get("inspect").execute(explicitStart, explicitContext)).content)
  assert.equal(explicitCreated.selection.preferences, "unavailable")
  assert.deepEqual(explicitCreated.selection.profiles.coordinator, { agent: "lead" })
  assert.equal(explicitCreated.selection.origins.coordinator, "explicit")
  assert.equal(explicitCreated.selection.origins.taskMode, "explicit")
  assert.equal((await handlers.snapshot()).missions.find((mission: any) => mission.id === explicitCreated.mission.id).creationDefaults.preferences, "unavailable")
  await assert.rejects(tools.get("prepare").execute({ requestID: "no-backend", objective: "Handoff", template: "custom" }, toolContext),
    (error: unknown) => error instanceof MissionControlError && error.code === "prepare-refused")
  assert.equal((await handlers.snapshot()).missions.length, 2, "backend-less hand-offs remain unavailable")
  assert.equal([...values.keys()].some(key => key.includes("/creation-intents/")), false)

  const registry = automationBridgeDirectories()[0]
  await mkdir(registry, { recursive: true })
  const deadFile = path.join(registry, `${Date.now()}-2147483647-dead.json`)
  await writeFile(deadFile, "{unreadable")
  assert.deepEqual(await request(), fallback, "a dead publishing pid is absent even when its registration cannot be parsed")
  await assert.rejects(readFile(deadFile), (error: any) => error.code === "ENOENT")
  const liveFile = path.join(registry, `${Date.now()}-${process.pid}-unknown.json`)
  await writeFile(liveFile, "{unreadable")
  await assert.rejects(request(), unavailable, "an unreadable live publisher cannot safely be ignored")
  const unpublish = await publishAutomationBridge(registration)
  try { assert.equal(await readFile(liveFile, "utf8"), "{unreadable", "another publisher's cleanup preserves unreadable live registrations") }
  finally { await unpublish() }
  await rm(liveFile)

  removals.push(await publishAutomationBridge(registration))
  const resolved = await request() as { taskMode: string }
  assert.equal(resolved.taskMode, "native")
  assert.equal("preferences" in resolved, false, "readable owner preferences need no unavailable warning")
  const beforeNegative = reads
  owned = false
  assert.deepEqual(await request(), fallback, "clean non-ownership remains negative proof while unrelated workspaces are open")
  noWorkspaces = true
  assert.deepEqual(await request(), fallback, "a backend with no open workspace cannot own this session")
  noWorkspaces = false
  owned = true
  sessionFailure = "missing"
  assert.deepEqual(await request(), fallback, "a typed native missing-session reply proves this backend is not an owner")
  assert.equal(reads, beforeNegative)
  sessionFailure = "unavailable"
  await assert.rejects(request(), unavailable, "a failed session lookup cannot prove that no owner exists")
  sessionFailure = undefined
  ownershipFailure = true
  await assert.rejects(request(), unavailable)
  ownershipFailure = false
  inventoryFailure = true
  await assert.rejects(request(), unavailable)
  inventoryFailure = false
  probeFailure = "refused"
  assert.deepEqual(await request(), fallback, "a stale Windows or local registration with no listener is absent")
  for (probeFailure of ["network", "timeout", "http", "malformed", "unproven-negative"] as const) await assert.rejects(request(), unavailable, "a registered backend failure refuses fallback")
  probeFailure = undefined
  preferences = [{ template: "all", profiles: {}, taskMode: "independent" }]
  assert.equal((await request() as { taskMode: string }).taskMode, "independent", "the next bridge call reads fresh preferences")
  preferences = "secret-invalid-value"
  const beforeExplicit = posts
  const callsBeforeExplicit = calls
  const complete = await resolveMissionProfileDefaults("ses_owner", { template: "custom",
    profiles: { coordinator: {}, roles: { specialist: {} } }, taskMode: "native" }) as any
  assert.deepEqual(complete.origins, { coordinator: "explicit", roles: { specialist: "explicit" }, taskMode: "explicit" })
  assert.equal("preferences" in complete, false, "unused preference availability is not invented")
  assert.equal(posts, beforeExplicit, "complete explicit choices do not reach the broken preference document")
  assert.equal(calls, callsBeforeExplicit, "complete explicit choices skip every backend probe and request")
  await assert.rejects(request(), (error: unknown) => error instanceof MissionControlError
    && error.code === "mission-preferences-invalid" && error.message === "Correct the Missions preferences before creating a mission")
  unreadable = true
  await assert.rejects(request(), unavailable)
  unreadable = false
  denied = true
  await assert.rejects(request(), unavailable, "untyped backend refusals must also remain fixed")
  denied = false
  for (const code of ["compare-models-required", "compare-models-identical"]) {
    failureCode = code
    await assert.rejects(request(), (error: unknown) => error instanceof MissionControlError
      && error.code === code && error.message.startsWith("Choose ") && !error.message.includes("secret"))
  }
  failureCode = undefined
  const before = posts
  removals.push(await publishAutomationBridge(createAutomationBridgeRegistration("http://127.0.0.1:54322")))
  await assert.rejects(request(), unavailable, "multiple owners must expose the same fixed preference refusal")
  await assert.rejects(sendMissionInput("ses_owner", "prepare", {}), (error: unknown) => error instanceof MissionControlError
    && error.code === "prepare-refused", "an ambiguous prepare has not been dispatched")
  assert.equal(posts, before, "ambiguous ownership reads no preferences")
  assert.deepEqual(JSON.parse((await tools.get("inspect").execute(start, toolContext)).content).selection, fallback,
    "a saved standalone warning is stable even after backends appear and become ambiguous")
  assert.deepEqual(JSON.parse((await tools.get("inspect").execute(explicitStart, explicitContext)).content).selection, explicitCreated.selection)
  assert.equal(posts, before, "the saved creation is returned without another preference request")
})

test("strict WSL discovery cannot omit an unobserved Windows registry", () => {
  const options = { platform: "linux" as const, env: { WSL_DISTRO_NAME: "fixture" }, home: "/fixture", windowsLocalAppData: null }
  assert.deepEqual(automationBridgeDirectories(options), ["/fixture/.config/codenomad/automation-bridges"])
  assert.throws(() => automationBridgeDirectories({ ...options, strict: true }), /Windows mission backend discovery is unavailable/)
  assert.deepEqual(automationBridgeDirectories({ ...options, windowsLocalAppData: "/mnt/c/fixture", strict: true }), [
    "/fixture/.config/codenomad/automation-bridges", "/mnt/c/fixture/CodeNomad/automation-bridges",
  ])
})

test("strict WSL discovery retries a failed cached Windows registry lookup", t => {
  let attempts = 0
  const mocked = t.mock.method(childProcess, "execFileSync", () => { attempts++; throw new Error("Host lookup failed") })
  syncBuiltinESMExports()
  t.after(() => { mocked.mock.restore(); syncBuiltinESMExports() })
  const options = { platform: "linux" as const, env: { WSL_DISTRO_NAME: "fixture" }, home: "/fixture" }
  assert.deepEqual(automationBridgeDirectories(options), ["/fixture/.config/codenomad/automation-bridges"])
  assert.equal(attempts, 1)
  assert.throws(() => automationBridgeDirectories({ ...options, strict: true }), /Windows mission backend discovery is unavailable/)
  assert.equal(attempts, 2, "an old failed lookup is not reused as negative ownership evidence")
})

test("WSL Windows discovery skips unusable advertisements and refused endpoints, retaining live failures", async t => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!
  const previous = { WSL_DISTRO_NAME: process.env.WSL_DISTRO_NAME, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR }
  Object.defineProperty(process, "platform", { value: "linux", configurable: true })
  process.env.WSL_DISTRO_NAME = "fixture"
  process.env.XDG_RUNTIME_DIR = "/fixture-linux"
  t.after(() => {
    Object.defineProperty(process, "platform", platform)
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value
    }
    t.mock.restoreAll()
    syncBuiltinESMExports()
  })
  const registration = createAutomationBridgeRegistration("http://127.0.0.1:1")
  let bytes = Buffer.from(JSON.stringify(registration)), probes = 0, readFailed = false
  t.mock.method(process, "kill", () => assert.fail("Windows publisher PIDs cannot be checked from WSL"))
  t.mock.method(fs, "rm", async () => assert.fail("WSL leaves foreign advertisements to their publisher"))
  t.mock.method(childProcess, "execFileSync", () => "/fixture-windows")
  t.mock.method(fs, "opendir", async (directory: string) => (async function* () {
    if (directory.startsWith("/fixture-windows/")) yield {
      name: `${registration.startedAt}-${registration.pid}-windows.json`, isFile: () => true,
    }
  })())
  t.mock.method(fs, "open", async () => {
    if (readFailed) throw Object.assign(new Error("Permission denied"), { code: "EACCES" })
    return { read: async (buffer: Buffer) => { bytes.copy(buffer); return { bytesRead: bytes.length } }, close: async () => {} }
  })
  let exit = 7, status = 0, diagnostic = "* connect to 127.0.0.1 port 1 failed: Connection refused"
  t.mock.method(childProcess, "spawn", (command: string, args: string[]) => {
    probes++
    assert.equal(command, "curl.exe")
    assert.deepEqual(args.slice(args.indexOf("--noproxy"), args.indexOf("--noproxy") + 2), ["--noproxy", "*"])
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true,
    })
    child.stdin.on("finish", () => setImmediate(() => {
      child.stderr.write(diagnostic)
      child.stdout.write(`${JSON.stringify({ error: "fixture refusal" })}\n${status}`)
      child.emit("close", exit)
    }))
    return child
  })
  syncBuiltinESMExports()
  const request = () => resolveMissionProfileDefaults("ses_wsl", { template: "custom" })
  assert.equal((await request() as any).preferences, "unavailable", "curl's connection-refused diagnostic proves no Windows listener")
  for (diagnostic of ["* connect to 127.0.0.1 port 1 failed: Permission denied (10013)", "curl: (7) Could not connect to server"]) {
    await assert.rejects(request(), (error: unknown) => error instanceof MissionControlError && error.code === "mission-preferences-unavailable",
      "curl exit 7 without a refusal diagnostic leaves ownership indeterminate")
  }
  for (const failure of [{ exit: 28, status: 0 }, { exit: 0, status: 503 }, { exit: 0, status: 401 }]) {
    ;({ exit, status } = failure)
    await assert.rejects(request(), (error: unknown) => error instanceof MissionControlError && error.code === "mission-preferences-unavailable")
  }
  const beforeInvalid = probes
  for (const value of [JSON.stringify({ ...registration, version: 0 }), "x".repeat(4097),
    JSON.stringify({ ...registration, url: "http://example.invalid" }), "{unparseable"]) {
    bytes = Buffer.from(value)
    assert.equal((await request() as any).preferences, "unavailable", "an unusable foreign advertisement supplies no current bridge contract")
  }
  assert.equal(probes, beforeInvalid, "unusable advertisements never select a bridge or admit work")
  readFailed = true
  await assert.rejects(request(), (error: unknown) => error instanceof MissionControlError && error.code === "mission-preferences-unavailable",
    "a failed file read may hide a valid owner and stays distinct from malformed foreign content")
})
