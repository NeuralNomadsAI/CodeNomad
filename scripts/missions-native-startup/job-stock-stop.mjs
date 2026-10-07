// Separate stock-Windows-stop observer. The old graceful-finalizer assertion is untouched.
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { jobProbeSignal, cancelJobProbe } from "./job-scope.mjs"

const baseURL = new URL("job-scope.mjs", import.meta.url)
const bytes = await readFile(baseURL)
const baseSHA256 = createHash("sha256").update(bytes).digest("hex")
assert.equal(baseSHA256, "dc46ee3295a7ec5f1b57af39833e9b48ae890be5fccc53b99462c60142ee5c57")
let source = bytes.toString("utf8")
const replace = (from, to) => { assert.equal(source.split(from).length, 2); source = source.replace(from, to) }
replace("const abort = new AbortController()", "const abort = { signal: originalSignal, abort: originalCancel }")
replace('scope: "actual-native-global-Job-owner-and-one-cold-root-acquire-only"',
  'scope: "native-process-bound-Job-lifetime-stock-Windows-stop; graceful-app-Scope-shutdown-NOT-qualified"')
const start = source.indexOf('  assert.ok(cancelled, "Native service process termination is not a Job Scope cancellation ACK")')
assert.ok(start > 0)
assert.ok(source.slice(start).includes('assert.equal(cancelled.facts.exit, "cancelled")'))
const completion = `  // Stock Windows stop terminates the process; it does not await the application Scope.
  // Finalizer observations are retained independently, NEVER synthesized from process death.
  result.stockStop = { requestedFor: snapshot, managedExitHandle: handle,
    finalizerObservation: cancelled ?? null, nativeStoppedGuardVerified: true,
    nativeJobCallbackCancellationObserved: cancelled?.facts.exit === "cancelled",
    gracefulApplicationScopeShutdownQualified: false, nativeGenerationScopeCancelQualified: false,
    stockPath: "persistentPty.shutdown best-effort; Service.stop SIGTERM/PID polling/SIGKILL",
    processBoundMeaning: "the same private native process exited; its in-process Job cannot continue there",
    coldPersistenceQualified: false, writerAuthorityQualified: false, unknownEffectReconciliationQualified: false };
  const ready = evidence.managedExitReady?.find(proof => proof.watcherPID === handle.watcherPID);
  assert.ok(ready?.readyObserved === true && ready.sameHandleExitObserved === false);
  assert.equal(ready.pid, snapshot.pid);
  assert.equal(ready.startIdentity, handle.startIdentity);
  assert.equal(ready.executable, handle.executable);
  assert.equal(ready.nonce, nonce);
  assert.deepEqual(ready.requestedFor, snapshot);
  assert.equal(ready.root, root);
  assert.deepEqual(evidence.stockStopCommand.requestedFor, snapshot);
  assert.ok(ready.persistedAt <= evidence.stockStopCommand.at && evidence.stockStopCommand.at <= handle.exitedAt);
  assert.ok(handle.exitedAt < secondStart.at + 90_000);
  result.stockStop.readyBeforeStop = ready;
  result.counts = { nativeJobStarts: result.nativeAdmissionAttempts,
    freshAcquires: finished.filter(entry => entry.kind === "job-fresh-acquire").length,
    dueMarkers: finished.filter(entry => entry.kind === "job-due-marker").length,
    dueSuccessfulRunFinalizers: finished.filter(entry => entry.kind === "job-run-finalized" && entry.jobID === first.job.id && entry.facts.exit === "success").length,
    stockStoppedJobs: 1, nativeJobCancelCalls: 0,
    shutdownJobFinalizers: finished.filter(entry => entry.kind === "job-run-finalized" && entry.jobID === second.job.id).length,
    sessionPromptAdmissions: 0, modelRequests: provider.calls.length };
  assert.deepEqual({ ...result.counts, shutdownJobFinalizers: 0 }, { nativeJobStarts: 2, freshAcquires: 1,
    dueMarkers: 1, dueSuccessfulRunFinalizers: 1, stockStoppedJobs: 1, nativeJobCancelCalls: 0,
    shutdownJobFinalizers: 0, sessionPromptAdmissions: 0, modelRequests: 0 });
  result.observerSource = { baseSHA256: ${JSON.stringify(baseSHA256)}, oldGracefulFinalizerAssertionUnmodified: true };
  evidence.outcome = "native-Job-survives-caller-origin-closure-one-fresh-due-acquire-stock-stop-witnessed-process-exit";
  evidence.managedQualification = "native-process-bound-Job-lifetime-only; graceful-Scope-shutdown-and-cold-recovery-not-qualified";
}`
source = source.slice(0, start) + completion
source = `import { jobProbeSignal as originalSignal, cancelJobProbe as originalCancel } from ${JSON.stringify(baseURL.href)}\n${source}`
source = source.replace(/^(import .+ from )"([^"\n]+)"$/gm, (whole, prefix, specifier) => specifier.startsWith("node:") ? whole
  : `${prefix}${JSON.stringify(specifier.startsWith(".") ? new URL(specifier, baseURL).href : import.meta.resolve(specifier))}`)
const observer = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`)
export const runStockStopScope = observer.runJobScope
// The observer and immutable runner share one cancellation/deadline signal, not independent retries.
assert.equal(observer.jobProbeSignal, jobProbeSignal)
assert.equal(typeof cancelJobProbe, "function")
