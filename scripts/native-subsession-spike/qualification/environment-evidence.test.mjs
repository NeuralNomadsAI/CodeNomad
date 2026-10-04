import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { fingerprintEnvironment, compareEnvironment, retainBackend, retainedWrite } from "./environment-evidence.mjs"

const oldPath = "C:/Users/Admin/AppData/Local/Temp/opencode/missions-child-environment-8LpPg8/results.json"
const oldBytes = await readFile(oldPath), old = JSON.parse(oldBytes)
const oldBinding = old.storage.bindings.find(record => record.value.callID === "fg_write_settlement_continue").value
assert.throws(() => retainedWrite(old.allBackendTraces, oldBinding), /Missing\/duplicate exact retained environment write/)
console.log("EXPECTED_FAILED_BEFORE actual preserved foreground readmission missing from old allBackendTraces")
const h = { result: { phase: "offline-retention-regression" } }, backend = { backendID: "owned-backend-2", backendGeneration: 2, trace: [{ ...oldBinding, operation: "environment-written", dispatchID: "owned-backend-2:source-2" }] }
retainBackend(h, backend, "before-close")
backend.trace.push({ operation: "close" }); retainBackend(h, backend, "after-close")
assert.equal(retainedWrite(h.result.allBackendTraces, oldBinding).dispatchID, "owned-backend-2:source-2")
assert.equal(h.result.allBackendTraces[0].trace.length, 1, "Earlier frame must be an immutable snapshot")
assert.throws(() => retainedWrite(h.result.allBackendTraces, { ...oldBinding, messageID: "foreign" }))
const a = fingerprintEnvironment({ Path: "same", QUAL_PROFILE: "private α\nnext" }), b = fingerprintEnvironment({ PATH: "same", qual_profile: "private α\nnext" })
assert(compareEnvironment(a, b).fullProcessEnvironmentEqual)
assert.throws(() => fingerprintEnvironment({ Path: "a", PATH: "b" }), /Conflicting Windows environment aliases/)
const c = fingerprintEnvironment({ PATH: "changed", EXTRA: "private" })
const diff = compareEnvironment(a, c)
assert.deepEqual(diff.missing, ["QUAL_PROFILE"]); assert.deepEqual(diff.extra, ["EXTRA"]); assert.deepEqual(diff.mismatched, ["PATH"])
await writeFile(new URL("./ENV_FOLLOWUP_OFFLINE.json", import.meta.url), JSON.stringify({ oldArtifact: oldPath, oldArtifactSHA256: createHash("sha256").update(oldBytes).digest("hex"), expectedFailedBefore: true, immutableRetentionPassed: true, exactCorrelationPassed: true, WindowsConflictRejectionPassed: true, completeDiffPassed: true }, null, 2))
console.log("PASS immutable backend retention, exact binding, Windows case-fold conflicts, complete differences")
