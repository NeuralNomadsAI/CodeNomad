import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import Fastify from "fastify"
import childProcess from "node:child_process"
import { syncBuiltinESMExports } from "node:module"
import { MissionControlError } from "../missions/control-error"
import { registerAutomationPluginRoute } from "../server/routes/automation-plugin"
import { setupMissionsPlugin } from "./missions-plugin"
import { AUTOMATION_BRIDGE_PATH, automationBridgeDirectories, createAutomationBridgeRegistration, publishAutomationBridge, sendMissionInput } from "./automation-plugin"

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
  let preferences: unknown = [], unreadable = false, denied = false, posts = 0, reads = 0, owned = true, ownershipFailure = false, noWorkspaces = false
  let sessionFailure: "missing" | "unavailable" | undefined
  let probeFailure: "network" | "http" | "malformed" | "unproven-negative" | undefined
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
      ownsLocation: async () => { if (ownershipFailure) throw new Error("Ownership unavailable"); return owned },
    },
  } as never)
  t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
    const body = JSON.parse(String(options.body))
    const token = new Headers(options.headers).get("x-codenomad-automation-token")
    if (token !== registration.token) return new Response(JSON.stringify({ result: { available: true } }), { status: 200 })
    if (body.mode === "browser-claim") {
      if (probeFailure === "network") throw new Error("secret network error")
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
  const request = () => sendMissionInput("ses_owner", "profile-defaults", { template: "custom" })
  const unavailable = (error: unknown) => error instanceof MissionControlError
    && error.code === "mission-preferences-unavailable"
    && error.message === "Reload or correct the Missions preferences before creating a mission"
  const fallback = { profiles: { coordinator: {}, roles: { specialist: {} } }, taskMode: "native",
    origins: { coordinator: "opencode-default", roles: { specialist: "opencode-default" }, taskMode: "opencode-default" }, preferences: "unavailable" }
  assert.deepEqual(await request(), fallback, "without a registered owner, the tool reports its explicit fallback")
  const explicit = await sendMissionInput("ses_owner", "profile-defaults", { template: "custom", profiles: { coordinator: { agent: "lead" } }, taskMode: "independent" }) as any
  assert.deepEqual(explicit.profiles.coordinator, { agent: "lead" })
  assert.equal(explicit.origins.coordinator, "explicit")
  assert.equal(explicit.origins.taskMode, "explicit")
  assert.equal(explicit.preferences, "unavailable")
  await assert.rejects(sendMissionInput("ses_owner", "profile-defaults", { template: "debug", profiles: { roles: { specialist: {} } } }),
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
    resolveCreationDefaults: (id, input) => sendMissionInput(id, "profile-defaults", input),
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

  removals.push(await publishAutomationBridge(registration))
  const resolved = await request() as { taskMode: string }
  assert.equal(resolved.taskMode, "native")
  assert.equal("preferences" in resolved, false, "readable owner preferences need no unavailable warning")
  const beforeNegative = reads
  owned = false
  await assert.rejects(request(), unavailable, "a false authorization can hide failed Git or WSL reads")
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
  for (probeFailure of ["network", "http", "malformed", "unproven-negative"] as const) await assert.rejects(request(), unavailable, "a registered backend failure refuses fallback")
  probeFailure = undefined
  preferences = [{ template: "all", profiles: {}, taskMode: "independent" }]
  assert.equal((await request() as { taskMode: string }).taskMode, "independent", "the next bridge call reads fresh preferences")
  preferences = "secret-invalid-value"
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
