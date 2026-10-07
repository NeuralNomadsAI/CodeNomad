import assert from "node:assert/strict"
import { setTimeout as delay } from "node:timers/promises"

export const WATCHER_PARK_RPC = { id: "missions.fixture-watcher", methods: { park: {
  input: { type: "object", properties: { nonce: { type: "string" }, sessionID: { type: "string" }, pid: { type: "integer" } },
    required: ["nonce", "sessionID", "pid"], additionalProperties: false },
  output: { type: "object", properties: { pid: { type: "integer" }, directory: { type: "string" } },
    required: ["pid", "directory"], additionalProperties: false },
  errors: { unavailable: { type: "object", properties: {}, additionalProperties: false } },
}, hold: {
  input: { type: "object", properties: { nonce: { type: "string" }, sessionID: { type: "string" }, pid: { type: "integer" } },
    required: ["nonce", "sessionID", "pid"], additionalProperties: false },
  output: { type: "null" }, errors: {},
} }, events: {} }

export async function runWatcherScope({ actor, idle, client, snapshot, file, claim, until, options, marker,
  guard, successful, connected, provider, evidence, nonce, entered }) {
  const result = evidence.watcher = { scope: "bounded-native-context-hook-lifetime-only-not-Mission-authority",
    hook: "existing-Effect-session.context-before-primary-dispatch", graphCaptureRPCs: 0,
    executionOwner: "awaited-native-drain; no-fork-or-escaped-Scope", retentionAPI: "LocationActivity exposes no touch/retention API",
    dueRootAcquireQualified: false, rcMapEntryTokens: "global-map-not-exposed-in-hook; root-local-RPC-shutdown-fence-only",
    nativeClaimWritesByFixture: false, allCodeNomadProcessesClosed: null,
    nativeRestartBudget: "ten-resume-budget-still-applies; no-counter-reset-or-claim-manufacture",
    automaticInactivityExpiryTested: false, productionEnabled: false, schedulerQualified: false,
    sourceContracts: { commit: evidence.claimResume.sourceCommit,
      descriptors: "packages/plugin/src/effect/registration.ts:19-27; effect/session.ts:138-171; promise/adapter.ts:579-583",
      awaitedCallback: "packages/core/src/plugin/hooks.ts:88-94; session/model-request.ts:403-408; session/runner/llm.ts:231-244",
      parentLifetime: "packages/core/src/session/execution.ts:95-104; effect/app-node-builder.ts:8-19",
      localRpcCancellation: "packages/core/src/rpc.ts:120-137; location-lifecycle.ts:42-55",
      activity: "packages/core/src/location-activity.ts:14-46,53-81; no exported touch; borrowed graph does not defeat inactivity interrupt",
      synchronousTransforms: "packages/core/src/state.ts:175-180; instructions have no async Session transform registration",
      restartBudget: "packages/core/src/session/execution/restart.ts:33,193-228" } }
  const entries = async pid => (await marker(file)).filter(entry => entry.pid === pid)
  await until(async () => (await entries(snapshot.pid)).find(entry => entry.kind === "watcher-hook-graph-unavailable"
    || entry.kind === "watcher-resume-held-before-model"))
  const observed = await entries(snapshot.pid)
  result.graphAvailability = observed.filter(entry => /^watcher-hook-(map|location|lifecycle)-/.test(entry.kind))
    .map(entry => ({ kind: entry.kind, pid: entry.pid, at: entry.at }))
  if (observed.some(entry => entry.kind === "watcher-hook-graph-unavailable")) {
    result.claimAtCallback = claim(actor.id)
    provider.release()
    await client.session.wait({ sessionID: actor.id }, options())
    assert.equal(claim(actor.id).time_suspended, null)
    result.finalCounts = { nativeAdmissionCount: evidence.claimResume.nativeAdmissionCount,
      toolExecutorEntries: (await marker(file)).filter(entry => entry.kind === "claim-tool-enter").length,
      primaryModelRequests: provider.calls.length }
    assert.deepEqual(result.finalCounts, { nativeAdmissionCount: 1, toolExecutorEntries: 1, primaryModelRequests: 2 })
    evidence.outcome = "native-context-hook-observed-required-graph-contract-missing-standing-hold-not-qualified"
    evidence.managedQualification = "exact-hook-graph-availability-only-not-autonomy"
    return
  }
  const held = async (service, expectedAttempts) => {
    const entry = await until(async () => (await entries(service.pid)).find(entry => entry.kind === "watcher-resume-held-before-model"))
    await until(async () => (await entries(service.pid)).filter(entry => entry.kind === "watcher-harmless-observation").length >= 2)
    const saved = claim(actor.id)
    assert.ok(saved.time_suspended !== null)
    assert.equal(saved.resume_attempts, expectedAttempts)
    assert.equal(claim(idle.id).time_suspended, null)
    assert.equal(provider.calls.length, 1, "No fresh model request while native callback is held")
    const all = await entries(service.pid)
    assert.equal(all.filter(entry => entry.kind === "watcher-hook-native-graph").length, 1)
    assert.equal(all.filter(entry => entry.kind === "watcher-native-drain-scope-distinct-from-plugin").length, 1)
    assert.equal(all.filter(entry => entry.kind === "claim-tool-enter").length, 0)
    assert.equal(all.filter(entry => entry.kind === "claim-plugin-setup" && entry.directory === idle.location.directory).length, 0)
    return { pid: service.pid, at: entry.at, claim: saved,
      observationCount: all.filter(entry => entry.kind === "watcher-harmless-observation").length, postBootLocationDemandBeforeHold: false }
  }
  result.firstResume = await held(snapshot, 1)
  const context = await client.session.context({ sessionID: actor.id }, options())
  assert.ok(context.length <= 30)
  const tool = context.find(message => message.id === entered.messageID)?.content?.find(part => part.type === "tool" && part.id === entered.callID)
  assert.equal(tool?.state.status, "error")
  assert.equal(tool.state.error?.type, "aborted")
  result.originalTool = { status: tool.state.status, errorType: tool.state.error.type, reentered: false }
  // Deliberate exact-root eviction must cancel effects despite the outer native borrowed lease.
  await guard(snapshot)
  await client.debug.location.evict({ location: { directory: actor.location.directory } }, options())
  const responseAt = Date.now()
  const finalized = await until(async () => (await entries(snapshot.pid)).find(entry => entry.kind === "watcher-execution-scope-finalized"))
  await until(async () => (await entries(snapshot.pid)).find(entry => entry.kind === "watcher-plugin-finalized"))
  await delay(2_500)
  const after = await entries(snapshot.pid)
  assert.ok(responseAt < result.firstResume.at + 44_000, "Eviction cancels a future scheduled harmless observation")
  assert.equal(after.filter(entry => entry.kind === "watcher-location-rpc-shutdown-cancel").length, 1)
  assert.equal(after.filter(entry => entry.kind === "watcher-harmless-observation" && entry.at > responseAt).length, 0)
  assert.equal(after.filter(entry => entry.kind === "claim-plugin-setup").length, 1, "Eviction does not auto-load another graph")
  assert.ok(claim(actor.id).time_suspended !== null, "Eviction self-interruption is native shutdown, not explicit Pause")
  result.eviction = { responseAt, executionScopeFinalizedAt: finalized.at, observedThrough: Date.now(),
    cancellation: "existing-local-RPC-shutdown-race-cancels-handler; callback-self-interrupts-native-execution",
    claimRetained: claim(actor.id), observationsBeforeResponse: after.filter(entry => entry.kind === "watcher-harmless-observation").length,
    futureObservationCancelled: true, laterObservations: 0, automaticReloads: 0 }
  await guard(snapshot)
  await successful(["service", "restart"])
  const third = await connected()
  assert.notEqual(third.snapshot.id, snapshot.id)
  assert.notEqual(third.snapshot.pid, snapshot.pid)
  result.secondResume = await held(third.snapshot, 2)
  // One explicit authenticated park write; unknown acknowledgement is never replayed.
  result.parkAttempts = 1
  const parked = await third.client.rpc.call({ rpcID: WATCHER_PARK_RPC.id, method: "park",
    location: { directory: actor.location.directory }, input: { nonce, sessionID: actor.id, pid: third.snapshot.pid } }, options())
  assert.deepEqual(parked.output, { pid: third.snapshot.pid, directory: actor.location.directory })
  result.nativeInterruptAttempts = 1
  await third.client.session.interrupt({ sessionID: actor.id, resume: false }, options())
  await third.client.session.wait({ sessionID: actor.id }, options())
  const stopped = await until(async () => (await entries(third.snapshot.pid)).find(entry => entry.kind === "watcher-hook-interrupted"))
  assert.equal(claim(actor.id).time_suspended, null)
  assert.equal(claim(actor.id).resume_attempts, 0)
  assert.equal((await entries(third.snapshot.pid)).filter(entry => entry.kind === "watcher-execution-scope-finalized").length, 1)
  result.explicitPark = { at: stopped.at, nativeClaimReleased: true, nativeResumeAttemptsReset: true,
    storedActive: false, nativeOperation: "session.interrupt(resume:false)", permissionScope: "exact-fixture-enrollment-only" }
  // Permission denial in unrelated idle session; no prompt, permission reply or inbox mutation.
  const denied = await third.client.permission.create({ sessionID: idle.id, action: "fixture_unenrolled", resources: [nonce] }, options())
  assert.equal(denied.effect, "deny")
  result.permissionIsolation = { deniedAction: "fixture_unenrolled", effect: denied.effect,
    idleClaim: claim(idle.id), idleModelRequests: provider.calls.filter(call => call.sessionID === idle.id).length,
    scope: "native-denial-and-unclaimed-idle-control; not-all-permission-inbox-preservation" }
  await guard(third.snapshot)
  await successful(["service", "restart"])
  const fourth = await connected()
  assert.notEqual(fourth.snapshot.id, third.snapshot.id)
  await delay(8_000) // No post-boot Location demand.
  const cold = await entries(fourth.snapshot.pid)
  assert.equal(cold.length, 0)
  result.parkedColdBoot = { service: fourth.snapshot, observationMs: 8000, moduleEvaluations: 0, setups: 0, callbacks: 0,
    postBootLocationDemand: false, claim: claim(actor.id), scope: "observed-window-only" }
  assert.equal(result.parkedColdBoot.claim.time_suspended, null)
  const all = await marker(file)
  result.finalCounts = { nativeAdmissionCount: evidence.claimResume.nativeAdmissionCount,
    toolExecutorEntries: all.filter(entry => entry.kind === "claim-tool-enter").length, primaryModelRequests: provider.calls.length }
  assert.deepEqual(result.finalCounts, { nativeAdmissionCount: 1, toolExecutorEntries: 1, primaryModelRequests: 1 })
  assert.equal(all.filter(entry => entry.kind === "watcher-bound-expired" || entry.kind === "claim-tool-timeout").length, 0)
  assert.equal(all.filter(entry => entry.kind === "watcher-hook-graph-unavailable").length, 0)
  assert.ok(provider.calls.every(call => call.sessionID === actor.id))
  for (const entry of all.filter(entry => entry.kind.endsWith("-plugin-module"))) {
    assert.equal(entry.execPath, evidence.artifact.privateCopy)
    assert.equal(entry.moduleURL, evidence.fixtureModules.entrypointURL)
    assert.equal(entry.moduleSHA256, evidence.fixtureModules.entrypointSHA256)
    assert.equal(entry.sourceFingerprintSHA256, evidence.fixtureModules.sourceFingerprintSHA256)
  }
  result.moduleIdentityAligned = true
  evidence.claimResume.primaryModelRequests = provider.calls.length
  evidence.claimResume.toolExecutorEntries = result.finalCounts.toolExecutorEntries
  evidence.claimResume.sameToolCallReentered = false
  evidence.claimResume.outcome = "standing-callback-qualified-separately-in-watcher-receipt"
  evidence.outcome = "native-context-hook-standing-claim-rearm-proved-before-model-eviction-and-explicit-park-cancel"
  evidence.managedQualification = "bounded-standing-execution-hook-only-not-retention-or-autonomy"
}
