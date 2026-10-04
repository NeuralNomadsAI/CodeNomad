import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import { run, call, childCall } from "./harness.mjs"
import { backendServer } from "./backend.mjs"
import { writeEnvironmentProbe, retainBackend, retainedWrite, recordProcessComparison, captureSourceHashes } from "./environment-evidence.mjs"

await run("real-child-environment-write-crash", async h => {
  h.result.allBackendTraces = []
  h.result.environmentEvidenceRevision = { version: 2, sourceHashes: await captureSourceHashes(), historicalArtifactsNotRetrofitted: true }
  await writeEnvironmentProbe(h.project)
  const file = `${h.root}/profile-crash.json`; await writeFile(file, JSON.stringify({ environmentVariables: { QUAL_PROFILE: "CRASH_PROFILE", QUAL_COMPLEX_VALUE: "private synthetic α | spaces = line\nnext" } }))
  for (const [name, background, settlement] of [["fg_write_settlement", false, true], ["bg_after_env_receipt", true, false]]) {
    h.backend = await backendServer(h)
    const rootID = await h.parent(name); h.backend.profiles.set(rootID, file); await h.backend.applyRoot(rootID)
    await h.control(rootID, "running", { explicitEnvironment: true, fault: settlement ? "none" : "after-admission" })
    if (settlement) h.backend.faults.set(rootID, "write-settlement")
    h.provider.childPlans.set(name, { answers: ["ORIGINAL_ENV_ASSIGNMENT"] })
    await h.submit(rootID, [childCall(name, { background })])
    const binding = await h.binding(name)
    await h.until(async () => settlement ? h.backend.settlementHolds.has(binding.childID) : (await readFile(`${h.root}/hooks.jsonl`, "utf8")).split("\n").filter(Boolean).map(JSON.parse).some(record => record.kind === "fault-held" && record.callID === name), "real environment crash boundary " + name)
    assert.equal(h.requests(binding.childID).length, 0)
    const actualWrites = h.backend.trace.filter(record => record.childID === binding.childID && record.operation === "environment-written")
    assert.equal(actualWrites.length, 1)
    retainBackend(h, h.backend, "original-before-daemon-replacement")
    await h.restart(false)
    await h.backend.close()
    const originalWrite = retainedWrite(h.result.allBackendTraces, binding)
    assert.equal(originalWrite.dispatchID, actualWrites[0].dispatchID)
    await h.running.client.session.shell({ sessionID: binding.childID, command: `node probe.cjs ${name}-restart.json` }, h.options())
    const afterRestart = JSON.parse(await readFile(`${h.project}/${name}-restart.json`, "utf8"))
    h.observe("actual environment API write survives private crash? " + name, afterRestart.marker === "CRASH_PROFILE" && !afterRestart.db && !afterRestart.password ? "SUPPORTED" : "OBSERVED_LIMIT", { binding, settlementBeforeReceipt: settlement, actualWriteCount: actualWrites.length, providerBeforeCrash: 0, afterRestart, originalWrite })
    const providerBeforeWake = h.requests(binding.childID).length
    await h.running.client.session.synthetic({ sessionID: binding.childID, text: "PRIVATE_RESTART_LATE_NATIVE_WAKE", resume: true }, h.options()); await h.wait(binding.childID)
    assert.equal(h.requests(binding.childID).length, providerBeforeWake)
    h.observe("native wake cannot consume stale persisted environment receipt " + name, "WORKAROUND_TESTED", { childID: binding.childID, providerRequests: 0, runtimeLifetimeFence: true, notNativeAttestation: true })
    h.backend = await backendServer(h); h.backend.profiles.set(rootID, file); await h.backend.applyRoot(rootID)
    await h.control(rootID, "running", { explicitEnvironment: true, fault: "none" })
    const continuedCall = name + "_continue"
    h.provider.childPlans.set(continuedCall, { answers: [call("shell", { command: `node probe.cjs ${continuedCall}.json` }, "probe_" + continuedCall)] })
    await h.submit(rootID, [childCall(continuedCall, { sessionID: binding.childID })], "Explicit continuation with fresh environment; never replay original assignment")
    await h.wait(rootID)
    const continued = await h.binding(continuedCall)
    assert.equal(continued.childID, binding.childID)
    // Assert foreground and background readmissions are retained BEFORE cleanup,
    // while this exact backend is still referenced, then compare its own input.
    retainBackend(h, h.backend, "continuation-before-cleanup")
    const sourceWrite = retainedWrite(h.result.allBackendTraces, continued)
    assert.equal(sourceWrite.backendID, h.backend.backendID)
    assert.equal(sourceWrite.backendGeneration, h.backend.backendGeneration)
    assert.notEqual(sourceWrite.backendID, originalWrite.backendID)
    const comparison = await recordProcessComparison(h, continued, continuedCall, sourceWrite)
    const measured = comparison.tool
    assert.equal(measured.marker, "CRASH_PROFILE"); assert.equal(measured.db, false); assert.equal(measured.password, false); assert.equal(measured.state, false)
    assert.equal(h.events.filter(event => event.type === "session.created" && event.data.parentID === rootID).length, 1)
    h.observe("fresh owned pre-provider environment re-admission on explicit same-child continuation " + name, "WORKAROUND_TESTED", { rootID, childID: binding.childID, measured, comparison, sourceWrite, duplicateBirths: 0, originalAssignmentReplayed: false, environmentWritesNewAdmission: h.backend.trace.filter(record => record.operation === "environment-written").length })
    await h.backend.close()
    assert.equal(retainedWrite(h.result.allBackendTraces, continued).dispatchID, sourceWrite.dispatchID)
  }
  h.result.environmentEvidenceRevision.sourceHashesAfter = await captureSourceHashes()
  assert.deepEqual(h.result.environmentEvidenceRevision.sourceHashesAfter, h.result.environmentEvidenceRevision.sourceHashes)
})
