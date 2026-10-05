import assert from "node:assert/strict"
import { generateKeyPairSync, sign } from "node:crypto"
import test from "node:test"
import { setupDurableMissionsPlugin, durablePlugin, type DurableMissionsContext, type DurableMissionsHost,
  type DurableMissionAdmission, type DurableMissionTransportReceipt } from "./durable-plugin"
import { MissionControl } from "../../missions/control"
import { MissionJournal, stableToken, type MissionStorage } from "../../missions/journal"
import type { MissionJsonValue } from "../../missions/model"
import type { NativeMissionSession } from "../../missions/control-types"
import { authoritySignerDigest, authoritySigningBytes, canonicalAuthority, MISSION_AUTHORITY_POLICY, MissionAuthorityError,
  type AuthorityIntent, type ProvisionedAuthoritySigner } from "../../missions/authority-protocol"
import { CODENOMAD_MISSIONS_AUTHORITY_RPC } from "../../missions/authority-rpc"
import { MISSION_AUTHORITY_STORAGE_PREFIX } from "../../missions/authority-store"
import { controlResumeAdmissionID } from "../../missions/receipt-identity"

class NativeStorage implements MissionStorage {
  readonly data = new Map<string, MissionJsonValue>()
  async get(key: string) { const value = this.data.get(key); return value === undefined ? undefined : structuredClone(value) }
  async set(key: string, value: MissionJsonValue) { this.data.set(key, JSON.parse(JSON.stringify(value))) }
  async remove(key: string) { this.data.delete(key) }
  async scan({ prefix, after, limit = 100 }: { prefix: string; after?: string; limit?: number }) {
    const keys = [...this.data.keys()].filter(key => key.startsWith(prefix) && (!after || key > after)).sort()
    const page = keys.slice(0, limit)
    return { entries: page.map(key => ({ key, value: structuredClone(this.data.get(key)!) })),
      ...(keys.length > limit ? { next: page[page.length - 1] } : {}) }
  }
}
type Handler = (input: any, context: any) => Promise<any>
type Tool = { name: string; input: unknown; execute(input: unknown, context: { sessionID: string; messageID: string; id: string; progress(): Promise<void> }): Promise<{ content: string }> }
const independent = { executionMode: { kind: "independent" as const, reason: "existing-root" as const,
  explanation: "Qualify the explicit independent-root authority path" } }

function fixture() {
  const storage = new NativeStorage()
  const location = { directory: "/owned/native-project", project: { id: "project-durable", canonical: "/owned/native-project" } }
  const sessions = new Map<string, NativeMissionSession>(["ses_coordinator", "ses_actor"].map(id => [id,
    { id, projectID: location.project.id, title: id, location: { directory: location.directory } }]))
  const rpcs = new Map<string, { definition: any; handlers: Record<string, Handler> }>()
  const tools = new Map<string, Tool>()
  const hooks: Array<(event: { sessionID: string; system: Array<{ type: "text"; text: string }>; tools: Record<string, unknown> }) => Promise<void>> = []
  const journal = new MissionJournal(storage, location.project.id, location.project.canonical)
  const counts = { nativePrompts: 0, nativeSynthetics: 0, nativeCreates: 0, disposed: 0, registrations: 0 }
  const registration = () => ({ dispose: async () => { counts.disposed++ }, events: { emit: async () => {} } })
  const context = {
    location, storage,
    agent: { list: async () => ({ data: [] }) }, model: { list: async () => ({ data: [] }) },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => { const found = sessions.get(sessionID); if (!found) throw new Error("missing session"); return structuredClone(found) },
      create: async (input: { id: string; title: string; location: NativeMissionSession["location"] }) => {
        counts.nativeCreates++
        const session = { id: input.id, title: input.title, projectID: location.project.id, location: input.location }
        sessions.set(input.id, session); return structuredClone(session)
      },
      prompt: async () => { counts.nativePrompts++; return {} }, synthetic: async () => { counts.nativeSynthetics++; return {} },
      hook: async (_name: string, callback: typeof hooks[number]) => { hooks.push(callback); return registration() },
    },
    tool: { transform: async (callback: (draft: { namespace(): void; add(tool: Tool): void }) => void) => {
      callback({ namespace: () => {}, add: tool => { tools.set(tool.name, tool) } }); return registration()
    } },
    rpc: { register: async (definition: { id: string }, handlers: Record<string, Handler>) => {
      counts.registrations++
      if (rpcs.has(definition.id)) throw new Error("duplicate native RPC registration")
      rpcs.set(definition.id, { definition, handlers }); return registration()
    } },
  } as unknown as DurableMissionsContext
  const lifecycleAcknowledgement = async (input: { missionID: string; operationID: string; sessionID: string }): Promise<DurableMissionTransportReceipt> => {
    const snapshot = await new MissionJournal(storage, location.project.id, location.project.canonical).snapshot()
    const operation = snapshot.missions.find(mission => mission.id === input.missionID)?.control
    if (!operation || operation.id !== input.operationID) throw new Error("No fake native control")
    const identity = { ...input, action: operation.action }
    return { nativeAcknowledgement: operation.action === "start" ? { ...identity, action: "start", disposition: "start-admitted",
      admission: { id: controlResumeAdmissionID(operation.id, input.sessionID), sessionID: input.sessionID,
        type: "synthetic", delivery: "queue", time: { created: 1 }, payload: { text: "Resume existing work",
          metadata: { "codenomad.mission": { version: 1, kind: "lifecycle", missionID: input.missionID, operationID: operation.id } } } } }
      : { ...identity, action: operation.action, disposition: "interrupt-observed", interrupt: { interrupted: true }, cancellations: [] } }
  }
  const base = new MissionControl({ project: { ...location.project, location: { directory: location.directory } },
    storage, sessions: context.session, transport: { prompt: async () => ({}), synthetic: async () => ({}),
      lifecycle: async (_sessionID, input) => lifecycleAcknowledgement(input) } })
  const invoke = async (method: string, input: unknown, rpcID = "codenomad.missions") => {
    const rpc = rpcs.get(rpcID)!
    const schema = rpc.definition.methods[method].input
    if (typeof schema.safeParse === "function") {
      const validation = schema.safeParse(input)
      if (!validation.success) throw validation.error
    }
    const result = await rpc.handlers[method](input, { signal: new AbortController().signal,
      error: (_name: string, _message: string, data: { code: string }) => Object.assign(new Error("native declared rejection"), data),
    })
    if (result instanceof Error) throw result
    return result
  }
  const tool = async (name: string, input: unknown, sessionID = "ses_coordinator") => JSON.parse((await tools.get(name)!.execute(input,
    { sessionID, messageID: "msg_native", id: "call_native", progress: async () => {} })).content)
  const seed = async (prepared = false, task = false) => {
    const { mission } = await base.create({ requestID: "legacy-request", objective: "Existing evidence", template: "custom",
      coordinatorSessionID: "ses_coordinator", prepared })
    if (task) await base.delegate("ses_coordinator", { missionID: mission.id, taskKey: "task-one", title: "One",
      brief: "Existing assignment", role: "worker", blockedBy: [], targetSessionID: "ses_actor", delivery: "queue" })
    return (await journal.snapshot()).missions.find(item => item.id === mission.id)!
  }
  const { publicKey, privateKey } = generateKeyPairSync("ed25519")
  let signers: readonly ProvisionedAuthoritySigner[] = []
  let managed = true
  const admitted: DurableMissionAdmission[] = []
  let duringPreparation: (() => Promise<void>) | undefined
  let signerReadHook: (() => void) | undefined
  const root = { mode: "git" as const, directory: location.directory, family: "physical-family", checkout: "exact-checkout" }
  const host: DurableMissionsHost = {
    assertManagedIncarnation: () => { if (!managed) throw new MissionAuthorityError("policy-unqualified"); return true },
    readSigners: async () => { signerReadHook?.(); return signers },
    assertSignerCurrent: signer => {
      const current = signers.find(item => item.authorityID === signer.authorityID && item.keyID === signer.keyID
        && item.projectID === signer.projectID && item.profileID === signer.profileID)
      if (!current || current.provisioningGeneration !== signer.provisioningGeneration || current.qualification !== "qualified"
        || !(["authorityID", "keyID", "profileID", "executionHost", "namespace", "projectID", "projectCanonical", "policy"] as const).every(key => current[key] === signer[key])
        || authoritySignerDigest(current.publicKey) !== signer.signerDigest || canonicalAuthority(current.roots) !== canonicalAuthority(signer.roots)) throw new MissionAuthorityError("untrusted-signer")
      return true
    },
    resolveRoot: async target => { if (target.directory !== root.directory) throw new MissionAuthorityError("binding-mismatch"); return root },
    transport: { execute: async (request, options) => {
      options.signal.throwIfAborted()
      // Stub the authenticated backend boundary, not ctx.session or a second
      // Mission engine. Both preparation and the final native checkpoint run.
      await options.assertCurrent()
      await duringPreparation?.()
      await options.assertCurrent()
      admitted.push(structuredClone(request))
      return request.kind === "lifecycle" ? lifecycleAcknowledgement(request.input) : { admitted: true }
    } },
  }
  const provision = async () => {
    const challenge = await invoke("challenge", { nonce: "bounded-nonce-123456" }, CODENOMAD_MISSIONS_AUTHORITY_RPC.id)
    signers = [{ authorityID: "trusted-host", keyID: "current-key", profileID: "owned-profile", executionHost: "windows:owned-host",
      namespace: challenge.namespace, projectID: location.project.id, projectCanonical: location.project.canonical, roots: [root],
      publicKey, provisioningGeneration: "fixture-generation-one", policy: MISSION_AUTHORITY_POLICY, qualification: "qualified" }]
  }
  const body = async (method: AuthorityIntent["method"], missionID: string, overrides: Record<string, unknown> = {}): Promise<AuthorityIntent> => {
    const saved = (await journal.snapshot()).missions.find(item => item.id === missionID)
    const { publicKey: _key, qualification: _qualification, provisioningGeneration: _generation, ...scope } = signers[0]
    const current = await invoke("state", { missionID }, CODENOMAD_MISSIONS_AUTHORITY_RPC.id)
    return { ...scope, version: 1, method, missionID, coordinatorSessionID: saved?.coordinatorSessionId ?? "ses_coordinator",
      epoch: method === "adopt" ? (current.grant?.epoch ?? 0) + 1 : current.grant?.epoch ?? 0,
      expectedRevision: saved?.revision ?? 0, requestID: `request-${method}-${saved?.revision ?? 0}`,
      payload: method === "lifecycle" ? { action: "start" } : method === "update" ? { objective: "Updated objective" }
        : method === "delete" ? { deleteManagedSessions: false } : method === "recover" ? { target: "coordinator" }
        : method === "create" ? { objective: "Prepared signed mission", template: "custom", prepared: true } : {}, ...overrides,
    } as AuthorityIntent
  }
  const signed = (intent: AuthorityIntent) => ({ body: intent, signature: sign(null, authoritySigningBytes(intent), privateKey).toString("base64") })
  const intent = async (value: AuthorityIntent) => invoke("intent", signed(value), CODENOMAD_MISSIONS_AUTHORITY_RPC.id)
  return { storage, location, sessions, context, counts, rpcs, tools, hooks, journal, base, seed, host, admitted, provision, body, intent, signed, invoke, tool,
    loseTrust: () => { signers = [] }, unmanage: () => { managed = false },
    prepareWith: (callback?: () => Promise<void>) => { duringPreparation = callback },
    onSignerRead: (callback?: () => void) => { signerReadHook = callback },
    changeGeneration: () => { signers = signers.map(signer => ({ ...signer, provisioningGeneration: "fixture-generation-two" })) },
  }
}

test("wrapper/core generation mismatch rejects before adoption or Play reservation and permits an explicit retry", async t => {
  for (const method of ["adopt", "lifecycle"] as const) {
    const f = fixture(); const saved = await f.seed(true)
    const dispose = await setupDurableMissionsPlugin(f.context, f.host); t.after(dispose)
    await f.provision()
    if (method === "lifecycle") await f.intent(await f.body("adopt", saved.id))
    const intent = await f.body(method, saved.id)
    const previous = await f.journal.events()
    let reads = 0
    f.onSignerRead(() => { if (++reads === 2) f.changeGeneration() })
    await assert.rejects(f.intent(intent), (error: any) => error.code === "untrusted-signer")
    const state = await f.invoke("state", { missionID: saved.id }, CODENOMAD_MISSIONS_AUTHORITY_RPC.id)
    assert.deepEqual(state.pendingRequestIDs, [])
    assert.equal(state.grant?.sendsEnabled ?? false, false)
    if (method === "adopt") assert.equal(state.grant, null)
    assert.deepEqual(await f.journal.events(), previous)
    assert.equal(f.admitted.length, 0)
    f.onSignerRead()
    const retried = await f.intent(intent)
    assert.equal(retried.receipt.completion.outcome, "applied")
    assert.equal(f.admitted.length, method === "adopt" ? 0 : 1)
  }
})

test("rejecting async host guards fail closed without leaking unhandled rejections", async t => {
  for (const guard of ["assertManagedIncarnation", "assertSignerCurrent"] as const) {
    const f = fixture(); const saved = await f.seed(true)
    const dispose = await setupDurableMissionsPlugin(f.context, f.host); t.after(dispose)
    await f.provision()
    const adoption = await f.body("adopt", saved.id)
    const previous = await f.journal.events()
    // Deliberately invalid host integration at the runtime boundary; async
    // functions cannot satisfy the literal-true interface without this cast.
    f.host[guard] = (async () => { throw new Error("private asynchronous host failure") }) as never
    await assert.rejects(f.intent(adoption), (error: any) => error.code === (guard === "assertManagedIncarnation" ? "policy-unqualified" : "untrusted-signer"))
    await new Promise<void>(resolve => setImmediate(resolve)) // Let rejection monitoring run.
    const state = await f.invoke("state", { missionID: saved.id }, CODENOMAD_MISSIONS_AUTHORITY_RPC.id)
    assert.equal(state.grant, null)
    assert.deepEqual(state.pendingRequestIDs, [])
    assert.deepEqual(await f.journal.events(), previous)
    assert.equal(f.admitted.length, 0)
  }
})

test("real setup keeps journal/tools/context alive without a backend/presence; unsigned RPCs and agent creation deny", async t => {
  const f = fixture(); const saved = await f.seed(false, true)
  const before = await f.journal.events()
  const dispose = await setupDurableMissionsPlugin(f.context); t.after(dispose)
  assert.equal(durablePlugin().id, "codenomad.missions")
  assert.equal(f.counts.registrations, 2)
  assert.equal(f.rpcs.get(CODENOMAD_MISSIONS_AUTHORITY_RPC.id)!.definition, CODENOMAD_MISSIONS_AUTHORITY_RPC)
  assert.equal(f.tools.size, 5); assert.equal(f.hooks.length, 1)
  assert.deepEqual(await f.journal.events(), before)
  const state = await f.invoke("state", { missionID: saved.id }, CODENOMAD_MISSIONS_AUTHORITY_RPC.id)
  assert.equal(state.continuity, "needs-authorization"); assert.equal(state.grant, null)
  assert.equal((await f.tool("inspect", { missionID: saved.id })).mission.id, saved.id)
  const event = { sessionID: "ses_actor", system: [] as Array<{ type: "text"; text: string }>, tools: { mission_delegate: {} } }
  await f.hooks[0](event)
  assert.ok(event.system[0].text.includes(saved.id)); assert.equal(event.tools.mission_delegate, undefined)
  assert.ok(event.system.some(part => part.text.includes("saved mission map is not execution authorization")))
  for (const method of ["create", "update", "delete", "lifecycle", "recover"]) {
    await assert.rejects(f.invoke(method, { approved: true, profileID: "forged" }), /unsigned-privileged-method/)
  }
  await assert.rejects(f.tool("inspect", { start: { objective: "Unauthorized", template: "custom" } }), /unsigned-privileged-method/)
  await assert.rejects(f.tool("delegate", { ...independent, taskKey: "next", title: "Next", brief: "Next", role: "worker", targetSessionID: "ses_actor" }), /authorization-blocked/)
  await assert.rejects(f.tool("revise", { missionID: saved.id, expectedRevision: saved.revision, requestID: "revise-one", reason: "Unauthorized", objective: "Other" }), /authorization-blocked/)
  await assert.rejects(f.tool("report", { missionID: saved.id, final: true, outcome: "failed", summary: "Unauthorized finish" }), /authorization-blocked/)
  await assert.rejects(f.tool("briefing", { missionID: saved.id, requestID: "unsigned-briefing", basedOnRevision: saved.revision,
    summary: "Unauthorized narrative", achieved: [], ongoing: [], obstacles: [], next: [] }), /authorization-blocked/)
  const result = await f.tool("report", { missionID: saved.id, taskKey: "task-one", outcome: "completed", summary: "Saved headless",
    evidence: ["Native evidence"], artifact: { proof: "Existing result" } }, "ses_actor")
  assert.equal(result.disposition, "reported")
  assert.equal(result.mission.reports[0].summary, "Saved headless")
  assert.equal(result.mission.reports[0].notificationStatus, "pending")
  assert.equal(f.counts.nativePrompts, 0); assert.equal(f.counts.nativeSynthetics, 0); assert.equal(f.counts.nativeCreates, 0)
})

test("briefing business write retains durable adoption, Play and current signer authority without a transport send", async t => {
  const f = fixture(), saved = await f.seed(true)
  const dispose = await setupDurableMissionsPlugin(f.context, f.host); t.after(dispose)
  await f.provision()
  await f.intent(await f.body("adopt", saved.id))
  await f.intent(await f.body("lifecycle", saved.id))
  const mission = (await f.journal.snapshot()).missions[0]
  const input = { missionID: mission.id, requestID: "authorized-briefing", basedOnRevision: mission.revision,
    summary: "The project plan is open; no deliverable is verified yet.", achieved: [], ongoing: [], obstacles: [], next: [] }
  const sends = f.admitted.length
  const result = await f.tool("briefing", input)
  assert.equal(result.mission.briefing.requestID, input.requestID)
  assert.equal(f.admitted.length, sends)
  assert.equal(f.counts.nativePrompts, 0)
  assert.equal(f.counts.nativeSynthetics, 0)
  assert.deepEqual(result.mission.tasks, mission.tasks)
  assert.deepEqual(result.mission.reports, mission.reports)
  const before = await f.journal.events()
  f.loseTrust()
  await assert.rejects(f.tool("briefing", { ...input, requestID: "revoked", basedOnRevision: result.mission.revision }), /authorization-blocked|untrusted-signer/)
  assert.deepEqual(await f.journal.events(), before)
})

test("late stopped evidence remains native-actor checked and never wakes coordinator", async t => {
  const f = fixture(); const saved = await f.seed(false, true)
  await f.base.lifecycle({ missionID: saved.id, expectedRevision: saved.revision, requestID: "legacy-stop", action: "stop" })
  const dispose = await setupDurableMissionsPlugin(f.context); t.after(dispose)
  const result = await f.tool("report", { missionID: saved.id, taskKey: "task-one", outcome: "completed", summary: "Late proof", evidence: ["saved"] }, "ses_actor")
  assert.equal(result.mission.runState, "stopped")
  assert.equal(result.mission.reports[0].late, true)
  assert.equal(f.counts.nativeSynthetics, 0)
  const actor = f.sessions.get("ses_actor")!; actor.location = { directory: "/foreign/location" }
  await assert.rejects(f.tool("report", { missionID: saved.id, taskKey: "task-one", outcome: "completed", summary: "Moved proof" }, "ses_actor"), /moved/)
  const before = await f.journal.events()
  await f.invoke("snapshot", {})
  assert.deepEqual(await f.journal.events(), before)
})

test("signed deterministic create is prepared-only; schema rejects driver methods and incorrect IDs before effects", async t => {
  const f = fixture(); const dispose = await setupDurableMissionsPlugin(f.context, f.host); t.after(dispose)
  await f.provision()
  const requestID = "signed-create"
  const missionID = `msn_${stableToken(`${f.location.project.id}\0${requestID}`, 24)}`
  const coordinatorSessionID = `ses_${stableToken(`${missionID}\0coordinator`, 26)}`
  const creation = await f.body("create", missionID, { requestID, coordinatorSessionID })
  const result = await f.intent(creation)
  assert.equal(result.receipt.completion.result.prepared, true)
  assert.equal(result.grant, null)
  assert.equal(f.counts.nativeCreates, 1)
  assert.equal((await f.journal.snapshot()).missions[0].runState, "prepared")
  assert.equal(f.admitted.length, 0)
  const replay = await f.intent(creation)
  assert.equal(replay.grant, null); assert.equal(f.counts.nativeCreates, 1)
  await assert.rejects(f.intent(await f.body("create", "msn_wrong", { requestID: "wrong-request" })), (error: any) => error.code === "binding-mismatch")
  const schema = f.rpcs.get(CODENOMAD_MISSIONS_AUTHORITY_RPC.id)!.definition.methods.intent.input
  assert.equal(schema.safeParse({ ...f.signed(creation), publicKey: "input supplied" }).success, false)
  assert.equal(schema.safeParse(f.signed({ ...creation, method: "invoke" } as never)).success, false)
  assert.equal(f.counts.nativePrompts, 0); assert.equal(f.counts.nativeSynthetics, 0)
})

test("real native lifecycle uses reserved authority transport without nested-lock deadlock; grants gate tools and reports", async t => {
  const f = fixture(); const saved = await f.seed(true)
  const dispose = await setupDurableMissionsPlugin(f.context, f.host); t.after(dispose)
  await f.provision()
  const adoption = await f.body("adopt", saved.id)
  assert.equal((await f.intent(adoption)).grant.sendsEnabled, false)
  assert.equal(f.admitted.length, 0)
  const play = await f.body("lifecycle", saved.id)
  const running = await f.intent(play)
  assert.equal(running.grant.sendsEnabled, true)
  assert.equal(f.admitted.length, 1)
  assert.equal(f.admitted[0].kind, "lifecycle")
  assert.equal(f.admitted[0].intent?.method, "lifecycle")
  assert.equal((await f.intent(play)).grant.sendsEnabled, true)
  assert.equal(f.admitted.length, 1)
  await f.tool("delegate", { ...independent, missionID: saved.id, taskKey: "task-one", title: "One", brief: "Bounded work", role: "worker", targetSessionID: "ses_actor" })
  assert.equal(f.admitted[1].kind, "prompt")
  const reported = await f.tool("report", { missionID: saved.id, taskKey: "task-one", outcome: "completed", summary: "Complete" }, "ses_actor")
  assert.equal(reported.mission.reports[0].notificationStatus, "admitted")
  assert.equal(f.admitted[2].kind, "synthetic")
  await f.intent(await f.body("revoke", saved.id))
  const total = f.admitted.length
  await assert.rejects(f.tool("delegate", { ...independent, missionID: saved.id, taskKey: "task-two", title: "Two", brief: "Two", role: "worker", targetSessionID: "ses_actor" }), /authorization-blocked/)
  await assert.rejects(f.tool("revise", { missionID: saved.id, expectedRevision: reported.mission.revision, requestID: "revise-late", reason: "No", objective: "No" }), /authorization-blocked/)
  assert.equal((await f.intent(adoption)).grant.state, "revoked")
  assert.equal((await f.intent(play)).grant.state, "revoked")
  assert.equal(f.admitted.length, total)
  assert.equal(f.counts.nativePrompts, 0); assert.equal(f.counts.nativeSynthetics, 0)
})

test("qualified native-default delegation declares a contract without root creation or dispatch", async t => {
  const f = fixture(); const saved = await f.seed(true)
  const dispose = await setupDurableMissionsPlugin(f.context, f.host); t.after(dispose); await f.provision()
  await f.intent(await f.body("adopt", saved.id)); await f.intent(await f.body("lifecycle", saved.id))
  const effects = f.admitted.length
  const result = await f.tool("delegate", { missionID: saved.id, taskKey: "native-first", title: "Native work", brief: "Bounded contract", role: "worker" })
  assert.equal(result.disposition, "declared")
  assert.deepEqual(result.contract, { missionID: saved.id, taskKey: "native-first", generation: 1 })
  assert.deepEqual(result.mission.tasks[0].executionMode, { kind: "native", parentTaskKey: null })
  assert.equal(result.mission.tasks[0].actorSessionId, undefined)
  assert.equal(result.mission.actors.length, 1)
  assert.equal(f.admitted.length, effects)
  assert.equal(f.counts.nativeCreates, 0)
  assert.equal(f.counts.nativePrompts, 0)
  assert.equal(f.counts.nativeSynthetics, 0)
  await f.intent(await f.body("revoke", saved.id))
  await assert.rejects(f.tool("delegate", { missionID: saved.id, taskKey: "native-late", title: "Late", brief: "No send", role: "worker" }), /authorization-blocked/)
})

test("signed update/recover/pause/Stop/delete use typed native business effects; cleanup/new actors stay explicitly gated", async t => {
  const f = fixture(); const saved = await f.seed(true)
  const dispose = await setupDurableMissionsPlugin(f.context, f.host); t.after(dispose); await f.provision()
  await f.intent(await f.body("adopt", saved.id)); await f.intent(await f.body("lifecycle", saved.id))
  const updated = await f.intent(await f.body("update", saved.id))
  assert.ok(updated.receipt.completion.result.revision > saved.revision)
  const recovered = await f.intent(await f.body("recover", saved.id))
  assert.match(recovered.receipt.completion.result.admissionID, /^msg_/)
  assert.equal(f.admitted.at(-1)?.kind, "synthetic")
  await assert.rejects(f.tool("delegate", { ...independent, missionID: saved.id, taskKey: "new-root", title: "New", brief: "New", role: "worker" }), /policy-unqualified/)
  const paused = await f.intent(await f.body("lifecycle", saved.id, { payload: { action: "pause" } }))
  assert.equal(paused.grant.sendsEnabled, false)
  await f.intent(await f.body("lifecycle", saved.id))
  const stopped = await f.intent(await f.body("lifecycle", saved.id, { payload: { action: "stop" } }))
  assert.equal(stopped.grant.state, "revoked")
  const before = await f.journal.events()
  await assert.rejects(f.intent(await f.body("delete", saved.id, { payload: { deleteManagedSessions: true } })), (error: any) => error.code === "policy-unqualified")
  assert.deepEqual(await f.journal.events(), before)
  const deleted = await f.intent(await f.body("delete", saved.id))
  assert.equal(deleted.receipt.completion.result.deleted, true)
  assert.equal((await f.journal.snapshot()).missions.length, 0)
})

test("backend/trust loss preserves report evidence; all final native boundaries check current authority", async t => {
  const f = fixture(); const saved = await f.seed(true)
  const dispose = await setupDurableMissionsPlugin(f.context, f.host); t.after(dispose); await f.provision()
  await f.intent(await f.body("adopt", saved.id)); await f.intent(await f.body("lifecycle", saved.id))
  f.prepareWith(async () => { f.loseTrust() })
  await assert.rejects(f.tool("delegate", { ...independent, missionID: saved.id, taskKey: "held", title: "Held", brief: "Prepared", role: "worker", targetSessionID: "ses_actor" }), /untrusted-signer/)
  assert.equal(f.admitted.length, 1)
  const reported = await f.tool("report", { missionID: saved.id, taskKey: "held", outcome: "completed", summary: "Save ambiguous evidence", evidence: ["real"] }, "ses_actor")
  assert.equal(reported.mission.reports[0].notificationStatus, "pending")
  assert.equal(f.admitted.length, 1)
  assert.equal(f.counts.nativePrompts, 0); assert.equal(f.counts.nativeSynthetics, 0)
  f.unmanage()
  const replay = await f.tool("report", { missionID: saved.id, taskKey: "held", outcome: "completed", summary: "Already saved" }, "ses_actor")
  assert.equal(replay.disposition, "existing")
  assert.equal(replay.mission.reports[0].summary, "Save ambiguous evidence")
})

test("captured native tools/RPCs refuse after unload and all registrations dispose", async () => {
  const f = fixture(); const saved = await f.seed(false, true)
  const dispose = await setupDurableMissionsPlugin(f.context)
  const captured = f.tools.get("report")!
  const handler = f.rpcs.get(CODENOMAD_MISSIONS_AUTHORITY_RPC.id)!.handlers.challenge
  await dispose()
  await assert.rejects(captured.execute({ missionID: saved.id, taskKey: "task-one", outcome: "completed", summary: "Captured" },
    { sessionID: "ses_actor", messageID: "msg_captured", id: "call_captured", progress: async () => {} }), /no longer available/)
  await assert.rejects(handler({ nonce: "bounded-nonce-123456" }, {}), /authorization-blocked/)
  assert.equal(f.counts.disposed, 4)
  assert.equal((await f.journal.snapshot()).missions[0].reports.length, 0)
})

test("owned-root checks veto foreign delegation before journal writes; authorized revision/finalization use real controls", async t => {
  const f = fixture(); const saved = await f.seed(true)
  const dispose = await setupDurableMissionsPlugin(f.context, f.host); t.after(dispose); await f.provision()
  await f.intent(await f.body("adopt", saved.id)); await f.intent(await f.body("lifecycle", saved.id))
  f.sessions.set("ses_foreign", { id: "ses_foreign", projectID: f.location.project.id, location: { directory: "/foreign/root" } })
  const before = await f.journal.events()
  await assert.rejects(f.tool("delegate", { ...independent, missionID: saved.id, taskKey: "foreign-task", title: "Foreign", brief: "Foreign", role: "worker", targetSessionID: "ses_foreign" }), /binding-mismatch/)
  assert.deepEqual(await f.journal.events(), before)
  const current = (await f.journal.snapshot()).missions[0]
  const revised = await f.tool("revise", { missionID: saved.id, expectedRevision: current.revision, requestID: "authorized-revise",
    reason: "Explicit coordinator decision", objective: "Revised owned objective" })
  assert.equal(revised.mission.objective, "Revised owned objective")
  const finished = await f.tool("report", { missionID: saved.id, final: true, outcome: "failed", summary: "Honest terminal decision" })
  assert.equal(finished.disposition, "finished"); assert.equal(finished.mission.status, "failed")
  await assert.rejects(f.tool("delegate", { ...independent, missionID: saved.id, taskKey: "late-task", title: "Late", brief: "Late", role: "worker", targetSessionID: "ses_actor" }), /authorization-blocked/)
  assert.equal(f.admitted.length, 1)
})

test("a lost managed signer during native creation preparation prevents session creation and leaves honest pending state", async t => {
  const f = fixture(); const dispose = await setupDurableMissionsPlugin(f.context, f.host); t.after(dispose); await f.provision()
  const resolve = f.host.resolveRoot
  let reads = 0
  f.host.resolveRoot = async location => {
    const value = await resolve(location)
    if (++reads === 2) f.loseTrust()
    return value
  }
  const requestID = "fenced-native-create"
  const missionID = `msn_${stableToken(`${f.location.project.id}\0${requestID}`, 24)}`
  const creation = await f.body("create", missionID, { requestID,
    coordinatorSessionID: `ses_${stableToken(`${missionID}\0coordinator`, 26)}` })
  await assert.rejects(f.intent(creation), (error: any) => error.code === "untrusted-signer")
  assert.equal(f.counts.nativeCreates, 0)
  assert.equal((await f.journal.snapshot()).missions.length, 0)
  const state = await f.invoke("state", { missionID }, CODENOMAD_MISSIONS_AUTHORITY_RPC.id)
  assert.equal(state.grant, null); assert.deepEqual(state.pendingRequestIDs, [requestID])
  await f.provision()
  assert.equal((await f.intent(creation)).receipt.completion, undefined)
  assert.equal(f.counts.nativeCreates, 0)
})

test("thenable trust approval and malformed transport ACKs never authorize or complete a native Play", async t => {
  const invalid = fixture(); const disposeInvalid = await setupDurableMissionsPlugin(invalid.context, invalid.host); t.after(disposeInvalid)
  const legacy = await invalid.seed(true); await invalid.provision()
  invalid.host.assertSignerCurrent = (() => Promise.resolve(true)) as never
  await assert.rejects(invalid.intent(await invalid.body("adopt", legacy.id)), (error: any) => error.code === "untrusted-signer")
  assert.equal((await invalid.invoke("state", { missionID: legacy.id }, CODENOMAD_MISSIONS_AUTHORITY_RPC.id)).grant, null)
  invalid.host.assertManagedIncarnation = (() => Promise.resolve(true)) as never
  await assert.rejects(invalid.intent(await invalid.body("adopt", legacy.id)), (error: any) => error.code === "policy-unqualified")
  const f = fixture(); const saved = await f.seed(true)
  const dispose = await setupDurableMissionsPlugin(f.context, f.host); t.after(dispose); await f.provision()
  await f.intent(await f.body("adopt", saved.id))
  let attempts = 0
  f.host.transport.execute = async (_request, options) => { await options.assertCurrent(); attempts++; return { admitted: false } as never }
  const play = await f.body("lifecycle", saved.id)
  await assert.rejects(f.intent(play), (error: any) => error.code === "effect-unavailable")
  const state = await f.invoke("state", { missionID: saved.id }, CODENOMAD_MISSIONS_AUTHORITY_RPC.id)
  assert.equal(state.grant.sendsEnabled, false)
  assert.equal((await f.journal.snapshot()).missions[0].control!.pending.length, 1)
  assert.equal((await f.intent(play)).receipt.completion, undefined)
  assert.equal(attempts, 1); assert.equal(f.counts.nativeSynthetics, 0)
})

test("persisted grant with an unavailable backend keeps native report/context but never uses native send fallback", async t => {
  const f = fixture(); const saved = await f.seed(true)
  const dispose = await setupDurableMissionsPlugin(f.context, f.host); t.after(dispose); await f.provision()
  await f.intent(await f.body("adopt", saved.id)); await f.intent(await f.body("lifecycle", saved.id))
  await f.tool("delegate", { ...independent, missionID: saved.id, taskKey: "already-admitted", title: "Saved", brief: "Saved", role: "worker", targetSessionID: "ses_actor" })
  f.host.transport.execute = async () => { throw new Error("private bridge secret") }
  const reported = await f.tool("report", { missionID: saved.id, taskKey: "already-admitted", outcome: "completed", summary: "Backend-independent proof", evidence: ["saved"] }, "ses_actor")
  assert.equal(reported.disposition, "reported"); assert.equal(reported.mission.reports[0].notificationStatus, "pending")
  const event = { sessionID: "ses_actor", system: [] as Array<{ type: "text"; text: string }>, tools: { mission_delegate: {} } }
  await f.hooks[0](event); assert.ok(event.system.length)
  await assert.rejects(f.tool("delegate", { ...independent, missionID: saved.id, taskKey: "pending-admission", title: "Pending", brief: "Pending", role: "worker", targetSessionID: "ses_actor" }), (error: any) => {
    assert.equal(error.code, "effect-unavailable"); assert.ok(!error.message.includes("secret")); return true
  })
  assert.equal(f.admitted.length, 2)
  assert.equal(f.counts.nativePrompts, 0); assert.equal(f.counts.nativeSynthetics, 0)
  assert.equal((await f.invoke("snapshot", {})).missions[0].reports[0].summary, "Backend-independent proof")
})

test("unreadable authority namespace has no stale fallback or automatic repair but keeps independent native evidence", async t => {
  const f = fixture(); const saved = await f.seed(false, true)
  const namespaceKey = `${MISSION_AUTHORITY_STORAGE_PREFIX}/namespace`
  f.storage.data.set(namespaceKey, "corrupt-native-UUID")
  const dispose = await setupDurableMissionsPlugin(f.context); t.after(dispose)
  assert.equal(f.tools.size, 5); assert.equal(f.counts.registrations, 2)
  assert.equal(f.storage.data.get(namespaceKey), "corrupt-native-UUID")
  await assert.rejects(f.invoke("challenge", { nonce: "bounded-nonce-123456" }, CODENOMAD_MISSIONS_AUTHORITY_RPC.id), /authorization-blocked/)
  assert.equal((await f.tool("inspect", { missionID: saved.id })).mission.id, saved.id)
  const reported = await f.tool("report", { missionID: saved.id, taskKey: "task-one", outcome: "completed", summary: "Independent native proof" }, "ses_actor")
  assert.equal(reported.disposition, "reported"); assert.equal(reported.mission.reports[0].notificationStatus, "pending")
  assert.equal(f.counts.nativeSynthetics, 0)
})
