import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import Fastify from "fastify"
import { MissionControlError } from "../missions/control-error"
import { registerAutomationPluginRoute } from "../server/routes/automation-plugin"
import { AUTOMATION_BRIDGE_PATH, createAutomationBridgeRegistration, publishAutomationBridge, sendMissionInput } from "./automation-plugin"

test("profile defaults preserve typed refusals through the authenticated bridge and require one owner", async t => {
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
  let preferences: unknown = [], unreadable = false, denied = false, posts = 0
  let failureCode: string | undefined
  registerAutomationPluginRoute(app, {
    authManager: { isLoopbackRequest: () => true }, bridgeToken: registration.token, nativeParent: {}, developerCdp: {},
    settings: { getRawConfigOwner: () => {
      if (unreadable) throw new Error("secret preferences path")
      return { settings: { missionProfileDefaults: preferences } }
    } },
    workspaceManager: {
      getSharedServiceClient: async () => ({ session: { get: async () => ({ location: { directory: "/repo" } }) } }),
      list: () => [{ id: "owner" }], ownsLocation: async () => true,
    },
  } as never)
  t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
    const body = JSON.parse(String(options.body))
    const token = new Headers(options.headers).get("x-codenomad-automation-token")
    if (token !== registration.token) return new Response(JSON.stringify({ result: { available: true } }), { status: 200 })
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
  await assert.rejects(request(), unavailable, "zero owners must expose a preference refusal")
  await assert.rejects(sendMissionInput("ses_owner", "prepare", {}), (error: unknown) => error instanceof MissionControlError
    && error.code === "prepare-refused", "a prepare with no owner has not been dispatched")
  await assert.rejects(sendMissionInput("ses_owner", "prompt", {}), /exactly one owning/, "other commands keep their error")

  removals.push(await publishAutomationBridge(registration))
  const resolved = await request() as { taskMode: string }
  assert.equal(resolved.taskMode, "native")
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
})
