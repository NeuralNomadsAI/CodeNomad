import assert from "node:assert/strict"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import Fastify from "fastify"
import { canonicalScope } from "../../host-lifetime/protocol"
import { missionSchedulePayloadDigest, missionScheduleRequestSchema, type MissionScheduleRequest } from "../../missions/mission-schedule-contract"
import { signNativeRecurrenceControl } from "../../missions/recurrence-control-proof"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { registerMissionScheduled } from "./mission-scheduled"
import { scheduledMissionHold } from "./mission-scheduled-holds"

const control = { requestID: "original_request", expectedRevision: 0, action: "play" as const }
const config = { title: "Review", objective: "Review bounded sources", template: "custom", taskMode: "native", watchedConversationIDs: [],
  profiles: { coordinator: { agent: "worker", model: { providerID: "unit", id: "model" } },
    roles: { specialist: { agent: "worker", model: { providerID: "unit", id: "model" } } } },
  launch: { timing: { kind: "every", intervalMs: 900_000 }, condition: null, ends: { maxLaunches: 3, at: null, afterMs: null } } }
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }

async function fixture(t: test.TestContext) {
  await mkdir(path.join(tmpdir(), "opencode"), { recursive: true })
  const temporary = await mkdtemp(path.join(tmpdir(), "opencode", "scheduled-http-")), root = await realpath(temporary)
  const yaml = path.join(root, "profile.yaml")
  await writeFile(yaml, "server: {}\n")
  const profile = canonicalScope("stable", yaml, root, root), workspace = {}, app = Fastify({ logger: false })
  const fence = new WorktreeDeletionFence(5000)
  const state = { human: true, owned: true, workspace, profile, checkout: root, canonical: root, projectID: "project",
    plays: [] as string[], play: undefined as (() => void) | undefined,
    writes: [] as MissionScheduleRequest[], reads: [] as Array<{ missionID: string; requestID?: string }>, entries: 0,
    write: undefined as ((input: MissionScheduleRequest) => Promise<unknown>) | undefined,
    read: undefined as ((input: { missionID: string; requestID?: string }) => Promise<unknown>) | undefined,
    abort: () => {},
  }
  const enter = fence.enter.bind(fence)
  fence.enter = directories => { state.entries++; return enter(directories) }
  const result = (input = state.writes.at(-1)!, pending = false) => ({ pending, document: { id: input.missionID,
    control: { requestID: input.requestID, expectedRevision: input.expectedRevision, action: input.action, pending } } })
  const client = {
    location: { get: async ({ location }: { location: { directory: string } }) => ({ ...location, project: { id: state.projectID, canonical: state.canonical } }) },
    plugin: { list: async () => ({ data: [{ id: "codenomad.missions", state: { status: "active" } }] }) },
    rpc: () => ({
      scheduleControl: async (raw: unknown, options: { signal?: AbortSignal }) => {
        assert.equal(options.signal, undefined, "admitted write is joined independently of observer cancellation")
        const input = missionScheduleRequestSchema.parse(raw), { proof, ...identity } = input.transport
        assert.equal(proof, signNativeRecurrenceControl(identity, "fixture-token"))
        state.writes.push(input)
        return state.write ? state.write(input) : result(input)
      },
      scheduleRead: async (input: { missionID: string; requestID?: string }) => {
        state.reads.push(input)
        return state.read ? state.read(input) : result()
      },
    }),
  }
  const connection = () => { let active = true; return { client, retire: () => { active = false }, assertCurrent: () => { if (!active) throw new Error("Retired connection") } } }
  const original = connection()
  let selected = original
  const manager = { get: () => state.workspace, getServiceLocation: () => ({ directory: root }), getSharedServiceConnection: async () => selected,
    ownsLocation: async (_id: string, location: { directory: string }) => state.owned && location.directory === root,
    getServiceDirectoryForPath: async (_id: string, directory: string) => directory === root ? root : undefined,
    getWorktreeIdentityForPath: async () => state.checkout, getServiceWslDistro: () => undefined,
    getServicePathStyle: () => process.platform === "win32" ? "win32" : "posix" }
  app.addHook("preHandler", async request => { state.abort = () => { request.raw.emit("aborted") } })
  registerMissionScheduled(app, { workspaceManager: manager, worktreeDeletionFence: fence, bridgeToken: "fixture-token",
    supervision: { missionPlay: async (connection: unknown, requestID: string, authorize: () => void) => {
      assert.equal(connection, selected); authorize(); state.plays.push(requestID); state.play?.(); authorize()
    } },
    auth: { isAuthEnabled: () => true, getSessionFromRequest: () => state.human ? { sessionId: "human_cookie", username: "human" } : undefined },
    settings: { getProfileScope: () => state.profile, configYamlPathForAuthority: () => yaml },
  } as never)
  t.after(async () => { await app.close(); await rm(temporary, { recursive: true, force: true }) })
  const url = "/api/workspaces/owned/missions/msn_owned/schedule"
  const post = (payload: object = control, target = url) => app.inject({ method: "POST", url: target, payload })
  const get = (missionID = "msn_owned", query = "") => app.inject({ method: "GET", url: `/api/workspaces/owned/missions/${missionID}/schedule${query}` })
  return { app, state, fence, original, result, root, post, get, url,
    replace(retire = true) { if (retire) selected.retire(); selected = connection(); return selected },
    deleting() { let entered = false; const done = fence.run(root, [root], async () => { entered = true }); return { done, entered: () => entered } },
  }
}

test("only authenticated Play calls service default-ON on the exact acquired connection before dispatch", async t => {
  const f = await fixture(t)
  const create = { action: "create", requestID: "create_paused", expectedRevision: 0, configuration: config }
  assert.equal((await f.post(create, "/api/workspaces/owned/missions/scheduled")).statusCode, 200)
  assert.equal((await f.get()).statusCode, 200)
  assert.equal((await f.post({ action: "configure", requestID: "configure_paused", expectedRevision: 1, configuration: config })).statusCode, 200)
  assert.deepEqual(f.state.plays, [])
  f.state.play = () => assert.equal(f.state.writes.at(-1)!.action, "configure")
  assert.equal((await f.post(control)).statusCode, 200)
  assert.deepEqual(f.state.plays, [control.requestID])
  f.state.play = () => { f.state.human = false }
  assert.equal((await f.post({ ...control, requestID: "revoked_play" })).statusCode, 503)
  assert.equal(f.state.writes.at(-1)!.requestID, control.requestID)
  f.state.plays.length = 0
  assert.equal((await f.post({ ...control, requestID: "unauthenticated_play" })).statusCode, 401)
  assert.deepEqual(f.state.plays, [])
})

test("creation status locates the original request after losing the HTTP document identity, without another write", async t => {
  const f = await fixture(t), requestID = "lost_create_response"
  f.state.write = async () => { throw new Error("Lost creation ACK") }
  assert.equal((await f.post({ action: "create", requestID, expectedRevision: 0, configuration: config },
    "/api/workspaces/owned/missions/scheduled")).statusCode, 503)
  const original = f.state.writes[0], url = `/api/workspaces/owned/missions/scheduled/requests/${requestID}`
  assert.ok(scheduledMissionHold(f.fence, original.missionID))
  f.state.read = async () => ({ document: null, pending: true })
  assert.equal((await f.app.inject({ method: "GET", url })).statusCode, 503)
  assert.ok(scheduledMissionHold(f.fence, original.missionID))
  f.state.read = async () => f.result(original)
  const receipt = await f.app.inject({ method: "GET", url })
  assert.equal(receipt.statusCode, 200)
  assert.equal(receipt.json().document.control.requestID, requestID)
  assert.equal(f.state.reads.at(-1)!.missionID, original.missionID)
  assert.equal(scheduledMissionHold(f.fence, original.missionID), undefined)
  // Once the in-memory permit is settled, the native owner derives the same ID.
  assert.equal((await f.app.inject({ method: "GET", url })).statusCode, 200)
  assert.equal(f.state.reads.at(-1)!.missionID, original.missionID)
  assert.equal(f.state.writes.length, 1)
  assert.deepEqual(f.state.plays, [])
})

test("exact original complete ACK releases; missing/null/partial receipts and negative reads keep deletion fenced", async t => {
  const f = await fixture(t)
  assert.equal((await f.post()).statusCode, 200)
  assert.equal(scheduledMissionHold(f.fence, "msn_owned"), undefined)
  f.state.write = async () => ({ document: null, pending: false })
  assert.equal((await f.post({ ...control, requestID: "unknown_request", expectedRevision: 1 })).statusCode, 503)
  const deletion = f.deleting()
  for (const raw of [{ document: null, pending: false }, { pending: true, document: null }, f.result(undefined, true),
    { ...f.result(), document: { ...f.result().document, control: { ...f.result().document.control, action: "stop" } } }]) {
    f.state.read = async () => raw
    const read = await f.get()
    assert.equal(read.statusCode, 503); assert.equal(read.json().pending, true); assert.equal(deletion.entered(), false)
  }
  assert.equal(f.state.writes.length, 2)
  f.state.read = async () => { throw new Error("Unavailable exact receipt") }
  assert.equal((await f.get()).statusCode, 503); assert.equal(deletion.entered(), false)
  const now = Date.now
  Date.now = () => now() + 365 * 24 * 60 * 60_000
  try {
    f.state.read = async () => ({ document: null, pending: true })
    assert.equal((await f.get()).statusCode, 503); assert.equal(deletion.entered(), false)
  } finally { Date.now = now }
  f.state.read = async () => f.result()
  assert.equal((await f.get()).statusCode, 200)
  await deletion.done
  assert.equal(deletion.entered(), true)
})

test("malformed action/configuration and new pure immediate CREATE fail before any physical hold or signing", async t => {
  const f = await fixture(t), create = "/api/workspaces/owned/missions/scheduled"
  const immediate = { ...config, launch: { ...config.launch, timing: { kind: "immediate" } } }
  for (const [payload, target] of [
    [{ action: "create", requestID: "immediate_new", expectedRevision: 0, configuration: immediate }, create],
    [{ action: "create", requestID: "missing_config", expectedRevision: 0 }, create],
    [{ action: "configure", requestID: "missing_config", expectedRevision: 0 }, f.url],
    [{ ...control, configuration: config }, f.url],
    [{ ...control, deleteManagedSessions: false }, f.url],
    [{ action: "create", requestID: "wrong_revision", expectedRevision: 1, configuration: config }, create],
    [{ action: "create", requestID: "missing_profiles", expectedRevision: 0, configuration: { ...config, profiles: undefined } }, create],
  ] as const) assert.equal((await f.post(payload, target)).statusCode, 400)
  assert.equal(f.state.entries, 0); assert.equal(f.state.writes.length, 0); assert.equal(f.state.reads.length, 0)
  assert.equal((await f.post({ action: "configure", requestID: "convert_existing", expectedRevision: 0, configuration: immediate })).statusCode, 200)
  assert.equal(f.state.writes.length, 1, "same-object configure conversion remains available")
})

test("lost RPC ACK never resends on GET/repeat; explicit Check settles only the original receipt", async t => {
  const f = await fixture(t)
  f.state.write = async () => { throw new Error("Lost native ACK") }
  assert.equal((await f.post()).statusCode, 503)
  f.state.read = async () => ({ document: null, pending: true })
  assert.equal((await f.get("msn_owned", "?requestID=original_request")).statusCode, 503)
  assert.equal((await f.post()).statusCode, 503)
  assert.equal((await f.post({ ...control, requestID: "different_request" })).statusCode, 409)
  assert.equal((await f.post({ ...control, expectedRevision: 2 })).statusCode, 409)
  assert.equal(f.state.writes.length, 1)
  const deletion = f.deleting()
  f.state.read = async () => f.result()
  const checked = await f.post({ action: "check", requestID: "explicit_check", expectedRevision: 2 })
  assert.equal(checked.statusCode, 200)
  assert.equal(checked.json().document.control.requestID, control.requestID)
  assert.equal(f.state.reads.at(-1)!.requestID, control.requestID)
  assert.equal(f.state.writes.length, 1)
  await deletion.done
})

test("exact native pre-write refusals release only their own hold and leave Check/Stop available", async t => {
  for (const reason of ["date-passed", "revision-conflict"] as const) {
    const f = await fixture(t)
    f.state.write = async input => ({ document: null, pending: false, refusal: { missionID: input.missionID,
      requestID: input.requestID, action: input.action, expectedRevision: input.expectedRevision,
      payloadDigest: missionSchedulePayloadDigest(input), reason } })
    const refused = await f.post()
    assert.equal(refused.statusCode, 409); assert.equal(refused.json().code, "schedule-refused"); assert.equal(refused.json().pending, false)
    assert.equal(scheduledMissionHold(f.fence, "msn_owned"), undefined)
    f.state.write = async input => f.result(input)
    for (const action of ["check", "stop"])
      assert.equal((await f.post({ ...control, action, requestID: `after_refusal_${action}` })).statusCode, 200)
    await f.deleting().done
  }
})

test("explicit partial retry uses the original permit and tuple, including while deletion waits", async t => {
  const f = await fixture(t)
  f.state.write = async input => f.result(input, true)
  assert.equal((await f.post()).statusCode, 503)
  const deletion = f.deleting()
  f.state.read = async () => f.result(undefined, true)
  f.state.write = async input => f.result(input)
  assert.equal((await f.post({ ...control, retry: true })).statusCode, 200)
  assert.equal(f.state.writes.length, 2); assert.equal(f.state.entries, 1)
  await deletion.done
})

test("human Check reconciles a positively recorded partial intent under the original permit then reads its exact receipt", async t => {
  const f = await fixture(t)
  f.state.write = async input => f.result(input, true)
  assert.equal((await f.post()).statusCode, 503)
  const original = f.state.writes[0], retained = scheduledMissionHold(f.fence, original.missionID)!, binding = retained.binding
  let completed = false
  f.state.read = async input => {
    assert.equal(input.requestID, original.requestID)
    return f.result(original, !completed)
  }
  const deletion = f.deleting()
  assert.equal((await f.get()).statusCode, 503)
  assert.equal((await f.post()).statusCode, 503)
  assert.equal(f.state.writes.length, 1)
  f.state.write = async input => {
    assert.equal(input.action, "check"); assert.equal(input.requestID, "human_check")
    assert.equal(input.expectedRevision, 9); assert.equal(input.transport.expectedRevision, 9)
    assert.equal(deletion.entered(), false)
    assert.equal(scheduledMissionHold(f.fence, original.missionID), retained)
    assert.equal(retained.binding, binding)
    completed = true
    return f.result(input)
  }
  const checked = await f.post({ action: "check", requestID: "human_check", expectedRevision: 9 })
  assert.equal(checked.statusCode, 200)
  assert.equal(checked.json().document.control.requestID, original.requestID)
  assert.deepEqual(f.state.writes.map(input => input.action), ["play", "check"])
  assert.equal(f.state.reads.length, 4, "GET, repeat, Check preflight and original receipt after Check")
  assert.equal(f.state.entries, 1)
  assert.equal(binding.action, original.action); assert.equal(binding.expectedRevision, original.expectedRevision)
  await deletion.done
})

test("uncertain Check and missing original proof preserve the original binding and never auto-Check on reads or repeats", async t => {
  const f = await fixture(t)
  f.state.write = async input => f.result(input, true)
  await f.post()
  const original = f.state.writes[0], retained = scheduledMissionHold(f.fence, original.missionID)!, binding = retained.binding
  const deletion = f.deleting()
  f.state.read = async () => f.result(original, true)
  f.state.write = async () => { throw new Error("Uncertain Check response") }
  assert.equal((await f.post({ action: "check", requestID: "uncertain_check", expectedRevision: 4 })).statusCode, 503)
  assert.equal(scheduledMissionHold(f.fence, original.missionID), retained)
  assert.equal(retained.binding, binding); assert.equal(retained.busy, false)
  assert.equal((await f.get()).statusCode, 503)
  assert.equal((await f.post()).statusCode, 503)
  assert.equal(f.state.writes.length, 2); assert.equal(deletion.entered(), false)
  f.state.read = async () => ({ document: null, pending: true })
  assert.equal((await f.post({ action: "check", requestID: "no_proof_check", expectedRevision: 5 })).statusCode, 503)
  assert.equal(f.state.writes.length, 2)
  assert.equal(scheduledMissionHold(f.fence, original.missionID)!.binding, binding)
  f.state.read = async () => f.result(original)
  assert.equal((await f.get()).statusCode, 200)
  await deletion.done
})

test("retired-connection partial Pause permits explicit Check or exact retry after fresh physical admission", async t => {
  for (const retry of [false, true]) {
    const f = await fixture(t), pause = { ...control, action: "pause" }
    f.state.write = async input => f.result(input, true)
    await f.post(pause)
    const original = f.state.writes[0], hold = scheduledMissionHold(f.fence, original.missionID)!, binding = hold.binding
    const connection = f.replace()
    let completed = false
    f.state.read = async () => f.result(original, !completed)
    assert.equal((await f.get()).statusCode, 503)
    assert.equal(f.state.writes.length, 1)
    f.state.write = async input => {
      assert.equal(f.state.entries, 2); assert.equal(hold.connection, connection); assert.equal(hold.binding, binding)
      assert.equal(input.requestID, retry ? original.requestID : "replacement_check")
      assert.equal(input.expectedRevision, retry ? original.expectedRevision : 3)
      completed = true
      return f.result(input)
    }
    const checked = await f.post(retry ? { ...pause, retry: true } : { action: "check", requestID: "replacement_check", expectedRevision: 3 })
    assert.equal(checked.statusCode, 200)
    assert.equal(checked.json().document.control.requestID, original.requestID)
    assert.equal(scheduledMissionHold(f.fence, original.missionID), undefined)
    assert.equal(f.state.writes.length, 2)
    await f.deleting().done
  }
})

test("replacement settlement requires a retired connection and the same workspace/project/physical checkout", async t => {
  const f = await fixture(t)
  f.state.write = async () => { throw new Error("Lost") }
  await f.post()
  f.state.read = async () => f.result()
  f.replace(false)
  assert.equal((await f.get()).statusCode, 409, "a live connection cannot be borrowed")
  f.original.retire()
  const deletion = f.deleting()
  const workspace = f.state.workspace
  for (const changed of [() => { f.state.checkout = `${f.root}/another` }, () => { f.state.workspace = {} },
    () => { f.state.projectID = "different_project" }, () => { f.state.canonical = `${f.root}/foreign` }]) {
    changed()
    assert.equal((await f.get()).statusCode, 409)
    assert.equal(deletion.entered(), false)
    f.state.checkout = f.root; f.state.workspace = workspace; f.state.projectID = "project"; f.state.canonical = f.root
  }
  assert.equal(f.state.reads.length, 0)
  assert.equal((await f.get()).statusCode, 200)
  await deletion.done
  assert.equal(f.state.writes.length, 1)
})

for (const abort of [false, true]) test(`late ${abort ? "aborted" : "revoked-auth"} response retains the permit until a fresh qualified receipt read`, async t => {
  const f = await fixture(t)
  f.state.write = async input => { if (abort) f.state.abort(); else f.state.human = false; return f.result(input) }
  const response = await f.post()
  assert.equal(response.statusCode, 503)
  assert.ok(scheduledMissionHold(f.fence, "msn_owned"))
  const deletion = f.deleting()
  f.state.human = true
  f.state.read = async () => { if (abort) f.state.abort(); else f.state.human = false; return f.result() }
  assert.equal((await f.get()).statusCode, 503); assert.equal(deletion.entered(), false)
  f.state.human = true; f.state.read = async () => f.result()
  assert.equal((await f.get()).statusCode, 200)
  await deletion.done
})

test("a positive exact read can settle a retained in-flight call without mutation replay", async t => {
  const f = await fixture(t), started = deferred<void>(), native = deferred<unknown>()
  f.state.write = async () => { started.resolve(); return native.promise }
  const dispatched = f.post()
  await started.promise
  const deletion = f.deleting()
  f.state.read = async () => ({ document: null, pending: true })
  assert.equal((await f.get()).statusCode, 503)
  assert.equal(deletion.entered(), false)
  f.state.read = async () => f.result()
  assert.equal((await f.get()).statusCode, 200)
  await deletion.done
  native.resolve(f.result())
  const late = await dispatched
  assert.notEqual(late.statusCode, 200); assert.equal(late.json().pending, true)
  assert.equal(f.state.writes.length, 1)
})

test("CREATE reconciliation preserves payload digest and immutable original receipt without another create", async t => {
  const f = await fixture(t), payload = { action: "create", requestID: "create_original", expectedRevision: 0, configuration: config }
  const create = "/api/workspaces/owned/missions/scheduled"
  f.state.write = async () => { throw new Error("Lost CREATE ACK") }
  const first = await f.post(payload, create), missionID = first.json().missionID
  assert.equal(first.statusCode, 503); assert.ok(missionID)
  const deletion = f.deleting()
  assert.equal((await f.post({ ...payload, configuration: { ...config, objective: "Different request" } }, create)).statusCode, 409)
  f.state.read = async () => f.result()
  assert.equal((await f.post(payload, create)).statusCode, 200)
  assert.equal(f.state.writes.length, 1); assert.equal(f.state.entries, 1)
  assert.deepEqual(f.state.reads.at(-1), { missionID, requestID: payload.requestID })
  await deletion.done
})

test("unqualified tombstone and mismatched receipts never settle a DELETE hold", async t => {
  const f = await fixture(t), payload = { ...control, action: "delete" }
  f.state.write = async () => ({ document: null, deleted: true, pending: false })
  assert.equal((await f.post(payload)).statusCode, 503)
  f.state.read = async () => ({ document: null, deleted: true, pending: false })
  assert.equal((await f.get()).statusCode, 503)
  assert.ok(scheduledMissionHold(f.fence, "msn_owned")); assert.equal(f.state.writes.length, 1)
})
