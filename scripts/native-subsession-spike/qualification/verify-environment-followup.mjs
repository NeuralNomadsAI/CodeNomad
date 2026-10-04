// Offline verification of the two NEW real runs. Never launches native processes.
import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { hashes } from "./harness.mjs"
import { retainedWrite, EXPECTED_ABSENT, compareEnvironment } from "./environment-evidence.mjs"
const sha = value => createHash("sha256").update(value).digest("hex")
const aggregate = JSON.parse(await readFile(new URL("./ENV_FOLLOWUP_RESULTS.json", import.meta.url), "utf8"))
assert.equal(aggregate.runs.length, 2, "Exactly the two newly authorized native runs")
const summary = { scope: "COMPLETE_INPUT_DISPATCH_VERIFIED; configured-variable equivalence; full process equality explicitly false", runs: [], inputTiming: [], fullProcessComparisons: [], historicalAggregateSHA256: aggregate.historicalAggregateSHA256 }
for (const run of aggregate.runs) {
  const bytes = await readFile(`${run.root}/results.json`); assert.equal(sha(bytes), run.resultSHA256)
  const result = JSON.parse(bytes), requests = JSON.parse(await readFile(`${run.root}/requests.json`, "utf8"))
  assert.equal(result.status, "completed-experiments"); assert.equal(result.hashesUnchanged, true)
  assert.deepEqual(result.environmentEvidenceRevision.sourceHashes, result.environmentEvidenceRevision.sourceHashesAfter)
  if (result.daemonStartupFingerprint) {
    const startup = result.daemonStartupFingerprint
    assert.deepEqual(startup.keys.filter(item => /api[_-]?key|token|secret|password|credential|authorization/i.test(item.key)).map(item => item.key), ["OPENCODE_SERVER_PASSWORD"], "Only private harness password remains among credential-named startup keys")
    summary.baseEnvironmentComparisons = result.environmentComparisons.map(record => {
      const comparison = compareEnvironment(startup, record.sourceFingerprint)
      assert.deepEqual(comparison.missing, ["OPENCODE_DB", "OPENCODE_SERVER_PASSWORD", "XDG_STATE_HOME"])
      assert.deepEqual(comparison.mismatched, [], "Every retained base variable has the same exact value hash")
      assert.deepEqual(comparison.extra, record.profileFingerprint.keys.map(item => item.key))
      return { label: record.label, startupKeyCount: startup.keyCount, startupSHA256: startup.canonicalSHA256, retainedBaseKeys: startup.keyCount - comparison.missing.length, comparison }
    })
  }
  for (const record of result.environmentComparisons) {
    assert(record.completeInputDispatchVerified && record.inputToProfile.sourceAllKeysEquivalent)
    assert(record.configuredTool.sourceAllKeysEquivalent && record.configuredAPI.sourceAllKeysEquivalent)
    assert(record.settingsReadsAfter > record.settingsReadsBefore)
    const provider = requests[record.firstProvider.index]
    assert.equal(provider.sessionID, record.binding.childID); assert.equal(provider.time, record.firstProvider.time)
    assert(record.sourceBuiltAt <= record.dispatchAt && record.dispatchAt <= record.writtenAt && record.writtenAt <= provider.time)
    if (record.binding.parentID) {
      const source = retainedWrite(result.allBackendTraces, record.binding)
      assert.equal(source.sourceFingerprint.canonicalSHA256, record.sourceFingerprint.canonicalSHA256)
      assert.equal(source.backendID, record.backendID); assert.equal(source.generation, record.binding.generation)
    }
    assert.deepEqual(record.toolVsSource.missing, []); assert.deepEqual(record.apiVsSource.missing, [])
    assert.deepEqual(record.toolVsSource.mismatched, ["PSMODULEPATH"]); assert.deepEqual(record.apiVsSource.mismatched, ["PSMODULEPATH"])
    assert.deepEqual(record.toolVsSource.extra, ["OPENCODE_SESSION_ID", "OPENCODE_TERMINAL"])
    assert.deepEqual(record.apiVsSource.extra, ["OPENCODE_TERMINAL"])
    assert.deepEqual(record.toolVsAPI.missing, ["OPENCODE_SESSION_ID"]); assert.deepEqual(record.toolVsAPI.extra, []); assert.deepEqual(record.toolVsAPI.mismatched, [])
    for (const probe of [record.tool, record.sessionShell]) {
      assert.equal(probe.env.keys.find(key => key.key === "OPENCODE_TERMINAL").valueSHA256, sha("1"))
      for (const key of EXPECTED_ABSENT) assert(probe.absent.find(item => item.key === key)?.absent)
    }
    assert.equal(record.tool.env.keys.find(key => key.key === "OPENCODE_SESSION_ID").valueSHA256, sha(record.binding.childID))
    assert.equal(record.toolVsSource.fullProcessEnvironmentEqual, false); assert.equal(record.apiVsSource.fullProcessEnvironmentEqual, false); assert.equal(record.toolVsAPI.fullProcessEnvironmentEqual, false)
    summary.inputTiming.push({ label: record.label, callID: record.binding.callID, childID: record.binding.childID, sourceMessageID: record.binding.messageID, toolMessageID: record.toolMessageID, apiMessageID: record.apiMessageID,
      backendID: record.backendID, backendGeneration: record.backendGeneration, generation: record.binding.generation ?? null, sourceReadOrdinal: record.sourceReadOrdinal,
      inputCount: record.sourceFingerprint.keyCount, inputSHA256: record.sourceFingerprint.canonicalSHA256, dispatchAt: record.dispatchAt, writtenAt: record.writtenAt, providerIndex: provider.index, providerAt: provider.time })
    summary.fullProcessComparisons.push({ label: record.label, inputCount: record.sourceFingerprint.keyCount, inputSHA256: record.sourceFingerprint.canonicalSHA256,
      toolCount: record.tool.env.keyCount, toolSHA256: record.tool.env.canonicalSHA256, apiCount: record.sessionShell.env.keyCount, apiSHA256: record.sessionShell.env.canonicalSHA256,
      toolVsSource: record.toolVsSource, apiVsSource: record.apiVsSource, toolVsAPI: record.toolVsAPI, protectedAbsentCountPerProbe: EXPECTED_ABSENT.length, configuredKeysEquivalent: true, nativeTerminalAndSessionIDHashesVerified: true })
  }
  if (result.phase === "real-child-environment-write-crash") {
    assert.equal(new Set(result.allBackendTraces.map(frame => frame.backendID)).size, 4)
    for (const name of ["fg_write_settlement_continue", "bg_after_env_receipt_continue"]) {
      const record = result.environmentComparisons.find(record => record.label === name)
      const beforeCleanup = result.allBackendTraces.find(frame => frame.backendID === record.backendID && frame.checkpoint === "continuation-before-cleanup")
      assert(beforeCleanup && retainedWrite([beforeCleanup], record.binding))
      assert(result.allBackendTraces.some(frame => frame.backendID === record.backendID && frame.checkpoint === "after-close"))
    }
    assert(result.matrix.filter(item => item.test.startsWith("native wake cannot consume stale")).every(item => item.providerRequests === 0))
  }
  summary.runs.push({ root: run.root, counts: result.counts, comparisons: result.environmentComparisons.length, immutableBackendFrames: result.allBackendTraces.length, sourceHashesAtExecution: result.environmentEvidenceRevision.sourceHashes })
}
summary.counts = { newNativeRuns: 2, providerRequests: summary.runs.reduce((sum, run) => sum + run.counts.providerRequests, 0), safeToolApiPairs: summary.fullProcessComparisons.length, fullEnvironmentEqualityPairs: 0 }
summary.currentFrozenHashes = await hashes()
assert.equal(summary.currentFrozenHashes.primary.baselineDifferences.length, 0); assert.equal(summary.currentFrozenHashes.experimentCommon.baselineDifferences.length, 0)
assert.equal(sha(await readFile(new URL("./RESULTS.json", import.meta.url))), aggregate.historicalAggregateSHA256)
await writeFile(new URL("./ENV_FOLLOWUP_VERIFICATION.json", import.meta.url), JSON.stringify(summary, null, 2))
console.log(JSON.stringify({ counts: summary.counts, inputTiming: summary.inputTiming, frozen: summary.currentFrozenHashes, scope: summary.scope }, null, 2))
