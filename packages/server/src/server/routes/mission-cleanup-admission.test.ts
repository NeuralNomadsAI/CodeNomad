import assert from "node:assert/strict"
import test from "node:test"
import { createServer } from "node:http"
import { once } from "node:events"
import Fastify from "fastify"
import { OpenCode } from "@opencode/client"
import { registerAutomationPluginRoute } from "./automation-plugin"
import { cleanupMissionSession } from "./mission-cleanup"
import { AUTOMATION_BRIDGE_PATH } from "../../opencode/automation-plugin"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"

type WireCall = { method: string; path: string }
async function fixture(label: string) {
  const target = Object.freeze({ projectID: "fixture", missionID: "msn_fixture", coordinatorSessionID: "ses_coordinator",
    sessionID: "ses_actor", location: Object.freeze({ directory: "/repo/actor" }) })
  const command = { kind: "cleanup", input: { missionID: target.missionID, deletionID: "evt_original_delete", sessionID: target.sessionID } }
  const info = (id: string, directory: string) => ({ id, projectID: "fixture", title: id, cost: 0, tokens: {},
    time: { created: 1, updated: 1 }, location: { directory },
    metadata: id === "ses_actor" ? { "codenomad.mission": { version: 1, missionID: "msn_fixture", kind: "actor" } } : {} })
  const coordinator: any = info("ses_coordinator", "/repo"), actor: any = info("ses_actor", "/repo/actor")
  const state = { current: true, coordinatorOwned: true, targetOwned: true, children: false, continuation: false,
    hook: (_stage: string) => {}, ownerHook: async (_directory: string) => {}, wireWait: async (_stage: string) => {} }
  const calls: WireCall[] = [], requests: unknown[] = [], checks: string[] = []
  let coordinatorReads = 0, actorReads = 0, inventories = 0, acquisitions = 0
  const native = createServer(async (request, response) => {
    try {
      assert.equal(request.headers.authorization, "Bearer synthetic-private-cleanup")
      const method = request.method!, url = new URL(request.url!, "http://private.local")
      calls.push({ method, path: request.url! })
      response.setHeader("content-type", "application/json")
      if (url.pathname.includes("/rpc/") && url.pathname.endsWith("/cleanupTarget")) {
        let body = ""
        for await (const chunk of request) body += chunk
        requests.push(JSON.parse(body).input)
        state.hook("authority")
        return response.end(JSON.stringify({ output: { target } }))
      }
      if (url.pathname === "/api/session" && method === "GET") {
        assert.equal(url.searchParams.get("parentID"), target.sessionID)
        assert.equal(url.searchParams.get("limit"), "1")
        state.hook(`inventory:${++inventories}`)
        return response.end(JSON.stringify({ data: state.children ? [info("ses_child", "/repo/actor")] : [],
          cursor: { next: state.continuation ? "unread-private-page" : null } }))
      }
      if (url.pathname === "/api/session/ses_coordinator" && method === "GET") {
        state.hook(`coordinator:${++coordinatorReads}`)
        return response.end(JSON.stringify({ data: coordinator }))
      }
      if (url.pathname === "/api/session/ses_actor" && method === "GET") {
        state.hook(`target:${++actorReads}`)
        return response.end(JSON.stringify({ data: actor }))
      }
      if (url.pathname === "/api/session/ses_actor" && method === "DELETE") {
        await state.wireWait("delete")
        response.statusCode = 204
        return response.end()
      }
      response.statusCode = 404
      response.end(JSON.stringify({ error: "Unhandled private route" }))
    } catch (error) { response.statusCode = 500; response.end(JSON.stringify({ error: String(error) })) }
  })
  native.listen(0, "127.0.0.1")
  await once(native, "listening")
  const address = native.address() as { port: number }
  const client = OpenCode.make({ baseUrl: `http://127.0.0.1:${address.port}`, headers: { authorization: "Bearer synthetic-private-cleanup" } })
  const connection = { client, assertCurrent() { if (!state.current) throw new Error("Retired original connection") } }
  const manager = {
    list: () => [{ id: "workspace" }], getSharedServiceClient: async () => client,
    getSharedServiceConnection: async () => { acquisitions++; return connection },
    ownsLocation: async (_id: string, location: { directory: string }, ownedClient?: unknown, signal?: AbortSignal) => {
      if (ownedClient) assert.equal(ownedClient, client)
      await state.ownerHook(location.directory)
      signal?.throwIfAborted()
      checks.push(location.directory)
      return location.directory === "/repo" ? state.coordinatorOwned : location.directory === "/repo/actor" && state.targetOwned
    },
    getWorktreeIdentityForPath: async (_id: string, directory: string) => directory === "/repo" ? "/private-physical/coordinator"
      : directory === "/repo/actor" ? "/private-physical/actor" : undefined,
  }
  const fence = new WorktreeDeletionFence(2_000), app = Fastify()
  registerAutomationPluginRoute(app, { workspaceManager: manager, worktreeDeletionFence: fence,
    authManager: { isLoopbackRequest: () => true }, bridgeToken: "private-fixture", nativeParent: {}, developerCdp: {} } as never)
  return { target, command, state, coordinator, actor, calls, requests, checks, fence,
    deletes: () => calls.filter(call => call.method === "DELETE").length,
    acquisitions: () => acquisitions,
    send: () => app.inject({ method: "POST", url: AUTOMATION_BRIDGE_PATH,
      headers: { "x-codenomad-automation-token": "private-fixture" },
      payload: { mode: "mission-input", sessionID: "ses_coordinator", command } }),
    direct: (signal: AbortSignal) => cleanupMissionSession(manager as never, fence, "ses_coordinator", command, signal),
    close: async () => {
      await app.close()
      await new Promise<void>(resolve => { native.close(() => resolve()); native.closeAllConnections() })
      console.log(JSON.stringify({ privateCleanupWire: label, qualified: false, calls, requests, checks,
        deletes: calls.filter(call => call.method === "DELETE").length, coordinatorReads, actorReads, inventories, acquisitions }))
    },
  }
}

for (const stage of ["target:1", "inventory:1", "target:2"]) {
  for (const mutation of ["coordinator-move", "coordinator-owner", "target-owner"]) {
    test(`cleanup rechecks ${mutation} after real generated native ${stage}`, { timeout: 10_000 }, async context => {
      const f = await fixture(context.name)
      try {
        f.state.hook = current => {
          if (current !== stage) return
          if (mutation === "coordinator-move") f.coordinator.location.directory = "/foreign"
          if (mutation === "coordinator-owner") f.state.coordinatorOwned = false
          if (mutation === "target-owner") f.state.targetOwned = false
        }
        const response = await f.send()
        assert.equal(response.statusCode, 502)
        assert.equal(f.deletes(), 0)
        assert.deepEqual(f.requests, [f.command.input])
        await f.fence.run("private-drain", ["/private-physical/coordinator", "/private-physical/actor"], async () => {})
        // Explicit ORIGINAL retry only, after restoring the actual owner/location.
        f.state.hook = () => {}; f.coordinator.location.directory = "/repo"
        f.state.coordinatorOwned = true; f.state.targetOwned = true
        assert.equal((await f.send()).statusCode, 200)
        assert.equal(f.deletes(), 1)
        assert.deepEqual(f.requests, [f.command.input, f.command.input])
      } finally { await f.close() }
    })
  }
}

test("unchanged token-authenticated cleanup retains exact immutable target and uses one native DELETE", { timeout: 10_000 }, async context => {
  const f = await fixture(context.name)
  try {
    const response = await f.send()
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { result: { outcome: "removed" } })
    assert.equal(f.deletes(), 1)
    assert.deepEqual(f.target, { projectID: "fixture", missionID: "msn_fixture", coordinatorSessionID: "ses_coordinator",
      sessionID: "ses_actor", location: { directory: "/repo/actor" } })
  } finally { await f.close() }
})

for (const change of ["id", "project", "parent"]) {
  test(`cleanup rejects a late coordinator ${change} change on the original generated connection`, { timeout: 10_000 }, async context => {
    const f = await fixture(context.name)
    try {
      f.state.hook = stage => {
        if (stage !== "target:2") return
        if (change === "id") f.coordinator.id = "ses_foreign"
        if (change === "project") f.coordinator.projectID = "foreign-project"
        if (change === "parent") f.coordinator.parentID = "ses_parent"
      }
      assert.equal((await f.send()).statusCode, 502)
      assert.equal(f.deletes(), 0)
      assert.deepEqual(f.requests, [f.command.input])
    } finally { await f.close() }
  })
}

for (const stage of ["target:1", "inventory:1", "target:2", "late-coordinator", "inventory:2", "target:3"]) {
  for (const retirement of ["cancel", "connection"]) {
    test(`cleanup rejects ${retirement} after generated ${stage} without reacquiring or sending DELETE`, { timeout: 10_000 }, async context => {
      const f = await fixture(context.name), controller = new AbortController()
      try {
        let stimulated = false
        f.state.hook = current => {
          if (current !== (stage === "late-coordinator" ? `coordinator:${retirement === "cancel" ? 3 : 4}` : stage)) return
          stimulated = true
          if (retirement === "cancel") controller.abort()
          else f.state.current = false
        }
        // Same private generated HTTP protocol as the authenticated route, with
        // a caller-owned signal so cancellation can be observed at exact awaits.
        if (retirement === "cancel") await assert.rejects(f.direct(controller.signal))
        else assert.equal((await f.send()).statusCode, 502)
        assert.equal(stimulated, true)
        assert.equal(f.deletes(), 0)
        assert.equal(f.acquisitions(), 1)
        await f.fence.run("retired-drain", ["/private-physical/coordinator", "/private-physical/actor"], async () => {})
      } finally { await f.close() }
    })
  }
}

for (const stage of ["coordinator:4", "inventory:2"]) {
  for (const change of ["moved", "id", "parent", "project", "metadata", "children", "incomplete"]) {
    test(`late admission preserves final target/child guard at ${stage}: ${change}`, { timeout: 10_000 }, async context => {
      const f = await fixture(context.name)
      try {
        let validated = false
        f.state.hook = current => {
          if (current !== stage) return
          validated = true
          if (change === "moved") f.actor.location.directory = "/foreign"
          if (change === "id") f.actor.id = "ses_foreign_actor"
          if (change === "parent") f.actor.parentID = "ses_parent"
          if (change === "project") f.actor.projectID = "foreign-project"
          if (change === "metadata") f.actor.metadata = {}
          if (change === "children") f.state.children = true
          if (change === "incomplete") f.state.continuation = true
        }
        const response = await f.send()
        assert.equal(validated, true)
        assert.equal(f.deletes(), 0)
        if (change === "incomplete") assert.equal(response.statusCode, 502)
        else {
          assert.equal(response.statusCode, 200)
          assert.deepEqual(response.json(), { result: { outcome: "retained",
            reason: change === "moved" ? "moved" : change === "children" ? "children" : "identity" } })
        }
      } finally { await f.close() }
    })
  }
}

test("both original location owners are checked after the late coordinator read, including failed ownership reads", { timeout: 10_000 }, async context => {
  for (const directory of ["/repo", "/repo/actor"]) {
    for (const unknown of [false, true]) {
      const f = await fixture(`${context.name}: ${directory}, unknown=${unknown}`)
      try {
        let late = false, observed = false
        f.state.hook = stage => { if (stage === "coordinator:4") late = true }
        f.state.ownerHook = async value => {
          if (!late || value !== directory) return
          observed = true
          if (unknown) throw new Error("Private ownership read failed")
          if (directory === "/repo") f.state.coordinatorOwned = false
          else f.state.targetOwned = false
        }
        assert.equal((await f.send()).statusCode, 502)
        assert.equal(observed, true)
        assert.equal(f.deletes(), 0)
      } finally { await f.close() }
    }
  }
})

test("cancellation/connection are rechecked after asynchronous owner validation", { timeout: 10_000 }, async context => {
  for (const retirement of ["cancel", "connection"]) {
    const f = await fixture(`${context.name}: ${retirement}`), controller = new AbortController()
    try {
      let late = false
      f.state.hook = stage => { if (stage === "coordinator:3") late = true }
      f.state.ownerHook = async () => {
        if (!late) return
        if (retirement === "cancel") controller.abort()
        else f.state.current = false
      }
      await assert.rejects(f.direct(controller.signal))
      assert.equal(late, true)
      assert.equal(f.deletes(), 0)
    } finally { await f.close() }
  }
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(value => { resolve = value })
  return { promise, resolve }
}

test("the EXACT physical permit drains only after late admission and original DELETE response settle", { timeout: 10_000 }, async context => {
  const f = await fixture(context.name), admission = deferred(), entered = deferred(), deletion = deferred(), deleteStarted = deferred()
  let pending: ReturnType<typeof f.send> | undefined, drain: Promise<unknown> | undefined
  try {
    let late = false
    f.state.hook = stage => { if (stage === "coordinator:4") late = true }
    f.state.ownerHook = async () => { if (late) { entered.resolve(); await admission.promise } }
    f.state.wireWait = async () => { deleteStarted.resolve(); await deletion.promise }
    pending = f.send()
    await entered.promise
    let drained = false
    drain = f.fence.run("original-physical", ["/private-physical/coordinator", "/private-physical/actor"], async () => { drained = true })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(drained, false)
    admission.resolve()
    await deleteStarted.promise
    assert.equal(drained, false)
    deletion.resolve()
    assert.equal((await pending).statusCode, 200)
    await drain
    assert.equal(drained, true)
    assert.equal(f.deletes(), 1)
  } finally { admission.resolve(); deletion.resolve(); await pending; await drain; await f.close() }
})
