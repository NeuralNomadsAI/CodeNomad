import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import type { Plugin } from "@opencode/plugin"
import type * as Tool from "@opencode/plugin/promise/tool"
import { OpenCode } from "@opencode/client"
import { Model } from "@opencode/schema/model"
import { Session } from "@opencode/schema/session"
import { Agent } from "@opencode/schema/agent"
import { NATIVE_MISSIONS_PROTOCOL, NATIVE_MISSIONS_AUTHORITY_PROTOCOL, MISSIONS_CHANNEL_METHODS,
  MISSIONS_AUTHORITY_METHODS, type NativeMissionsAuthoritySDK } from "../../host-lifetime/native-missions-contract"
import { structuralDerivedFixture, freshSignal } from "../../missions/derived-call-business.test"
import { authorityDigest } from "../../missions/authority-protocol"
import type { DerivedCallBody, DerivedExecution, DerivedInvocationPurpose } from "../../missions/derived-call-protocol"
import type { DerivedCallPublicationContext } from "../../missions/derived-call-publication"
import type { MissionNativePreparationIdentity } from "../../server/routes/mission-native-preparation"
import type { MissionNativeReportRequest } from "../../missions/control-types"
import type { WorkspaceDescriptor } from "../../api-types"
import type { ServiceConnection } from "../../workspaces/opencode-service"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { sessionEnvironment } from "../../workspaces/session-environment"
import { createNativeProductAdmissions, type NativeProductOptions } from "./native-product-admissions"
import type { NativeProductChannel, ProductTaskObservation, ProductBoundaryObservation } from "./native-product-contract"
import { installNativeTaskAdapter, type NativeTaskInvocation } from "./native-task-adapter"
import type { NativeFamilyBoundary } from "./native-family-gates"

// STRUCTURAL composition ONLY: actual shared business/crypto/authority/ENV code,
// deterministic official-shaped native executor and injected callback host trust.
// These mocks are NOT native writer/family/provider/atomic commit qualification.
async function fixture() {
  const g = await structuralDerivedFixture()
  const state = { current: true, human: true, scope: "owned" as "owned" | "unowned", observed: true, generation: 1,
    returnState: "returned" as "returned" | "unknown", childID: "ses_actual", failEnvironment: false, revokeFails: false,
    selected: { agent: "worker", model: { providerID: "fixture", id: "model", variant: "careful" } } as Required<DerivedExecution>,
    beforeEnvironment: undefined as undefined | (() => void), beforeTask: undefined as undefined | (() => void),
    lastBody: undefined as DerivedCallBody | undefined, rawReservations: 0, nativeCalls: 0, nativePrompts: 0, envReads: 0 }
  const order: string[] = [], writes: Array<{ sessionID: string; variables: Record<string, string> }> = [], requests: string[] = []
  const nativeRefs = new WeakSet<object>(), capabilities = new Set<object>()
  const cap = () => { const ref = Object.freeze({}); nativeRefs.add(ref); capabilities.add(ref); return ref }
  const channelRef = cap(), registration = cap(), humanLease = cap(), familyClaim = cap()
  const check = () => { if (!state.current) throw new Error("structural native writer/call revoked") }
  const host = (await g.f.host.read())!
  const nonce = randomUUID(), incarnationID = "new-incarnation", proof = Buffer.from("structural-producer-injection-not-attestation")
  const nativeProof = await g.f.nativeBridge.handshake({ nonce, descriptor: g.f.descriptor, binding: host.binding,
    provisioningGeneration: host.signer!.provisioningGeneration, signerDigest: host.signer!.signerDigest })
  const observation = g.f.nativeBridge.verify(nativeProof)
  const sdk = Object.fromEntries([...MISSIONS_CHANNEL_METHODS, ...MISSIONS_AUTHORITY_METHODS].map(method => [method,
    () => { throw new Error(`Unexpected native SDK operation: ${method}`) }])) as unknown as NativeMissionsAuthoritySDK
  Object.assign(sdk, { missionsProtocol: NATIVE_MISSIONS_PROTOCOL, missionsAuthorityProtocol: NATIVE_MISSIONS_AUTHORITY_PROTOCOL,
    verifyMissionsAuthority(channel: object, bytes: Buffer) { assert.equal(channel, channelRef); assert.equal(bytes, proof); check(); return observation },
    missionsAssertChannel(ref: object) { assert.equal(ref, channelRef); check() },
    missionsAssertRegistration(channel: object, ref: object) { assert.equal(channel, channelRef); assert.equal(ref, registration); check() },
    assertMissionsAuthority(channel: object, bytes: Buffer, digest: string) {
      assert.equal(channel, channelRef); assert.equal(bytes, proof); assert.equal(digest, authorityDigest(observation)); check()
    },
    assertMissionsHuman(channel: object, ref: object) { assert.equal(channel, channelRef); assert.equal(ref, humanLease); check(); if (!state.human) throw new Error("human paused") },
    assertMissionsFamily(channel: object, ref: object, family: string) {
      assert.equal(channel, channelRef); assert.equal(ref, familyClaim); assert.equal(family, "physical-fixture-family"); check()
    },
  })
  const configured: Record<string, string> = { TEMP: "backend-profile-temp" }
  const workspace: WorkspaceDescriptor = { id: "workspace", path: g.f.project, status: "ready", proxyPath: "/workspace/fixture/",
    binaryId: "host", binaryLabel: "host", createdAt: "now", updatedAt: "now" }
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input)), method = init?.method ?? "GET"
    requests.push(`${method} ${url.pathname}`)
    if (method === "GET" && /^\/api\/session\/[^/]+$/.test(url.pathname)) {
      const id = decodeURIComponent(url.pathname.split("/").at(-1)!)
      const child = g.children.get(id)
      const record = child ? { id, parentID: child.parentSessionID, projectID: child.projectID, location: child.location }
        : id === g.f.target.coordinatorSessionID ? { id, projectID: g.f.target.projectID, location: { directory: g.f.project } } : undefined
      return record ? Response.json({ data: record }) : Response.json({}, { status: 404 })
    }
    if (method === "PUT" && /\/environment$/.test(url.pathname)) {
      state.beforeEnvironment?.()
      writes.push({ sessionID: decodeURIComponent(url.pathname.split("/").at(-2)!), variables: JSON.parse(String(init?.body)).variables })
      order.push("fresh-env")
      if (state.failEnvironment) throw new Error("uncertain native ENV write; secret payload not logged")
      return new Response(null, { status: 204 })
    }
    assert.fail(`Unexpected native mutation ${method} ${url.pathname}`)
  }
  const connection: ServiceConnection = { endpoint: { url: "http://127.0.0.1:1" }, client: OpenCode.make({ baseUrl: "http://127.0.0.1:1", fetch: fetcher }),
    fetch: fetcher, assertCurrent: check, invalidate() { state.current = false }, profile: async () => "modern" }
  const manager = { get: () => workspace, getSharedServiceConnection: async () => connection,
    ownsLocation: async (_workspace: string, location: { directory: string }) => location.directory === g.f.project,
    getWorktreeIdentityForPath: async () => g.f.project,
    getSessionEnvironment: async () => { state.envReads++; return sessionEnvironment(configured, { platform: "win32",
      environment: { Path: "host-path", TEMP: "host-temp", CODENOMAD_AUTOMATION_BRIDGE_TOKEN: "private" } }) } }
  const expectation = (value: MissionNativePreparationIdentity) => {
    check(); if (value.profileGeneration !== state.generation || value.connectionIncarnation !== incarnationID) throw new Error("profile generation revoked")
  }
  const contextual = new WeakMap<object, { body: DerivedCallBody; purpose: DerivedInvocationPurpose; childSessionID?: string; outcome?: "returned" }>()
  const context = (body: DerivedCallBody, purpose: DerivedInvocationPurpose, childSessionID?: string, outcome?: "returned", request?: MissionNativeReportRequest) => {
    const value = g.context(body, purpose, childSessionID, outcome, request)
    contextual.set(value.proof as object, { body, purpose, childSessionID, outcome }); return value
  }
  const taskObservation = (): ProductTaskObservation => state.scope === "unowned" ? { scope: "unowned", permit: cap(), reference: cap() }
    : { scope: "owned", family: "physical-fixture-family", familyClaim, root: g.f.target.roots[0], execution: structuredClone(state.selected), reference: cap() }
  const boundarySession = (value: NativeFamilyBoundary) => value.boundary === "tool.executor" ? value.context.sessionID
    : "sessionID" in value.event ? String(value.event.sessionID) : undefined
  const identity = (sessionID: string, body: DerivedCallBody | undefined, boundary: MissionNativePreparationIdentity["execution"]["boundary"],
    invocation?: NativeTaskInvocation): MissionNativePreparationIdentity => ({ version: 1, scope: body ? "bound-native-child" : "owned-family",
    workspaceID: "workspace", projectID: g.f.target.projectID, rootSessionID: g.f.target.coordinatorSessionID, sessionID,
    parentSessionID: g.children.get(sessionID)?.parentSessionID ?? null, location: { directory: g.f.project },
    profileKey: "backend-profile", profileGeneration: state.generation, connectionIncarnation: incarnationID, lifecycleGeneration: 1,
    ...(body ? { task: { missionID: body.missionID, ...body.task } } : {}),
    execution: { incarnation: `fixture_effect_${state.envReads}`, callerSessionID: invocation?.sessionID ?? sessionID,
      messageID: invocation?.messageID ?? "msg_provider", callID: invocation?.id ?? "call_provider", boundary } })
  const retained: Array<{ current(): true; dispose(): void }> = []
  const c: NativeProductChannel = { sdk, channel: channelRef, registration, humanLease, proof, nonce, incarnationID,
    business: g.channel, publication: g.publicationChannel,
    invocations: { async verify(input) {
      const ref = input.proof as DerivedCallPublicationContext, facts = contextual.get(ref.proof as object)
      if (!facts || ref.incarnationID !== "injected-structural-writer-only") throw new Error("unknown structural native invocation proof")
      return { bodyDigest: authorityDigest(facts.body), purpose: facts.purpose, childSessionID: facts.childSessionID, outcome: facts.outcome,
        callerSessionID: facts.purpose === "execute" || facts.purpose === "report" ? facts.childSessionID! : facts.body.parentSessionID,
        assertCurrent() { check(); return true } }
    } },
    preparation: { async prepare(value) { expectation(value) }, current(value) { expectation(value); return true } },
    assertCurrent() { check() },
    async observeTask() { state.beforeTask?.(); check(); return taskObservation() },
    assertTask(_invocation, value) { check(); if (value && !nativeRefs.has(value.reference)) throw new Error("forged native task ref") },
    assertActualChild(invocation, _value, childID) {
      if (childID !== state.childID || g.children.get(childID)?.parentSessionID !== invocation.sessionID) throw new Error("wrong actual structured native child")
    },
    async reserveRaw() { check(); state.rawReservations++; order.push("raw-capacity") },
    async guardRawContinuation() { check(); if (!state.observed) throw new Error("raw full-family unknown") },
    async callContext(input) { state.lastBody = structuredClone(input.body); order.push(`proof-${input.purpose}`); return context(input.body, input.purpose, input.childSessionID, input.outcome) },
    async childBoundary(invocation, _value, childSessionID, body) {
      return { identity: identity(childSessionID, body, "child-first-prompt", invocation), execution: structuredClone(state.selected) }
    },
    async observeBoundary(boundary) {
      const sessionID = boundarySession(boundary)
      const record = (await g.f.core.store.read()).derivedCalls?.find(call => call.child?.sessionID === sessionID && call.state === "active")
      return { ...taskObservation(), ...(record ? { reservationID: record.signed.body.reservationID } : {}) }
    },
    assertBoundary(_boundary, value) { check(); if (value && !nativeRefs.has(value.reference)) throw new Error("forged boundary ref") },
    async prepareBoundary(boundary, value) {
      const record = value.reservationID ? await g.authority.read(value.reservationID) : undefined
      const sessionID = boundarySession(boundary); if (!sessionID) throw new Error("no attributable native session")
      return { identity: identity(sessionID, record?.signed.body, "tool-before"), execution: structuredClone(state.selected) }
    },
    async executeContext(_boundary, _value, body) { return context(body, "execute", g.children.has(state.childID) ? state.childID : "ses_unknown") },
    retainBoundary(_boundary, _value, receipt) { check(); retained.push(receipt) },
    async observeReturn() { order.push("read-only-exact-return"); return state.returnState },
    async reportContext(request) {
      const record = (await g.f.core.store.read()).derivedCalls?.find(call => call.child?.sessionID === request.sessionID
        && call.signed.body.task.taskKey === request.contract.taskKey && call.signed.body.task.generation === request.contract.generation)
      if (!record) throw new Error("no exact accepted native report call")
      return { ...context(record.signed.body, "report", request.sessionID, undefined, request), reservationID: record.signed.body.reservationID }
    },
    async failureObserved() { order.push("ambiguous-failure-observed") },
    revokeCaptures() { order.push("revoke-native-captures"); state.current = false; if (state.revokeFails) throw new Error("native revocation uncertain") },
    releaseManagedReferences() { order.push("release-known-native-refs"); capabilities.clear() },
  }
  const options: NativeProductOptions = { journal: g.journal, store: g.f.core.store, host: g.f.host, native: g.f.core,
    channel: c, environment: { manager, fence: new WorktreeDeletionFence() } }
  const product = createNativeProductAdmissions(options)
  const invoke = (key?: string, input: Record<string, unknown> = {}, callID = `call_${key ?? "raw"}`): NativeTaskInvocation => ({
    sessionID: g.f.target.coordinatorSessionID as Tool.ToolContext["sessionID"], messageID: `msg_${callID}` as Tool.ToolContext["messageID"],
    id: callID as Tool.ToolContext["id"], agent: "coordinator" as Tool.ToolContext["agent"],
    nativeInput: { agent: "worker", description: "Bound work", prompt: "Do work", model: "fixture/model#careful", ...input },
    ...(key ? { mission: { missionID: g.f.target.missionID, taskKey: key, generation: 1 } } : {}) })
  const fence = () => ({ signal: freshSignal(), assertCurrent() { check() } })
  const birth = (invocation: NativeTaskInvocation) => {
    if (state.lastBody) {
      g.native(state.lastBody, state.childID)
      g.children.get(state.childID)!.execution = structuredClone(state.selected)
      g.profiles.set(state.lastBody.reservationID, structuredClone(state.selected))
    }
    else g.children.set(state.childID, { sessionID: state.childID, parentSessionID: invocation.sessionID, projectID: g.f.target.projectID,
      title: "Raw native child", location: { directory: g.f.project }, execution: state.selected, executionObserved: true })
  }
  const reserveBind = async (invocation: NativeTaskInvocation) => {
    const reservation = await product.admissions.reserve(invocation, fence())
    if (invocation.nativeInput.sessionID) await product.admissions.guardContinuation(invocation, reservation, String(invocation.nativeInput.sessionID), fence())
    birth(invocation)
    const bound = await product.admissions.bindActualChild(invocation, reservation, state.childID, fence()); await g.refresh()
    return { reservation, bound }
  }
  const modelBoundary = (reference = "fixture/model#careful"): NativeFamilyBoundary => ({ boundary: "model.request", event: { sessionID: Session.ID.make(state.childID),
    agent: Agent.ID.make(state.selected.agent), model: Model.Ref.parse(reference), kind: "primary", headers: {} } })
  const toolBoundary = (): NativeFamilyBoundary => ({ boundary: "tool.executor", tool: "read", input: { filePath: "fixture.ts" },
    context: { sessionID: Session.ID.make(state.childID), messageID: "msg_actual_tool" as Tool.ToolContext["messageID"],
      id: "call_actual_tool" as Tool.ToolContext["id"], agent: Agent.ID.make(state.selected.agent), signal: freshSignal(), progress: async () => {} } })
  return { g, state, order, c, options, product, invoke, fence, birth, reserveBind, modelBoundary, toolBoundary, configured, writes, requests, retained }
}

async function officialExecutor(admissions: ReturnType<typeof createNativeProductAdmissions>["admissions"], execute: Tool.Info["execute"]) {
  let current: Tool.Info = { name: "subagent", description: "Official native logic retained", options: { codemode: false },
    input: { type: "object", properties: { agent: { type: "string" }, description: { type: "string" }, prompt: { type: "string" },
      model: { type: "string" }, sessionID: { type: "string" }, background: { type: "boolean" } },
      required: ["agent", "description", "prompt"], additionalProperties: false }, execute }
  const original = current
  const editor: Tool.ToolEditor = { get: name => name === "subagent" ? { ...current, id: name } : undefined,
    list: () => [{ ...current, id: "subagent" }], namespace() {}, add() { assert.fail("no invented tool") }, remove() { assert.fail("no removal") },
    update(name, update) { assert.equal(name, "subagent"); const draft = { ...current }; update(draft); current = draft } }
  const ctx: Pick<Plugin.Context, "tool"> = { tool: { transform: async callback => { callback(editor); return { dispose: async () => {} } },
    list: async () => [{ ...current, id: "subagent" }], reload: async () => {}, hook: async () => { assert.fail("no hidden hook install") } } }
  const registration = await installNativeTaskAdapter(ctx, admissions)
  return { captured: current, original, registration }
}

test("missing native producer/ref verifier cannot construct or fall back to ENV/HTTP authority", async t => {
  const f = await fixture(); t.after(f.g.f.cleanup); t.after(() => f.product.dispose())
  assert.throws(() => createNativeProductAdmissions({ ...f.options, channel: undefined! }), /policy-unqualified/)
  assert.throws(() => createNativeProductAdmissions({ ...f.options, channel: { ...f.c, sdk: undefined! } }), /policy-unqualified/)
  assert.throws(() => createNativeProductAdmissions({ ...f.options, channel: { ...f.c, nonce: "foreign" } }), /policy-unqualified/)
  assert.throws(() => createNativeProductAdmissions({ ...f.options, channel: { ...f.c, incarnationID: "foreign" } }), /policy-unqualified/)
  assert.throws(() => createNativeProductAdmissions({ ...f.options, channel: { ...f.c, channel: {} } }))
  assert.throws(() => createNativeProductAdmissions({ ...f.options, channel: { ...f.c, invocations: {} as never } }), /policy-unqualified/)
  assert.throws(() => createNativeProductAdmissions({ ...f.options, channel: { ...f.c, business: {} as never } }), /policy-unqualified/)
  assert.equal(f.writes.length, 0)
})

test("native human lifecycle revocation during async observation cannot reserve or inherit a send permit", async t => {
  const f = await fixture(); t.after(f.g.f.cleanup); t.after(() => f.product.dispose()); await f.g.task("work")
  f.state.beforeTask = () => { f.state.human = false }
  await assert.rejects(f.product.admissions.reserve(f.invoke("work"), f.fence()))
  assert.equal((await f.g.f.core.store.read()).derivedCalls, undefined); assert.equal(f.g.children.size, 0)
})

test("asynchronous/nonvoid current callbacks cannot qualify the native product construction", async t => {
  const f = await fixture(); t.after(f.g.f.cleanup); t.after(() => f.product.dispose())
  for (const result of [true, Promise.resolve(), { then() { assert.fail("must not assimilate alleged authority") } }]) {
    assert.throws(() => createNativeProductAdmissions({ ...f.options, channel: { ...f.c, assertCurrent: () => result as never } }), /policy-unqualified/)
  }
  assert.equal(f.writes.length, 0)
})

test("declared native composition reserves durable authority prebirth, publishes/activates, prepares ENV, then independently ends", async t => {
  const f = await fixture(); t.after(f.g.f.cleanup); t.after(() => f.product.dispose()); await f.g.task("work")
  const invocation = f.invoke("work"), reservation = await f.product.admissions.reserve(invocation, f.fence())
  const id = f.state.lastBody!.reservationID
  assert.equal((await f.g.authority.read(id))!.state, "invoking"); assert.equal(f.g.children.size, 0)
  f.birth(invocation)
  const bound = await f.product.admissions.bindActualChild(invocation, reservation, f.state.childID, f.fence())
  assert.equal((await f.g.authority.read(id))!.state, "active")
  assert.equal((await f.g.mission()).tasks[0].actorSessionId, f.state.childID)
  assert.equal(f.writes.length, 1); assert.equal(f.writes[0].variables.TEMP, "backend-profile-temp")
  assert.equal(f.writes[0].variables.CODENOMAD_AUTOMATION_BRIDGE_TOKEN, undefined)
  assert.deepEqual(bound, { kind: "native-product-bound" }, "handle contains no proof, ENV or storage truth")
  await f.product.admissions.returned(invocation, reservation, bound, { metadata: { sessionID: f.state.childID, status: "completed" } }, f.fence())
  assert.equal((await f.g.authority.read(id))!.state, "ended")
  assert.equal((await f.g.mission()).tasks[0].nativeExecution!.ended, "returned")
  assert.deepEqual((await f.g.mission()).reports, [], "foreground end is not business completion")
})

test("raw owned family reserves capacity and fresh ENV but gains no derived/task/report authority", async t => {
  const f = await fixture(); t.after(f.g.f.cleanup); t.after(() => f.product.dispose())
  const invocation = f.invoke(), { reservation, bound } = await f.reserveBind(invocation)
  assert.equal(reservation.scope, "owned"); assert.equal(f.state.rawReservations, 1); assert.equal(f.writes.length, 1)
  assert.equal((await f.g.f.core.store.read()).derivedCalls, undefined)
  await f.product.admissions.returned(invocation, reservation, bound, { metadata: { sessionID: f.state.childID, status: "completed" } }, f.fence())
  await assert.rejects(f.product.authorizeNativeReport({ contract: { missionID: f.g.f.target.missionID, taskKey: "raw", generation: 1 },
    sessionID: f.state.childID, toolCallID: "call_report", messageID: "msg_report" }))
})

test("positive unrelated permit preserves native fields and exempts ENV only through trusted policy", async t => {
  const f = await fixture(); t.after(f.g.f.cleanup); t.after(() => f.product.dispose()); f.state.scope = "unowned"
  f.state.human = false // Mission Pause/revocation must not become a blanket unrelated-send veto.
  const invocation = f.invoke(), input = structuredClone(invocation.nativeInput)
  const { reservation } = await f.reserveBind(invocation)
  assert.equal(reservation.scope, "unowned"); assert.deepEqual(invocation.nativeInput, input)
  assert.equal(f.state.rawReservations, 0); assert.equal(f.writes.length, 0)
  await f.g.task("work"); await assert.rejects(f.product.admissions.reserve(f.invoke("work"), f.fence()))
})

for (const input of [{ model: { providerID: "fixture", id: "model" } }, { model: "model" }, { model: "fixture/model#wrong" },
  { agent: "different" }, { confirmation: true }]) {
  test(`official subagent input/resolved execution mismatch refuses before native birth: ${JSON.stringify(input)}`, async t => {
    const f = await fixture(); t.after(f.g.f.cleanup); t.after(() => f.product.dispose()); await f.g.task("work")
    await assert.rejects(f.product.admissions.reserve(f.invoke("work", input), f.fence()))
    assert.equal(f.g.children.size, 0); assert.equal((await f.g.f.core.store.read()).derivedCalls, undefined)
  })
}

test("absent input model requires genuine exact runtime resolution, never guessed task/profile matching", async t => {
  const f = await fixture(); t.after(f.g.f.cleanup); t.after(() => f.product.dispose()); await f.g.task("work")
  const invocation = f.invoke("work"); delete (invocation.nativeInput as Record<string, unknown>).model
  await f.product.admissions.reserve(invocation, f.fence())
  assert.deepEqual(f.state.lastBody!.execution, f.state.selected)
})

const partialSelections: Array<[string, DerivedExecution | undefined]> = [
  ["default", undefined], ["empty", {}], ["agent-only", { agent: "worker" }],
  ["model-only", { model: { providerID: "fixture", id: "model", variant: "careful" } }],
]
for (const [name, execution] of partialSelections) {
  test(`structural/unqualified: ${name} declaration accepts verified full resolution and gates against accepted child`, async t => {
    const f = await fixture(); t.after(f.g.f.cleanup); t.after(() => f.product.dispose()); await f.g.task("work", { execution })
    const invocation = f.invoke("work"); delete (invocation.nativeInput as Record<string, unknown>).model
    const first = await f.reserveBind(invocation), body = f.state.lastBody!, record = (await f.g.authority.read(body.reservationID))!
    assert.deepEqual(body.execution, execution ?? {}, "declared constraints are not filled with runtime defaults")
    assert.deepEqual(record.child!.execution, f.state.selected, "actual full profile remains independently accepted")
    const boundary = f.modelBoundary(), resolution = await f.product.gates.resolve(boundary, f.fence())
    await f.product.gates.prepare(boundary, resolution, f.fence()); f.product.gates.assertCurrent(boundary, resolution)
    const tool = f.toolBoundary(), toolResolution = await f.product.gates.resolve(tool, f.fence())
    await f.product.gates.prepare(tool, toolResolution, f.fence()); f.product.gates.assertCurrent(tool, toolResolution)
    assert.equal(f.writes.length, 3)
    await f.product.admissions.returned(invocation, first.reservation, first.bound,
      { metadata: { sessionID: f.state.childID, status: "completed" } }, f.fence()); await f.g.refresh()
    const continuation = f.invoke("work", { sessionID: f.state.childID }, `call_partial_${name}`)
    await f.reserveBind(continuation)
    assert.deepEqual(f.state.lastBody!.execution, execution ?? {})
  })
}

const profileDrifts: Array<[string, Required<DerivedExecution>, string]> = [
  ["agent", { agent: "other-worker", model: { providerID: "fixture", id: "model", variant: "careful" } }, "fixture/model#careful"],
  ["provider", { agent: "worker", model: { providerID: "other", id: "model", variant: "careful" } }, "other/model#careful"],
  ["model", { agent: "worker", model: { providerID: "fixture", id: "other-model", variant: "careful" } }, "fixture/other-model#careful"],
  ["variant", { agent: "worker", model: { providerID: "fixture", id: "model", variant: "other-variant" } }, "fixture/model#other-variant"],
]
for (const [axis, changed, reference] of profileDrifts) {
  test(`structural/unqualified: default contract does not authorize accepted-child ${axis} drift at model/tool gates or continuation`, async t => {
    const f = await fixture(); t.after(f.g.f.cleanup); t.after(() => f.product.dispose()); await f.g.task("work", { execution: undefined })
    const invocation = f.invoke("work"), first = await f.reserveBind(invocation), accepted = f.state.lastBody!
    f.state.selected = structuredClone(changed)
    const boundary = f.modelBoundary(reference), resolution = await f.product.gates.resolve(boundary, f.fence())
    await assert.rejects(f.product.gates.prepare(boundary, resolution, f.fence()), /policy-unqualified/)
    const tool = f.toolBoundary(), toolResolution = await f.product.gates.resolve(tool, f.fence())
    await assert.rejects(f.product.gates.prepare(tool, toolResolution, f.fence()), /policy-unqualified/)
    assert.equal(f.writes.length, 1, "even a matching actual frame cannot override accepted child evidence")
    f.state.selected = structuredClone((await f.g.authority.read(accepted.reservationID))!.child!.execution) as Required<DerivedExecution>
    await f.product.admissions.returned(invocation, first.reservation, first.bound,
      { metadata: { sessionID: f.state.childID, status: "completed" } }, f.fence()); await f.g.refresh()
    f.state.selected = structuredClone(changed)
    const continuation = f.invoke("work", { sessionID: f.state.childID, agent: changed.agent, model: reference }, `call_drift_${axis}`)
    await assert.rejects(f.product.admissions.reserve(continuation, f.fence()), /policy-unqualified/)
    assert.equal((await f.g.f.core.store.read()).derivedCalls!.length, 1)
    assert.equal((await f.g.authority.read(accepted.reservationID))!.state, "ended")
  })
}

test("structural/unqualified: absent declared variant is intentional, not permission for an extra native variant", async t => {
  const f = await fixture(); t.after(f.g.f.cleanup); t.after(() => f.product.dispose())
  await f.g.task("work", { execution: { model: { providerID: "fixture", id: "model" } } })
  await assert.rejects(f.product.admissions.reserve(f.invoke("work"), f.fence()), /policy-unqualified/)
  f.state.selected = { agent: "worker", model: { providerID: "fixture", id: "model" } }
  await f.reserveBind(f.invoke("work", { model: "fixture/model" }))
  const boundary = f.modelBoundary("fixture/model"), resolution = await f.product.gates.resolve(boundary, f.fence())
  await f.product.gates.prepare(boundary, resolution, f.fence())
  assert.deepEqual(f.state.lastBody!.execution, { model: { providerID: "fixture", id: "model" } })
})

test("structural/unqualified: optional task constraints never replace missing native actual resolution", async t => {
  const f = await fixture(); t.after(f.g.f.cleanup); t.after(() => f.product.dispose()); await f.g.task("work", { execution: undefined })
  f.state.selected = { agent: "worker" } as Required<DerivedExecution>
  const invocation = f.invoke("work"); delete (invocation.nativeInput as Record<string, unknown>).model
  await assert.rejects(f.product.admissions.reserve(invocation, f.fence()), /policy-unqualified/)
  assert.equal((await f.g.f.core.store.read()).derivedCalls, undefined)
})

test("structural/unqualified: default declaration still requires exact native override and actual HTTP frame variant", async t => {
  const f = await fixture(); t.after(f.g.f.cleanup); t.after(() => f.product.dispose()); await f.g.task("work", { execution: undefined })
  await assert.rejects(f.product.admissions.reserve(f.invoke("work", { model: "fixture/model#wrong" }), f.fence()), /policy-unqualified/)
  await f.reserveBind(f.invoke("work"))
  const request = new Request("https://provider.invalid/fixture", { method: "POST", body: "native-provider-body" })
  const boundary: NativeFamilyBoundary = { boundary: "http.request", event: { sessionID: Session.ID.make(f.state.childID),
    agent: Agent.ID.make("worker"), model: Model.Ref.parse("fixture/model#wrong"), kind: "primary", request } }
  const resolution = await f.product.gates.resolve(boundary, f.fence())
  await assert.rejects(f.product.gates.prepare(boundary, resolution, f.fence()), /policy-unqualified/)
  assert.equal(boundary.event.request, request); assert.equal(await request.text(), "native-provider-body")
  assert.equal(f.writes.length, 1)
})

test("structural/unqualified: different raw-family actual profile prepares without declared-task/report privilege", async t => {
  const f = await fixture(); t.after(f.g.f.cleanup); t.after(() => f.product.dispose())
  f.state.selected = { agent: "raw-worker", model: { providerID: "raw-provider", id: "raw-model", variant: "raw-variant" } }
  await f.reserveBind(f.invoke(undefined, { agent: "raw-worker", model: "raw-provider/raw-model#raw-variant" }))
  const boundary = f.modelBoundary("raw-provider/raw-model#raw-variant"), resolution = await f.product.gates.resolve(boundary, f.fence())
  await f.product.gates.prepare(boundary, resolution, f.fence())
  assert.equal(f.writes.length, 2); assert.equal(f.state.rawReservations, 1)
  assert.equal((await f.g.f.core.store.read()).derivedCalls, undefined)
  assert.equal(f.state.lastBody, undefined)
  await assert.rejects(f.product.authorizeNativeReport({ contract: { missionID: f.g.f.target.missionID, taskKey: "raw", generation: 1 },
    sessionID: f.state.childID, toolCallID: "call_raw_report", messageID: "msg_raw_report" }))
})

test("owned mode, task generation and dependency completion are not substituted by a current mission revision", async t => {
  const f = await fixture(); t.after(f.g.f.cleanup); t.after(() => f.product.dispose())
  await f.g.task("pending"); await f.g.task("work", { blockedBy: ["pending"] })
  await assert.rejects(f.product.admissions.reserve(f.invoke("work"), f.fence()))
  const wrong = f.invoke("work"); (wrong.mission as { generation: number }).generation = (await f.g.mission()).revision
  await assert.rejects(f.product.admissions.reserve(wrong, f.fence()))
  await f.g.task("independent", { executionMode: { kind: "independent", reason: "existing-root", explanation: "Explicit root" } })
  await assert.rejects(f.product.admissions.reserve(f.invoke("independent"), f.fence()))
  assert.equal(f.g.children.size, 0); assert.equal((await f.g.f.core.store.read()).derivedCalls, undefined)
})

test("reuse requires explicit native child/sessionID and exact declared source, preserving existing actor identity", async t => {
  const f = await fixture(); t.after(f.g.f.cleanup); t.after(() => f.product.dispose()); await f.g.task("source", { title: "Original actor" })
  const invocation = f.invoke("source"), first = await f.reserveBind(invocation), source = f.state.lastBody!
  await f.g.report(source, f.state.childID)
  await f.product.admissions.returned(invocation, first.reservation, first.bound,
    { metadata: { sessionID: f.state.childID, status: "completed" } }, f.fence()); await f.g.refresh()
  await f.g.task("reuse", { blockedBy: ["source"], executionMode: { kind: "native", parentTaskKey: null, reuseFromTaskKey: "source" } })
  await assert.rejects(f.product.admissions.reserve(f.invoke("reuse"), f.fence()))
  await assert.rejects(f.product.admissions.reserve(f.invoke("reuse", { sessionID: "ses_sibling" }), f.fence()))
  await f.reserveBind(f.invoke("reuse", { sessionID: f.state.childID }))
  assert.deepEqual(f.state.lastBody!.choice, { kind: "reuse", sessionID: f.state.childID, fromTask: source.task })
  const actor = (await f.g.mission()).actors.find(actor => actor.sessionId === f.state.childID)!
  assert.equal(actor.title, "Original actor"); assert.equal(actor.managed, false)
})

test("declared nested parent must be signed accepted actor with its own independent generation", async t => {
  const f = await fixture(); t.after(f.g.f.cleanup); t.after(() => f.product.dispose())
  await f.g.seedCompleted("dependency", "worker", [], "ses_dependency")
  await f.g.task("parent"); await f.reserveBind(f.invoke("parent")); const parent = f.state.lastBody!
  await f.g.task("nested", { executionMode: { kind: "native", parentTaskKey: "parent" } })
  const mission = await f.g.mission()
  await f.g.journal.append({ ...f.g.base(), type: "mission.revised", requestID: "req_nested_contract", expectedRevision: mission.revision,
    actorSessionID: parent.coordinatorSessionID, reason: "Independent own contract", notesSpecified: false, retiredTasks: [], addedTasks: [],
    dependencyUpdates: [{ taskKey: "nested", blockedBy: ["dependency"] }] })
  const draft = f.invoke("nested")
  const invocation: NativeTaskInvocation = { ...draft, sessionID: f.state.childID as Tool.ToolContext["sessionID"],
    mission: { ...draft.mission!, generation: 2 } }
  f.state.childID = "ses_nested"
  await f.reserveBind(invocation)
  assert.equal(f.state.lastBody!.task.generation, 2); assert.equal(f.state.lastBody!.parentTask!.generation, 1)
})

test("explicit continuation is exact and binding does not recheck idle after original executor entry", async t => {
  const f = await fixture(); t.after(f.g.f.cleanup); t.after(() => f.product.dispose()); await f.g.task("work")
  const original = f.invoke("work"), first = await f.reserveBind(original)
  await f.product.admissions.returned(original, first.reservation, first.bound, { metadata: { sessionID: f.state.childID, status: "completed" } }, f.fence())
  await f.g.refresh()
  const invocation = f.invoke("work", { sessionID: f.state.childID }, "call_continued")
  const reservation = await f.product.admissions.reserve(invocation, f.fence())
  await f.product.admissions.guardContinuation(invocation, reservation, f.state.childID, f.fence())
  f.birth(invocation); f.g.setIdle(false)
  const bound = await f.product.admissions.bindActualChild(invocation, reservation, f.state.childID, f.fence())
  assert.ok(bound); assert.equal((await f.g.authority.read(f.state.lastBody!.reservationID))!.state, "active")
})

test("background launch retains outstanding active child; unknown foreground cannot fabricate end", async t => {
  const f = await fixture(); t.after(f.g.f.cleanup); t.after(() => f.product.dispose()); await f.g.task("work")
  const invocation = f.invoke("work", { background: true }), value = await f.reserveBind(invocation), id = f.state.lastBody!.reservationID
  await f.product.admissions.launchReturned(invocation, value.reservation, value.bound,
    { metadata: { sessionID: f.state.childID, status: "running" } }, f.fence())
  assert.equal((await f.g.authority.read(id))!.state, "active"); assert.equal((await f.g.mission()).tasks[0].nativeExecution!.ended, undefined)
  await assert.rejects(f.product.admissions.returned(invocation, value.reservation, value.bound,
    { metadata: { sessionID: f.state.childID, status: "completed" } }, f.fence()))
  assert.equal((await f.g.authority.read(id))!.state, "active")
})

test("unknown exact foreground return proof retains active authority and never publishes an end", async t => {
  const f = await fixture(); t.after(f.g.f.cleanup); t.after(() => f.product.dispose()); await f.g.task("work")
  const invocation = f.invoke("work"), value = await f.reserveBind(invocation), id = f.state.lastBody!.reservationID
  f.state.returnState = "unknown"
  await assert.rejects(f.product.admissions.returned(invocation, value.reservation, value.bound,
    { metadata: { sessionID: f.state.childID, status: "completed" } }, f.fence()))
  assert.equal((await f.g.authority.read(id))!.state, "active"); assert.equal((await f.g.mission()).tasks[0].nativeExecution!.ended, undefined)
})

test("missing guarded binding ACK retains invoking/shared state and never releases quota or retries native execution", async t => {
  const f = await fixture(); t.after(f.g.f.cleanup); t.after(() => f.product.dispose()); await f.g.task("work")
  const invocation = f.invoke("work"), reservation = await f.product.admissions.reserve(invocation, f.fence()); f.birth(invocation)
  f.g.afterWrite(() => { throw new Error("lost binding ACK") })
  await assert.rejects(f.product.admissions.bindActualChild(invocation, reservation, f.state.childID, f.fence()), /lost binding ACK/)
  f.g.afterWrite()
  assert.equal((await f.g.authority.read(f.state.lastBody!.reservationID))!.state, "invoking")
  assert.equal((await f.g.mission()).tasks[0].actorSessionId, f.state.childID); assert.equal(f.writes.length, 0)
  await assert.rejects(f.product.admissions.bindActualChild(invocation, reservation, f.state.childID, f.fence()))
  assert.ok(!f.order.includes("release-known-native-refs")); assert.equal(f.writes.length, 0)
})

test("copied/forged process handles and wrong structured child cannot borrow signed authority", async t => {
  const f = await fixture(); t.after(f.g.f.cleanup); t.after(() => f.product.dispose()); await f.g.task("work")
  const invocation = f.invoke("work"), reservation = await f.product.admissions.reserve(invocation, f.fence()); f.birth(invocation)
  await assert.rejects(f.product.admissions.bindActualChild(invocation, { ...reservation, claim: { ...reservation.claim } }, f.state.childID, f.fence()))
  await assert.rejects(f.product.admissions.bindActualChild(invocation, reservation, "ses_wrong", f.fence()))
  assert.equal((await f.g.mission()).tasks[0].nativeBinding, undefined)
})

for (const race of ["profile", "connection", "uncertain-env"] as const) {
  test(`bound journal/authority remain ambiguous without replay or quota release when ${race} fails ENV preparation`, async t => {
    const f = await fixture(); t.after(f.g.f.cleanup); t.after(() => f.product.dispose()); await f.g.task("work")
    const invocation = f.invoke("work"), reservation = await f.product.admissions.reserve(invocation, f.fence()); f.birth(invocation)
    if (race === "profile") f.state.beforeEnvironment = () => { f.state.generation++ }
    if (race === "connection") f.state.beforeEnvironment = () => { f.state.current = false }
    if (race === "uncertain-env") f.state.failEnvironment = true
    await assert.rejects(f.product.admissions.bindActualChild(invocation, reservation, f.state.childID, f.fence()))
    assert.equal((await f.g.authority.read(f.state.lastBody!.reservationID))!.state, "active")
    assert.equal((await f.g.mission()).tasks[0].actorSessionId, f.state.childID); assert.equal(f.writes.length, 1)
    f.state.current = true; f.state.beforeEnvironment = undefined; f.state.failEnvironment = false
    await assert.rejects(f.product.admissions.bindActualChild(invocation, reservation, f.state.childID, f.fence()))
    assert.equal(f.writes.length, 1)
  })
}

test("fresh uncached model gates check actual resolved variant and keep receipt fenced until real native effect retirement", async t => {
  const f = await fixture(); t.after(f.g.f.cleanup); t.after(() => f.product.dispose()); await f.g.task("work"); await f.reserveBind(f.invoke("work"))
  const boundary = f.modelBoundary(), resolution = await f.product.gates.resolve(boundary, f.fence())
  await f.product.gates.prepare(boundary, resolution, f.fence()); f.product.gates.assertCurrent(boundary, resolution)
  f.configured.TEMP = "changed-backend-profile"
  const next = f.modelBoundary(), nextResolution = await f.product.gates.resolve(next, f.fence())
  await f.product.gates.prepare(next, nextResolution, f.fence())
  assert.equal(f.writes.at(-1)!.variables.TEMP, "changed-backend-profile"); assert.equal(f.state.envReads, 3)
  f.state.generation++; assert.throws(() => f.product.gates.assertCurrent(boundary, resolution))
  f.state.selected.model.variant = "wrong"
  const changed = f.modelBoundary(), changedResolution = await f.product.gates.resolve(changed, f.fence())
  await assert.rejects(f.product.gates.prepare(changed, changedResolution, f.fence()))
  assert.equal(f.writes.length, 3)
})

test("raw owned boundary prepares fresh ENV, unrelated remains untouched, and identity-less owned Shell stays closed", async t => {
  const f = await fixture(); t.after(f.g.f.cleanup); t.after(() => f.product.dispose()); await f.reserveBind(f.invoke())
  const boundary = f.modelBoundary(), resolution = await f.product.gates.resolve(boundary, f.fence())
  await f.product.gates.prepare(boundary, resolution, f.fence()); assert.equal(f.writes.length, 2)
  f.state.scope = "unowned"
  const unrelated = f.modelBoundary(), permit = await f.product.gates.resolve(unrelated, f.fence()), original = structuredClone(unrelated)
  await f.product.gates.prepare(unrelated, permit, f.fence()); assert.deepEqual(unrelated, original); assert.equal(f.writes.length, 2)
  f.state.scope = "owned"
  const shell = { boundary: "shell.create.before", event: {} } as NativeFamilyBoundary
  await assert.rejects(f.product.gates.resolve(shell, f.fence()), /policy-unqualified/)
})

test("report authorization uses actual reporter Tool/session/message independently and does not publish report or wake coordinator", async t => {
  const f = await fixture(); t.after(f.g.f.cleanup); t.after(() => f.product.dispose()); await f.g.task("work"); await f.reserveBind(f.invoke("work"))
  const request: MissionNativeReportRequest = { contract: { missionID: f.g.f.target.missionID, taskKey: "work", generation: 1 },
    sessionID: f.state.childID, toolCallID: "call_actual_report", messageID: "msg_actual_report" }
  const auth = await f.product.authorizeNativeReport(request)
  assert.equal(auth.call.toolCallID, "call_work"); assert.equal(auth.current(), true)
  assert.deepEqual(f.g.forwarded.at(-1)!.reportRequest, request)
  f.state.human = false; assert.equal(auth.current(), true, "historical report evidence does not acquire human send privilege")
  assert.deepEqual((await f.g.mission()).reports, []); assert.ok(f.requests.every(value => value.startsWith("GET") || value.endsWith("/environment")))
  f.product.dispose(); assert.throws(auth.current)
})

test("dispose revokes captures before releasing only known native refs and all captured callbacks refuse", async t => {
  const f = await fixture(); t.after(f.g.f.cleanup); await f.g.task("work")
  const invocation = f.invoke("work"), value = await f.reserveBind(invocation)
  f.product.dispose(); f.product.dispose()
  assert.deepEqual(f.order.slice(-2), ["revoke-native-captures", "release-known-native-refs"])
  assert.throws(() => f.product.admissions.assertCurrent(invocation, value.reservation))
  await assert.rejects(f.product.admissions.reserve(invocation, f.fence()))
  assert.equal((await f.g.authority.read(f.state.lastBody!.reservationID))!.state, "active", "disposal does not release durable authority/cleanup daemon")
})

test("unknown native capture revocation never releases managed references optimistically", async t => {
  const f = await fixture(); t.after(f.g.f.cleanup); f.state.revokeFails = true
  assert.throws(f.product.dispose, /revocation uncertain/)
  assert.equal(f.order.at(-1), "revoke-native-captures"); assert.ok(!f.order.includes("release-known-native-refs"))
})

test("thin official-shaped native executor integration awaits binding+ENV before its own prompt, preserves signal/input/result", async t => {
  const f = await fixture(); t.after(f.g.f.cleanup); t.after(() => f.product.dispose()); await f.g.task("work")
  const result: Tool.Result = { output: { sessionID: f.state.childID, status: "completed", output: "native-output" },
    content: "native-output", metadata: { sessionID: f.state.childID, status: "completed" } }
  const nativeSignal = freshSignal(), input = { ...f.invoke("work").nativeInput, mission: f.invoke("work").mission }
  const executor = await officialExecutor(f.product.admissions, async (requested, tool) => {
      f.state.nativeCalls++; assert.equal(tool.signal, nativeSignal); assert.deepEqual(requested, f.invoke("work").nativeInput)
      f.birth(f.invoke("work"))
      await tool.progress({ sessionID: f.state.childID, status: "running" })
      assert.equal(f.writes.length, 1); assert.equal((await f.g.authority.read(f.state.lastBody!.reservationID))!.state, "active")
      f.state.nativePrompts++; return result
    })
  t.after(() => executor.registration.dispose())
  const invocation = f.invoke("work")
  const returned = await executor.captured.execute(input, { sessionID: invocation.sessionID, messageID: invocation.messageID, id: invocation.id,
    agent: invocation.agent, signal: nativeSignal, progress: async () => {} })
  assert.equal(returned, result); assert.deepEqual(executor.captured.options, executor.original.options)
  assert.equal(f.state.nativeCalls, 1); assert.equal(f.state.nativePrompts, 1)
  assert.deepEqual((await f.g.mission()).reports, [])
})

test("profile change during forwarded progress revokes the ENV/effect receipt before original native prompt", async t => {
  const f = await fixture(); t.after(f.g.f.cleanup); t.after(() => f.product.dispose()); await f.g.task("work")
  const invocation = f.invoke("work")
  const executor = await officialExecutor(f.product.admissions, async (_input, tool) => {
    f.birth(invocation)
    await tool.progress({ sessionID: f.state.childID, status: "running" })
    f.state.nativePrompts++; return { metadata: { sessionID: f.state.childID, status: "completed" } }
  })
  t.after(() => executor.registration.dispose())
  await assert.rejects(executor.captured.execute({ ...invocation.nativeInput, mission: invocation.mission },
    { sessionID: invocation.sessionID, messageID: invocation.messageID, id: invocation.id, agent: invocation.agent, signal: freshSignal(),
      progress: async () => { await Promise.resolve(); f.state.generation++ } }))
  assert.equal(f.state.nativePrompts, 0); assert.equal(f.writes.length, 1)
  assert.equal((await f.g.authority.read(f.state.lastBody!.reservationID))!.state, "active")
  assert.ok(f.order.includes("ambiguous-failure-observed"))
})
