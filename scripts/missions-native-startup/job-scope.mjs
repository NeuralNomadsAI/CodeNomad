import assert from "node:assert/strict"
import { appendFile, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { isAgentNotFoundError } from "@opencode/client"
import { JOB_RPC, JOB_TYPE, jobID } from "./job-contract.mjs"
import { observeOwnedExit as observePIDAbsence } from "./slow-expiry-safety.mjs"
import { exitHandleAcknowledged } from "./managed-exit-witness.mjs"

const abort = new AbortController()
export const jobProbeSignal = abort.signal
export const cancelJobProbe = () => abort.abort()
export async function runJobScope({ root, nonce, provider, evidence, guard, successful, connected, configure, marker }) {
  const result = evidence.jobScope = { scope: "actual-native-global-Job-owner-and-one-cold-root-acquire-only",
    sourceCommit: "e7a34f09bfd9134dfade5a8ddb843f7030bc9a69", sourceJobGitBlob: "771c5a79722effe0ae48d072b95c68f5f03be0ee",
    nativeAdmissionAttempts: 0, sessionPromptAdmissions: 0, modelRequests: 0, constructedNativeLayers: 0,
    originLeaseRetainedDuringWait: false, signingAndWriterAuthority: "injected-fixture-only-not-qualified",
    coldRecoveryQualified: false, genericJobsPersisted: false, schedulerQualified: false,
    automaticInactivityQualified: false, eviction: "explicit-native-exact-Location-eviction-not-automatic-idle",
    codeNomadBackendConstructed: false, allActualCodeNomadProcessesClosed: null }
  const file = path.join(root, "markers/job-adoption.jsonl")
  const controlDirectory = process.env.JOB_PROBE_CONTROL_DIRECTORY
  const launch = controlDirectory ? JSON.parse(await readFile(path.join(controlDirectory, "launch.json"), "utf8")) : undefined
  const trace = async (phase, facts = {}) => {
    result.lastStage = { phase, at: Date.now(), ...facts }
    await appendFile(path.join(root, "job-stages.jsonl"), `${JSON.stringify(result.lastStage)}\n`)
  }
  const options = () => ({ signal: AbortSignal.any([abort.signal, AbortSignal.timeout(2_000)]) })
  const until = async check => {
    const end = Date.now() + 25_000
    while (Date.now() < end) {
      abort.signal.throwIfAborted()
      assert.ok(!launch || Date.now() < launch.deadlineAt, "Absolute fixture qualification deadline")
      assert.equal(provider.failure(), undefined)
      const value = await check()
      if (value) return value
      await delay(50, undefined, { signal: abort.signal })
    }
    throw Object.assign(new Error("Bounded native Job proof timeout"), { code: "job-proof-timeout" })
  }
  for (const [key, value] of Object.entries({ NATIVE_STARTUP_MARKER: file, NATIVE_STARTUP_PHASE: "job-adoption",
    NATIVE_STARTUP_PERSISTED_NONCE: nonce })) await configure(key, value)
  await guard("stopped")
  await successful(["service", "start"])
  const { client, snapshot } = await connected()
  assert.equal(snapshot.version, "2.0.24", "Artifact qualification only; no daemon allowlist")
  result.service = snapshot
  await trace("service-started", { pid: snapshot.pid, id: snapshot.id })
  process.send?.({ kind: "job-owned-service", root, nonce, snapshot })
  const actor = await client.session.create({ title: "Global Job scope fixture", location: { directory: path.join(root, "project") } }, options())
  const control = await client.session.create({ title: "Global Job registry read control", location: { directory: path.join(root, "idle-project") } }, options())
  result.actor = { id: actor.id, location: actor.location }
  result.control = { id: control.id, location: control.location }
  await until(async () => (await client.plugin.list({ location: actor.location }, options())).data
    .some(plugin => plugin.id === "missions.native-claim-fixture" && plugin.state.status === "active"))
  await client.session.switchAgent({ sessionID: actor.id, agent: "build" }, options())
  await until(async () => {
    const selected = await client.agent.get({ agentID: "build", location: actor.location }, options())
      .catch(error => { if (isAgentNotFoundError(error)) return undefined; throw error })
    return selected?.data.permissions.findLast(rule => ["*", "fixture_hold"].includes(rule.action)
      && ["*", nonce].includes(rule.resource))?.effect === "allow"
  })
  const permission = await client.permission.create({ sessionID: actor.id, action: "fixture_hold", resources: [nonce] }, options())
  assert.equal(permission.effect, "allow")
  result.enrollment = { nativePermission: permission, fixtureConsent: "exact declared root; two finite native jobs; one marker then full shutdown" }
  await writeFile(path.join(root, "claim-enrollment.json"), JSON.stringify({ nonce, directory: actor.location.directory, sessionID: actor.id, permission }), { flag: "wx" })
  const input = phase => ({ nonce, sessionID: actor.id, pid: snapshot.pid, phase })
  const call = async (method, phase, location) => {
    await trace(`rpc-${method}-${phase}-begin`)
    const output = (await client.rpc.call({ rpcID: JOB_RPC.id, method, input: input(phase), location }, options())).output
    await trace(`rpc-${method}-${phase}-end`, { status: output.job?.status ?? output.status })
    return output
  }
  const entries = async () => (await marker(file)).filter(entry => entry.pid === snapshot.pid)
  await guard(snapshot)
  result.nativeAdmissionAttempts++ // unknown RPC ACK is charged; never retry start
  const first = result.firstAdmission = await call("start", "due", actor.location)
  assert.deepEqual(first.job, { id: jobID(nonce, "due"), type: JOB_TYPE, status: "running" })
  assert.notEqual(first.job.id, actor.id)
  assert.notEqual(first.job.id, control.id)
  const callerClosed = await until(async () => (await entries()).find(entry => entry.kind === "job-caller-finalized" && entry.jobID === first.job.id))
  const runStarted = await until(async () => (await entries()).find(entry => entry.kind === "job-run-start" && entry.jobID === first.job.id))
  assert.equal(callerClosed.facts.callerScopeID, first.ids.callerScopeID)
  assert.notEqual(runStarted.facts.runScopeID, first.ids.callerScopeID)
  assert.notEqual(runStarted.facts.runScopeID, first.ids.pluginScopeID)
  result.beforeEviction = { callerClosed, runStarted, registry: await call("inspect", "due", control.location) }
  assert.equal(result.beforeEviction.registry.status, "running")
  await guard(snapshot)
  await client.debug.location.evict({ location: actor.location }, options())
  const evictedAt = Date.now()
  const originClosed = await until(async () => (await entries()).find(entry => entry.kind === "job-plugin-finalized"
    && entry.directory === actor.location.directory && entry.facts.pluginScopeID === first.ids.pluginScopeID))
  assert.equal(originClosed.facts.originLifecycleClosed, true)
  assert.equal(originClosed.facts.entryScopeState, "Closed")
  const postEviction = await entries()
  assert.equal(postEviction.filter(entry => entry.kind === "job-due-marker").length, 0)
  assert.equal(postEviction.filter(entry => entry.kind === "job-run-finalized").length, 0)
  result.afterEviction = { evictedAt, originClosed, registry: await call("inspect", "due", control.location),
    originalLocationDemandByControllerUntilDue: false }
  assert.equal(result.afterEviction.registry.status, "running")
  const due = await until(async () => {
    const seen = await entries()
    const failed = seen.find(entry => entry.kind === "job-run-finalized" && entry.jobID === first.job.id && entry.facts.exit === "error")
    if (failed) {
      result.dueFailure = { finalizer: failed, registry: await call("inspect", "due", control.location) }
      throw Object.assign(new Error("Native Job due effect failed"), { code: "native-job-due-effect-failed" })
    }
    return seen.find(entry => entry.kind === "job-due-marker")
  })
  const acquired = (await entries()).find(entry => entry.kind === "job-fresh-acquire")
  assert.ok(acquired && acquired.at >= evictedAt && acquired.at <= due.at)
  assert.ok(due.at >= runStarted.at + 20_000)
  assert.notEqual(acquired.facts.entryTokenID, first.ids.oldEntryTokenID)
  assert.notEqual(acquired.facts.entryScopeID, first.ids.oldEntryScopeID)
  assert.notEqual(acquired.facts.originLifecycleID, first.ids.originLifecycleID)
  result.due = { acquired, marker: due, registry: await call("wait", "due", control.location) }
  assert.equal(result.due.registry.status, "completed")
  assert.equal(result.due.registry.output, "one-owned-nonce-marker")
  assert.equal(provider.calls.length, 0)
  await guard(snapshot)
  result.nativeAdmissionAttempts++
  const second = result.secondAdmission = await call("start", "shutdown", actor.location)
  assert.deepEqual(second.job, { id: jobID(nonce, "shutdown"), type: JOB_TYPE, status: "running" })
  const secondStart = await until(async () => (await entries()).find(entry => entry.kind === "job-run-start" && entry.jobID === second.job.id))
  assert.equal((await call("inspect", "shutdown", control.location)).status, "running")
  await guard(snapshot)
  await trace("native-service-stop-begin", { pid: snapshot.pid, id: snapshot.id })
  await successful(["service", "stop"])
  await trace("native-service-stop-returned")
  result.servicePIDAbsenceObservation = { pid: snapshot.pid, absent: await observePIDAbsence(snapshot.pid),
    at: Date.now(), kind: "pid-absence-only-not-exit-ACK" }
  // Cleanup evidence must survive EVERY subsequent qualification assertion failure.
  const handle = evidence.managedExitWitnesses?.at(-1)
  assert.ok(handle?.operation === "stop" && exitHandleAcknowledged(handle, nonce), "Managed same-handle exit ACK required")
  assert.deepEqual(handle.requestedFor, snapshot)
  result.serviceExitReceipt = handle
  await trace("owned-service-exit-handle-acknowledged", { pid: snapshot.pid })
  await guard("stopped")
  const finished = await entries()
  const cancelled = finished.find(entry => entry.kind === "job-run-finalized" && entry.jobID === second.job.id)
  result.shutdownObservation = { jobID: second.job.id, finalizer: cancelled ?? null,
    nativeProcessExitHandleAcknowledged: true, exactJobScopeCancellationObserved: cancelled?.facts.exit === "cancelled" }
  assert.ok(cancelled, "Native service process termination is not a Job Scope cancellation ACK")
  assert.equal(cancelled.facts.exit, "cancelled")
  assert.ok(cancelled.at < secondStart.at + 90_000)
  result.fullServiceShutdown = { requestedFor: snapshot, nativeProcessExitHandleAcknowledged: true, nativeStoppedGuardVerified: true,
    cancelledRun: cancelled, registryStatusAfterShutdown: null,
    note: "actual native run-Scope cancellation; dead registry not queried or assigned a fabricated Job.get status" }
  result.counts = { nativeJobStarts: result.nativeAdmissionAttempts,
    freshAcquires: finished.filter(entry => entry.kind === "job-fresh-acquire").length,
    dueMarkers: finished.filter(entry => entry.kind === "job-due-marker").length,
    cancelledJobRuns: finished.filter(entry => entry.kind === "job-run-finalized" && entry.facts.exit === "cancelled").length,
    sessionPromptAdmissions: 0, modelRequests: provider.calls.length }
  assert.deepEqual(result.counts, { nativeJobStarts: 2, freshAcquires: 1, dueMarkers: 1, cancelledJobRuns: 1, sessionPromptAdmissions: 0, modelRequests: 0 })
  evidence.outcome = "native-global-Job-survives-caller-and-origin-eviction-one-fresh-root-acquire-full-service-shutdown-cancels"
  evidence.managedQualification = "native-global-owner-process-lifetime-only-not-cold-recovery-or-Mission-authority"
}
