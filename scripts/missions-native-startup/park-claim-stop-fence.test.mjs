// Real fence/functions/Effect, synthetic observations and fake Jobs ONLY. Zero native owner/authority proof.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Cause, Context, Effect, Exit, Option } from 'effect'
import { adoptParkJob, finiteParkWait } from './park-claim-job.mjs'
import { acquireGate, bindingHash, bindGeneration, decodeBinding, guarded, readStop, reserveStop, writeStopIntent } from './park-claim-stop-fence.mjs'

const root = mkdtempSync('C:/Users/Admin/AppData/Local/Temp/opencode/park-retire-check-')
mkdirSync(path.join(root, 'markers'))
const nonce = '00000000-0000-4000-8000-000000000003', sessionID = 'fixture-root', createdAt = Date.now()
const directory = path.join(root, 'project'), inputID = `msg_park_${nonce.replaceAll('-', '')}`
const binding = decodeBinding({ version: 1, nonce, root, directory, sessionID, inputID,
  pendingID: `finite_watch_${nonce.replaceAll('-', '')}`, permissionID: 'injected-permission',
  createdAt, deadlineAt: createdAt + 120_000, claimAt: createdAt + 1, inputHash: 'a'.repeat(64),
  dbPath: path.join(root, 'fixture.db'), dbIdentity: 'b'.repeat(64), executable: path.join(root, 'not-a-native-executable'),
  executableIdentity: 'c'.repeat(64), projectID: 'injected-project', workspaceID: null, generation: 1,
  hostPID: process.pid, jobID: `job_missions_fixture_${nonce.replaceAll('-', '')}_shutdown` })
const enrollment = { root, nonce, directory, sessionID, inputID, promptHash: 'd'.repeat(64),
  permission: { id: binding.permissionID, effect: 'allow' },
  watch: { pendingID: binding.pendingID, createdAt, deadlineAt: binding.deadlineAt,
    intent: 'one finite authorized watch; park twice; no passage completion' } }
writeFileSync(path.join(root, 'claim-enrollment.json'), JSON.stringify(enrollment))
Object.assign(process.env, { NATIVE_STARTUP_ROOT: root, NATIVE_STARTUP_NONCE: nonce,
  NATIVE_STARTUP_PERSISTED_NONCE: nonce, NATIVE_STARTUP_MARKER: path.join(root, 'markers/check.jsonl') })
const originTag = Context.Service('fixture/Origin'), jobsTag = Context.Service('@opencode/Job')
const calls = [], infos = new Map()
const jobs = {
  get: id => Effect.sync(() => { calls.push(['get', id]); return infos.get(id) }),
  start: input => Effect.gen(function* () {
    assert.equal((yield* Effect.context()).mapUnsafe.size, 0)
    assert.equal(Option.isNone(yield* Effect.serviceOption(originTag)), true)
    calls.push(['start', input.id])
    const info = { id: input.id, type: input.type, status: 'running' }
    infos.set(input.id, info)
    return info // Never forks the native Job run; this is an explicit fake ACK.
  }),
  cancel: () => Effect.die(new Error('No cancellation authority in this candidate')),
  wait: () => Effect.die(new Error('No native wait in this logic check')),
}
const ctx = { location: { directory }, session: { get: () => Effect.succeed({ id: sessionID,
  parentID: undefined, agent: 'build', location: { directory } }) } }
const input = { nonce, sessionID, pid: process.pid, phase: 'shutdown' }
const admit = observe => adoptParkJob(ctx, input, -1, { isClosed: () => false }, observe)
  .pipe(Effect.provideService(jobsTag, jobs), Effect.provideService(originTag, { label: 'caller-only' }))
const refused = async effect => assert.equal(Exit.isFailure(await Effect.runPromiseExit(effect)), true)
const started = () => calls.filter(call => call[0] === 'start').length
await refused(admit(() => undefined))
assert.equal(started(), 0) // Missing promoted native binding is not a logical-watch fallback.
assert.equal(bindGeneration(binding).stopped, false)
assert.throws(() => bindGeneration({ ...binding, generation: 2, hostPID: process.pid + 1 }),
  error => error.code === 'ENOENT') // No original ACK: cold reconstruction stays closed.
await Effect.runPromise(admit(() => binding))
assert.equal(started(), 1)
assert.equal(bindingHash(JSON.parse(readFileSync(path.join(root, 'park-stop-original.json'), 'utf8'))), bindingHash(binding))
infos.clear() // Even an absent fake registry cannot replay the charged original generation.
await refused(admit(() => binding))
assert.equal(started(), 1)
const release = acquireGate(binding)
assert.throws(() => acquireGate(binding), error => error.code === 'EEXIST')
release() // Only this acquired token can release; no stealing/retry of another writer.

const requestID = 'fixture-human-stop-original-watch'
writeStopIntent(binding, requestID)
await refused(guarded(binding, 'expiry', Effect.sync(() => { throw new Error('Intent must block expiry before reservation') })))
await refused(guarded(binding, 'adopt', Effect.sync(() => calls.push(['should-not-start']))))
assert.equal(calls.some(call => call[0] === 'should-not-start'), false)
assert.throws(() => bindGeneration(decodeBinding({ ...binding, generation: 2, hostPID: process.pid + 1 })))
assert.equal(reserveStop(binding, requestID).admission, 'new')
const reservedBytes = readFileSync(path.join(root, 'park-stop-reservation.json'))
assert.equal(reserveStop(binding, requestID).admission, 'existing-no-replay')
assert.deepEqual(readFileSync(path.join(root, 'park-stop-reservation.json')), reservedBytes)
assert.throws(() => reserveStop(binding, 'fixture-human-stop-other-request'))
infos.clear() // Fake-only registry; never changes a native Job/claim.
await refused(admit(() => binding))
assert.equal(started(), 1)
let expiryEffects = 0
const expiry = await Effect.runPromiseExit(guarded(binding, 'expiry', Effect.sync(() => expiryEffects++)))
assert.equal(Cause.hasInterruptsOnly(expiry.cause), true)
assert.equal(expiryEffects, 0)
const cold = decodeBinding({ ...binding, generation: 2, hostPID: process.pid + 1 })
assert.equal(bindGeneration(cold).stopped, true)
await refused(guarded(cold, 'adopt', Effect.sync(() => calls.push(['cold-start']))))
assert.equal(calls.some(call => call[0] === 'cold-start'), false)
assert.equal(readStop(cold).requestID, requestID)

// Exercise the actual sleeping consumer at its already-expired ORIGINAL synthetic horizon.
// Stop must interrupt before it reaches the real native reader or publishes the expiry marker.
const dueRoot = mkdtempSync('C:/Users/Admin/AppData/Local/Temp/opencode/park-retire-check-')
mkdirSync(path.join(dueRoot, 'markers'))
const dueAt = Date.now() - 1, dueCreated = dueAt - 120_000
const dueBinding = decodeBinding({ ...binding, root: dueRoot, directory: path.join(dueRoot, 'project'),
  dbPath: path.join(dueRoot, 'fixture.db'), createdAt: dueCreated, deadlineAt: dueAt, claimAt: dueCreated + 1 })
bindGeneration(dueBinding)
writeStopIntent(dueBinding, requestID)
reserveStop(dueBinding, requestID)
process.env.NATIVE_STARTUP_ROOT = dueRoot
process.env.NATIVE_STARTUP_MARKER = path.join(dueRoot, 'markers/check.jsonl')
const dueExit = await Effect.runPromiseExit(finiteParkWait({ ...dueBinding, binding: dueBinding, callerScopeID: -1, pluginScopeID: -2 })
  .pipe(Effect.updateContext(() => Context.empty())))
assert.equal(Cause.hasInterruptsOnly(dueExit.cause), true)
assert.equal(readFileSync(process.env.NATIVE_STARTUP_MARKER, 'utf8').split('\n').filter(Boolean)
  .map(JSON.parse).some(record => record.kind === 'park-wait-expired'), false)
process.env.NATIVE_STARTUP_ROOT = root
process.env.NATIVE_STARTUP_MARKER = path.join(root, 'markers/check.jsonl')

for (const foreign of [{ ...binding, inputHash: 'e'.repeat(64) }, { ...binding, claimAt: binding.claimAt + 1 },
  { ...binding, permissionID: 'replaced-permission' }, { ...binding, nonce: 'foreign-00000001' },
  { ...binding, createdAt: createdAt + 1, deadlineAt: binding.deadlineAt + 1 }]) {
  assert.throws(() => bindGeneration(foreign))
}
assert.throws(() => decodeBinding({ ...binding, inputID: 'any-pending-input' }))
assert.throws(() => decodeBinding({ ...binding, authorized: true }))
// O_EXCL partial reservation is uncertainty, not permission to replay/re-adopt/delete the fence.
writeFileSync(path.join(root, 'park-stop-reservation.json'), '{') // Owned synthetic fixture only.
await refused(guarded(binding, 'expiry', Effect.sync(() => expiryEffects++)))
assert.throws(() => reserveStop(binding, requestID))
assert.equal(readFileSync(path.join(root, 'park-stop-reservation.json'), 'utf8'), '{')
assert.equal(expiryEffects, 0)
assert.equal(started(), 1)
console.log(JSON.stringify({ root, checks: 7, nativeOperations: 0, syntheticNativeObservations: true, fakeJobsOnly: true,
  missingBindingDenied: true, stopDeniesJobColdAndExpiry: true, uncertainSameRequestNotReplayed: true,
  foreignBindingDenied: true, emptyContextBeforeFakeStart: true, actualFiniteWaitExpiryDenied: true, nativeCancellationCalls: 0,
  nativeOwnerScopeQualified: false, nativeWriterAuthorityQualified: false, forcedResumeExposed: false }))
