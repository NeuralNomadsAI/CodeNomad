import assert from "node:assert/strict"
import test from "node:test"
import { isDeepStrictEqual } from "node:util"
import { OpenCode } from "@opencode/client"
import type { WorkspaceDescriptor } from "../../api-types"
import type { ServiceConnection } from "../../workspaces/opencode-service"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { sessionEnvironment } from "../../workspaces/session-environment"
import { createMissionNativePreparation, MissionNativePreparationError,
  type MissionNativePreparationIdentity, type MissionNativePreparationAuthority } from "./mission-native-preparation"

type Stage = "connection" | "native-read" | "owns" | "worktree" | "authority" | "authority-after" | "snapshot" | "environment"
type NativeRecord = { id: string; parentID?: string; projectID: string; location: { directory: string; workspaceID?: string } }

function fixture() {
  const identity: MissionNativePreparationIdentity = {
    version: 1, scope: "bound-native-child", workspaceID: "workspace", projectID: "project", rootSessionID: "ses_root",
    sessionID: "ses_child", parentSessionID: "ses_root", location: { directory: "/repo" },
    profileKey: "profile", profileGeneration: 1, connectionIncarnation: "daemon-1", lifecycleGeneration: 1,
    task: { missionID: "mission", taskKey: "task", generation: 1 },
    execution: { incarnation: "execution-1", callerSessionID: "ses_root", messageID: "msg_parent", callID: "call_1", boundary: "child-first-prompt" },
  }
  const state = {
    expected: structuredClone(identity), trusted: true, connected: true, published: true,
    configured: { TEMP: "profile-temp" } as Record<string, string>, wsl: false, reads: 0, wslReads: 0, preparations: 0,
    worktree: "/repo", failEnvironment: false,
    hook: async (_stage: Stage) => {},
  }
  let workspace: WorkspaceDescriptor = { id: "workspace", path: "/repo", status: "ready", proxyPath: "/workspace/instance/",
    binaryId: "host", binaryLabel: "host", createdAt: "now", updatedAt: "now" }
  const records = new Map<string, NativeRecord>([
    ["ses_root", { id: "ses_root", projectID: "project", location: { directory: "/repo" } }],
    ["ses_child", { id: "ses_child", parentID: "ses_root", projectID: "project", location: { directory: "/repo" } }],
    ["ses_raw", { id: "ses_raw", parentID: "ses_child", projectID: "project", location: { directory: "/repo" } }],
  ])
  const writes: Array<{ sessionID: string; variables: Record<string, string> }> = []
  const requests: string[] = []
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const method = init?.method ?? "GET"
    requests.push(`${method} ${url.pathname}`)
    if (method === "GET" && /^\/api\/session\/[^/]+$/.test(url.pathname)) {
      const sessionID = decodeURIComponent(url.pathname.split("/").at(-1)!)
      const record = structuredClone(records.get(sessionID))
      await state.hook("native-read")
      return record ? Response.json({ data: record }) : Response.json({}, { status: 404 })
    }
    if (method === "PUT" && /^\/api\/session\/[^/]+\/environment$/.test(url.pathname)) {
      const sessionID = decodeURIComponent(url.pathname.split("/").at(-2)!)
      const body = JSON.parse(String(init?.body)) as { variables: Record<string, string> }
      writes.push({ sessionID, variables: body.variables })
      await state.hook("environment")
      if (state.failEnvironment) throw new Error("AMBIGUOUS SECRET ENV request body")
      return new Response(null, { status: 204 })
    }
    assert.fail(`Unexpected execution request ${method} ${url.pathname}`)
  }
  const connection: ServiceConnection = {
    endpoint: { url: "http://127.0.0.1:1" }, client: OpenCode.make({ baseUrl: "http://127.0.0.1:1", fetch: fetcher }), fetch: fetcher,
    assertCurrent: () => { if (!state.connected) throw new Error("Reconnected") },
    invalidate: () => { state.connected = false }, profile: async () => "modern",
  }
  const authority: MissionNativePreparationAuthority = {
    prepare: async value => {
      assert.deepEqual(value, state.expected)
      state.preparations++
      await state.hook(writes.length ? "authority-after" : "authority")
    },
    current: value => {
      if (!state.trusted || !isDeepStrictEqual(value, state.expected)) throw new Error("Retired genuine call proof")
      return true
    },
  }
  const manager = {
    get: (workspaceID: string) => state.published && workspaceID === workspace.id ? workspace : undefined,
    getSharedServiceConnection: async (_workspaceID: string) => { await state.hook("connection"); return connection },
    ownsLocation: async (workspaceID: string, location: { directory: string; workspaceID?: string }) => {
      await state.hook("owns")
      return workspaceID === workspace.id && location.directory === "/repo" && location.workspaceID === undefined
    },
    getWorktreeIdentityForPath: async () => { await state.hook("worktree"); return state.worktree },
    getSessionEnvironment: async (_workspaceID: string, signal?: AbortSignal) => {
      state.reads++
      const configured = structuredClone(state.configured)
      await state.hook("snapshot")
      return sessionEnvironment(configured, {
        signal, platform: "win32", environment: { Path: "C:/host", TEMP: "host-temp", HOME: "host-home", OPENCODE_DB: "db",
          CODENOMAD_AUTOMATION_BRIDGE_TOKEN: "private-token", OPENCODE_SERVER_PASSWORD: "private-password" },
        ...(state.wsl ? { distro: "Fixture", readWsl: async () => {
          state.wslReads++
          return { PATH: "/linux/bin", HOME: "/linux/home", XDG_STATE_HOME: "/owned-db", OPENCODE_PASSWORD: "private-password" }
        } } : {}),
      })
    },
  }
  const fence = new WorktreeDeletionFence()
  const adapter = createMissionNativePreparation({ manager, fence, authority })
  const signal = new AbortController()
  const prepare = () => adapter.prepare(identity, signal.signal)
  const replaceWorkspace = () => { workspace = { ...workspace } }
  return { identity, state, records, writes, requests, connection, authority, manager, fence, adapter, signal, prepare, replaceWorkspace }
}

test("identity-only receipt; fresh complete snapshots on every required boundary, never execution", async () => {
  const f = fixture()
  for (const boundary of ["child-first-prompt", "prompt", "command", "shell", "tool-before", "shell-environment"] as const) {
    f.identity.execution.boundary = boundary
    f.identity.execution.incarnation = `execution-${boundary}`
    f.state.expected = structuredClone(f.identity)
    const prepared = await f.prepare()
    assert.deepEqual(prepared.receipt, { ...f.identity, prepared: true })
    assert.equal(prepared.current(), true)
    assert.ok(Object.isFrozen(prepared.receipt.location))
    assert.ok(!JSON.stringify(prepared.receipt).includes("profile-temp"))
    prepared.dispose()
    assert.throws(prepared.current, /native-preparation-stale/)
  }
  assert.equal(f.state.reads, 6)
  assert.equal(f.writes.length, 6)
  assert.deepEqual(f.writes[0].variables, { Path: "C:/host", TEMP: "profile-temp", HOME: "host-home" })
  f.state.configured = {}
  const next = await f.prepare()
  assert.equal(f.writes.at(-1)?.variables.TEMP, "host-temp")
  next.dispose()
  assert.ok(f.requests.every(request => request.startsWith("GET ") || request.endsWith("/environment")))
})

test("WSL snapshots use complete Linux host data, never Windows PATH/HOME or private/storage data", async () => {
  const f = fixture()
  f.state.wsl = true
  const prepared = await f.prepare()
  assert.deepEqual(f.writes[0].variables, { PATH: "/linux/bin", HOME: "/linux/home", TEMP: "profile-temp" })
  assert.equal(f.state.wslReads, 1)
  prepared.dispose()
})

test("ordinary roots and raw descendants use the same admission, without task/report privilege", async () => {
  for (const [sessionID, parentSessionID] of [["ses_root", null], ["ses_raw", "ses_child"]] as const) {
    const f = fixture()
    Object.assign(f.identity, { scope: "owned-family", sessionID, parentSessionID })
    delete f.identity.task
    f.state.expected = structuredClone(f.identity)
    const prepared = await f.prepare()
    assert.equal(prepared.receipt.task, undefined)
    assert.equal(f.writes[0].sessionID, sessionID)
    prepared.dispose()
  }
})

test("missing or asynchronous trusted checkpoint never admits", async () => {
  const f = fixture()
  assert.throws(() => createMissionNativePreparation({ manager: f.manager, fence: f.fence, authority: undefined! }), /native-authority-unavailable/)
  const adapter = createMissionNativePreparation({ manager: f.manager, fence: f.fence,
    authority: { prepare: f.authority.prepare, current: (() => Promise.resolve(true)) as never } })
  await assert.rejects(adapter.prepare(f.identity, f.signal.signal), /native-preparation-stale/)
  assert.equal(f.writes.length, 0)
})

for (const mismatch of ["wrong-workspace", "wrong-project", "sibling-location", "historical-workspace", "wrong-parent", "unresolved-root", "cycle", "depth"] as const) {
  test(`native bounded ancestry rejects ${mismatch}`, async () => {
    const f = fixture()
    const child = f.records.get("ses_child")!
    if (mismatch === "wrong-workspace") f.identity.workspaceID = "other-workspace"
    if (mismatch === "wrong-project") child.projectID = "other-project"
    if (mismatch === "sibling-location") child.location.directory = "/repo/sibling"
    if (mismatch === "historical-workspace") child.location.workspaceID = "historical-wrong"
    if (mismatch === "wrong-parent") child.parentID = "ses_raw"
    if (mismatch === "unresolved-root") f.records.delete("ses_root")
    if (mismatch === "cycle") f.records.get("ses_root")!.parentID = "ses_child"
    if (mismatch === "depth") {
      child.parentID = f.identity.parentSessionID = "ses_0"
      for (let index = 0; index < 34; index++) f.records.set(`ses_${index}`, {
        id: `ses_${index}`, parentID: index === 33 ? "ses_root" : `ses_${index + 1}`, projectID: "project", location: { directory: "/repo" },
      })
    }
    f.state.expected = structuredClone(f.identity)
    await assert.rejects(f.prepare(), MissionNativePreparationError)
    assert.equal(f.writes.length, 0)
    assert.ok(f.requests.length <= 34)
  })
}

for (const scope of ["bound-native-child", "owned-family"] as const) {
  for (const stage of ["authority", "snapshot", "environment", "authority-after"] as const) {
    for (const race of ["profile", "task", "lifecycle", "call", "reconnect", "deletion", "move", "workspace", "dispose", "abort"] as const) {
      test(`${scope}: ${race} during ${stage} await refuses receipt/subsequent execution`, async () => {
        const f = fixture()
        if (scope === "owned-family") {
          // Raw descendants may carry the family's policy generation, but receive
          // no business binding/report/topology capability from this adapter.
          Object.assign(f.identity, { scope, sessionID: "ses_raw", parentSessionID: "ses_child" })
          f.state.expected = structuredClone(f.identity)
        }
        let deletion: Promise<unknown> | undefined
        let fired = false
        f.state.hook = async point => {
          if (point !== stage || fired) return
          fired = true
          if (race === "profile") f.state.expected.profileGeneration++
          if (race === "task") f.state.expected.task!.generation++
          if (race === "lifecycle") f.state.expected.lifecycleGeneration++
          if (race === "call") f.state.expected.execution.callID = "another-call"
          if (race === "reconnect") f.state.connected = false
          if (race === "deletion") deletion = f.fence.run("/repo", ["/repo"], async () => true)
          if (race === "move") f.records.get(f.identity.sessionID)!.location.directory = "/moved"
          if (race === "workspace") f.replaceWorkspace()
          if (race === "dispose") f.adapter.dispose()
          if (race === "abort") f.signal.abort()
        }
        await assert.rejects(f.prepare(), MissionNativePreparationError)
        assert.equal(f.writes.length, stage === "environment" || stage === "authority-after" ? 1 : 0)
        await deletion
      })
    }
  }
}

test("worktree deletion fence stays held until execution release; queued deletion revokes current", async () => {
  const f = fixture()
  const prepared = await f.prepare()
  let ran = false
  const deletion = f.fence.run("/repo", ["/repo"], async () => { ran = true })
  await Promise.resolve()
  assert.equal(ran, false)
  assert.throws(prepared.current, /native-preparation-stale/)
  prepared.dispose()
  await deletion
  assert.equal(ran, true)
})

test("captured current fences revoke after profile/task/lifecycle/call/reconnect/disposal", async () => {
  for (const revoke of ["profile", "task", "lifecycle", "call", "reconnect", "dispose", "release"] as const) {
    const f = fixture()
    const prepared = await f.prepare()
    const captured = prepared.current
    if (revoke === "profile") f.state.expected.profileKey = "replacement-profile"
    if (revoke === "task") f.state.expected.task!.generation++
    if (revoke === "lifecycle") f.state.expected.lifecycleGeneration++
    if (revoke === "call") f.state.expected.execution.incarnation = "new-execution"
    if (revoke === "reconnect") f.state.connected = false
    if (revoke === "dispose") f.adapter.dispose()
    if (revoke === "release") prepared.dispose()
    assert.throws(captured, /native-preparation-stale/)
    prepared.dispose()
  }
})

test("ambiguous ENV acknowledgement is redacted, not retried or converted into a receipt", async () => {
  const f = fixture()
  f.state.failEnvironment = true
  const error = await f.prepare().catch(error => error)
  assert.equal(error.code, "native-environment-uncertain")
  assert.equal(error.cause, undefined)
  assert.ok(!String(error.stack).includes("SECRET"))
  assert.equal(f.writes.length, 1)
  let deletionRan = false
  await f.fence.run("/repo", ["/repo"], async () => { deletionRan = true })
  assert.equal(deletionRan, true)
})

test("input mutation cannot change the captured identity or receipt", async () => {
  const f = fixture()
  f.state.hook = async stage => {
    if (stage === "snapshot") f.identity.execution.incarnation = "caller-mutated"
  }
  const prepared = await f.prepare()
  assert.equal(prepared.receipt.execution.incarnation, "execution-1")
  assert.equal(prepared.current(), true)
  prepared.dispose()
})

test("unknown caller refs, generations, daemon/incarnation and task identities cannot become authority", async () => {
  for (const change of ["sibling-call", "parent-message", "profile", "daemon", "incarnation", "task"] as const) {
    const f = fixture()
    if (change === "sibling-call") f.identity.execution.callerSessionID = "ses_sibling"
    if (change === "parent-message") f.identity.execution.messageID = "msg_unrelated"
    if (change === "profile") f.identity.profileKey = "other-profile"
    if (change === "daemon") f.identity.connectionIncarnation = "other-daemon"
    if (change === "incarnation") f.identity.execution.incarnation = "other-execution"
    if (change === "task") f.identity.task!.generation++
    await assert.rejects(f.prepare(), /native-preparation-stale/)
    assert.equal(f.requests.length, 0)
  }
})

test("native family and physical identities recheck after ENV and after protected preparation", async () => {
  for (const change of ["parent", "project", "worktree", "unknown-root"] as const) {
    const f = fixture()
    f.state.hook = async stage => {
      if (stage !== "authority-after") return
      if (change === "parent") f.records.get("ses_child")!.parentID = "ses_raw"
      if (change === "project") f.records.get("ses_root")!.projectID = "changed-project"
      if (change === "worktree") f.state.worktree = "/new-physical-root"
      if (change === "unknown-root") f.records.delete("ses_root")
    }
    await assert.rejects(f.prepare(), MissionNativePreparationError)
    assert.equal(f.writes.length, 1)
  }
})

test("synchronous trusted native currentness fences the last identity-read await", async () => {
  const f = fixture()
  f.state.hook = async stage => {
    if (stage === "owns" && f.writes.length) {
      // The genuine protected native callback must synchronously observe actual
      // identity revocation. A cached record from prepare is not sufficient.
      f.state.trusted = false
    }
  }
  await assert.rejects(f.prepare(), /native-preparation-stale/)
  assert.equal(f.writes.length, 1)
})

test("bound child requires business-generation identity; payload/ENV and identity-less hooks refuse", async () => {
  const f = fixture()
  const inputs = [
    { ...f.identity, task: undefined },
    { ...f.identity, variables: { SECRET: "not-an-identity" } },
    { ...f.identity, execution: undefined },
    { ...f.identity, execution: { ...f.identity.execution, callID: "" } },
    { ...f.identity, profileGeneration: 0 },
  ]
  for (const input of inputs) await assert.rejects(f.adapter.prepare(input as MissionNativePreparationIdentity, f.signal.signal), /native-family-unresolved/)
  assert.equal(f.requests.length, 0)
})

test("fresh profile read failure is redacted and never falls back to a cached snapshot", async () => {
  const f = fixture()
  const prepared = await f.prepare()
  prepared.dispose()
  f.state.hook = async stage => { if (stage === "snapshot") throw new Error("private profile SECRET") }
  const error = await f.prepare().catch(error => error)
  assert.equal(error.code, "native-preparation-unavailable")
  assert.equal(error.cause, undefined)
  assert.equal(f.state.reads, 2)
  assert.equal(f.writes.length, 1)
})
