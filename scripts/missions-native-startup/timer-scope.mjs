import assert from "node:assert/strict"
import { setTimeout as delay } from "node:timers/promises"

export const TIMER_CAPTURE_RPC = { id: "missions.fixture-timer", methods: { capture: {
  input: { type: "object", properties: { nonce: { type: "string" }, sessionID: { type: "string" }, pid: { type: "integer" } },
    required: ["nonce", "sessionID", "pid"], additionalProperties: false },
  output: { type: "object", properties: { pid: { type: "integer" }, directory: { type: "string" } },
    required: ["pid", "directory"], additionalProperties: false },
  errors: { unavailable: { type: "object", properties: {}, additionalProperties: false } },
} }, events: {} }

export async function captureTimerGraph({ client, snapshot, actor, nonce, evidence, options }) {
  evidence.timerGraphCapture = { attempts: 1, source: "authenticated-exact-owned-Location-RPC-after-proven-cold-setup",
    note: "caller-demand-capture-not-autonomous-graph-access" }
  const receipt = await client.rpc.call({ rpcID: TIMER_CAPTURE_RPC.id, method: "capture",
    location: { directory: actor.location.directory }, input: { nonce, sessionID: actor.id, pid: snapshot.pid } }, options())
  assert.deepEqual(receipt.output, { pid: snapshot.pid, directory: actor.location.directory })
  evidence.timerGraphCapture.receipt = receipt.output
}

export async function runTimerScope({ actor, idle, client, snapshot, file, claim, until, options,
  marker, guard, successful, connected, provider, evidence }) {
  const result = evidence.timerScope = { mode: "claim-cold-plugin-scoped-marker-timer",
    authority: "fixture-consent-nonce-loaded-entry-only; not-Mission-authority",
    timer: { initialDelayMs: 6000, spacingMs: 3000, maximumTicks: 3 },
    inactivityExpiry: "not-tested; native-default-60-minutes-no-config-override",
    evictionMechanism: "native-debug.location.evict-exact-directory-not-idle-timeout",
    codeNomadBackendConstructedByFixture: false, allCodeNomadProcessesClosed: null,
    graphLookup: "exact-loaded-only-lifetime-probe-control; not-Mission-cold-root-policy",
    missingEntryDenialObserved: false,
    schedulerQualified: false }
  const entries = async pid => (await marker(file)).filter(entry => entry.pid === pid)
  result.claimAtSettlement = claim(actor.id)
  assert.equal(result.claimAtSettlement.time_suspended, null)
  const settledAt = Date.now()
  const ticks = await until(async () => {
    const found = (await entries(snapshot.pid)).filter(entry => entry.kind === "timer-tick" && entry.at > settledAt)
    return found.length ? found : false
  })
  const armed = (await entries(snapshot.pid)).filter(entry => entry.kind === "timer-storage-rearmed")
  assert.equal(armed.length, 1)
  assert.ok(ticks.every(entry => entry.directory === actor.location.directory && entry.sessionID === actor.id))
  result.postTerminal = { settledAt, observedTickTimes: ticks.map(entry => entry.at),
    nativeAdmissionCount: evidence.claimResume.nativeAdmissionCount, primaryModelRequests: provider.calls.length,
    storageRearms: armed.length, shortTickLeaseAndExactRcMapTokenFence: true,
    loadedOnlyGraphCaptures: (await entries(snapshot.pid)).filter(entry => entry.kind === "timer-graph-captured").length }
  assert.equal(provider.calls.length, 2)
  await guard(snapshot)
  assert.equal(claim(actor.id).time_suspended, null)
  await client.debug.location.evict({ location: { directory: actor.location.directory } }, options())
  const evictedAt = Date.now()
  assert.ok(evictedAt < armed[0].at + 12_000, "Eviction leaves a future bounded tick to cancel")
  // No session/Location reads after eviction: only private markers and exact read-only claims.
  const finalized = await until(async () => (await entries(snapshot.pid)).find(entry => entry.kind === "timer-plugin-finalized" && entry.directory === actor.location.directory))
  await delay(Math.max(0, armed[0].at + 14_000 - Date.now()))
  const afterEviction = await entries(snapshot.pid)
  result.eviction = { evictedAt, observedThrough: Date.now(), scopeFinalized: true, scopeFinalizedAt: finalized.at,
    tickTimesBeforeResponse: afterEviction.filter(entry => entry.kind === "timer-tick" && entry.at <= evictedAt).map(entry => entry.at),
    ticksAfterResponse: afterEviction.filter(entry => entry.kind === "timer-tick" && entry.at > evictedAt).length,
    setupsAfterResponse: afterEviction.filter(entry => entry.kind === "claim-plugin-setup" && entry.at > evictedAt).length,
    claim: claim(actor.id) }
  assert.equal(result.eviction.ticksAfterResponse, 0)
  assert.equal(result.eviction.setupsAfterResponse, 0)
  assert.equal(result.eviction.claim.time_suspended, null)
  assert.equal(claim(idle.id).time_suspended, null)
  await guard(snapshot)
  await successful(["service", "restart"])
  const third = await connected()
  assert.notEqual(third.snapshot.id, snapshot.id)
  assert.notEqual(third.snapshot.pid, snapshot.pid)
  // Storage enrollment remains native, but there is no outstanding execution claim.
  await delay(8_000)
  const cold = await entries(third.snapshot.pid)
  result.noClaimColdBoot = { service: third.snapshot, observationMs: 8000, scope: "observed-window-only-not-permanent-absence",
    moduleEvaluations: cold.filter(entry => entry.kind.endsWith("-plugin-module")).map(entry => ({ kind: entry.kind, at: entry.at,
      pid: entry.pid, moduleURL: entry.moduleURL, moduleSHA256: entry.moduleSHA256, sourceFingerprintSHA256: entry.sourceFingerprintSHA256 })),
    pluginSetups: cold.filter(entry => entry.kind === "claim-plugin-setup").length,
    timerRearms: cold.filter(entry => entry.kind === "timer-storage-rearmed").length,
    ticks: cold.filter(entry => entry.kind === "timer-tick").length,
    primaryModelRequests: provider.calls.length, claim: claim(actor.id) }
  assert.equal(result.noClaimColdBoot.pluginSetups, 0)
  assert.equal(result.noClaimColdBoot.timerRearms, 0)
  assert.equal(result.noClaimColdBoot.ticks, 0)
  assert.equal(provider.calls.length, 2)
  assert.equal(result.noClaimColdBoot.claim.time_suspended, null)
  const claimed = evidence.claimResume.bootObservation.moduleEvaluations
  assert.equal(claimed.filter(entry => entry.kind === "timer-plugin-module").length, 1, "Real native timer-module evaluation positive control")
  assert.equal(claimed.filter(entry => entry.kind === "claim-plugin-module").length, 1, "Bundled dependency evaluation positive control")
  for (const entry of [...claimed, ...result.noClaimColdBoot.moduleEvaluations]) {
    assert.equal(entry.moduleURL, evidence.fixtureModules.entrypointURL)
    assert.equal(entry.moduleSHA256, evidence.fixtureModules.entrypointSHA256)
    assert.equal(entry.sourceFingerprintSHA256, evidence.fixtureModules.sourceFingerprintSHA256)
  }
  evidence.moduleEvaluation = { mode: "native-module-evaluation-versus-plugin-setup",
    claimedRestart: { pid: snapshot.pid, observationMs: 2000, moduleHits: claimed.length, setupHits: evidence.claimResume.bootObservation.enrolledLocationSetups },
    claimFreeRestart: { pid: third.snapshot.pid, observationMs: 8000, moduleHits: result.noClaimColdBoot.moduleEvaluations.length,
      setupHits: result.noClaimColdBoot.pluginSetups, postBootLocationDemand: false },
    outcome: result.noClaimColdBoot.moduleEvaluations.length ? "claim-free-module-evaluation-observed-not-owner-qualified"
      : "claim-free-module-evaluation-unobserved-in-eight-second-window",
    scope: "one-installed-2.0.24-artifact-bounded-window; not-impossibility-or-scheduling-proof" }
  result.finalCounts = { nativeAdmissionCount: evidence.claimResume.nativeAdmissionCount,
    toolExecutorEntries: (await marker(file)).filter(entry => entry.kind === "claim-tool-enter").length,
    primaryModelRequests: provider.calls.length }
  assert.deepEqual(result.finalCounts, { nativeAdmissionCount: 1, toolExecutorEntries: 1, primaryModelRequests: 2 })
  result.outcome = "post-terminal-plugin-tick-proved-eviction-stops-timer-no-claim-cold-rearm-unobserved"
  evidence.outcome = result.outcome
  evidence.managedQualification = "bounded-plugin-timer-lifecycle-only-not-native-autonomy"
}
