import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { captureSourceHashes } from "./environment-evidence.mjs"
const base = new URL("./", import.meta.url), destination = new URL("./ENV_FOLLOWUP_RESULTS.json", base)
const reviewPath = "C:/Users/Admin/AppData/Local/Temp/opencode/qualification-lane4-independent-3d3dd593-51db-44fc-b9aa-2e9aa416762e/before.json"
const sha = value => createHash("sha256").update(value).digest("hex")
const reviewBytes = await readFile(reviewPath), review = JSON.parse(reviewBytes)
const historical = await readFile(new URL("./RESULTS.json", base))
assert.equal(sha(historical), review.source.qualification["RESULTS.json"], "Historical aggregate must remain byte-identical")
let aggregate
try { aggregate = JSON.parse(await readFile(destination, "utf8")) } catch (error) { if (error.code !== "ENOENT") throw error }
aggregate ??= { version: 2, scope: "New ENV evidence only; old 16-run aggregate/hashes not retrofitted", historicalAggregateSHA256: sha(historical), independentReviewBaseline: { path: reviewPath, sha256: sha(reviewBytes), qualification: review.source.qualification, documentSHA256: review.source.documents["MISSIONS_NATIVE_RECURSION_QUALIFICATION.md"] }, runs: [] }
const root = process.argv[2]
if (root && root !== "--manifest-only") {
  assert(root.startsWith("C:/Users/Admin/AppData/Local/Temp/opencode/missions-child-environment-"))
  const resultBytes = await readFile(`${root}/results.json`), result = JSON.parse(resultBytes)
  assert.equal(result.environmentEvidenceRevision.version, 2)
  assert(!aggregate.runs.some(run => run.root === root), "Append each new run exactly once")
  aggregate.runs.push({ root, resultSHA256: sha(resultBytes), phase: result.phase, status: result.status, error: result.error ?? null,
    version: result.version, counts: result.counts, before: result.before, after: result.after, hashesUnchanged: result.hashesUnchanged,
    sourceHashesAtExecution: result.environmentEvidenceRevision, backendRetentionFrames: result.allBackendTraces?.map(({ backendID, backendGeneration, checkpoint, capturedAt, trace }) => ({ backendID, backendGeneration, checkpoint, capturedAt, writes: trace.filter(record => record.operation === "environment-written").map(record => ({ dispatchID: record.dispatchID, callID: record.callID, childID: record.childID, messageID: record.messageID, generation: record.generation, sourceReadOrdinal: record.sourceReadOrdinal, sourceBuiltAt: record.sourceBuiltAt, dispatchAt: record.dispatchAt, writtenAt: record.writtenAt, count: record.sourceFingerprint.keyCount, hash: record.sourceFingerprint.canonicalSHA256 })) })),
    environmentComparisons: result.environmentComparisons ?? [], matrix: result.matrix,
    actualArtifactHashes: Object.fromEntries(await Promise.all(["requests.json", "events.json", "hooks.jsonl", "backend-trace.json", "transcripts.json"].map(async file => [file, sha(await readFile(`${root}/${file}`))]))) })
}
const current = await captureSourceHashes()
const documentPath = "D:/CodeNomad/.codenomad/worktrees/missions-native-subsessions-20261003/dev-docs/MISSIONS_NATIVE_RECURSION_QUALIFICATION.md"
aggregate.currentSourceHashes = current
aggregate.currentDocumentSHA256 = sha(await readFile(documentPath))
aggregate.changedSourcePathsVsReview = Object.entries(current).filter(([path, hash]) => review.source.qualification[path.split("/").at(-1)] !== hash).map(([path, after]) => ({ path, before: review.source.qualification[path.split("/").at(-1)] ?? null, after }))
if (aggregate.currentDocumentSHA256 !== aggregate.independentReviewBaseline.documentSHA256) aggregate.changedDocument = { path: "dev-docs/MISSIONS_NATIVE_RECURSION_QUALIFICATION.md", before: aggregate.independentReviewBaseline.documentSHA256, after: aggregate.currentDocumentSHA256 }
aggregate.recordedAt = new Date().toISOString()
await writeFile(destination, JSON.stringify(aggregate, null, 2))
console.log(JSON.stringify({ historicalAggregateSHA256: aggregate.historicalAggregateSHA256, runs: aggregate.runs.map(({ root, status, counts, environmentComparisons }) => ({ root, status, counts, comparisons: environmentComparisons.map(({ label, scope, sourceFingerprint, toolVsSource, apiVsSource, toolVsAPI }) => ({ label, scope, sourceCount: sourceFingerprint.keyCount, sourceHash: sourceFingerprint.canonicalSHA256, toolVsSource, apiVsSource, toolVsAPI })) })), changedSourcePathsVsReview: aggregate.changedSourcePathsVsReview, changedDocument: aggregate.changedDocument ?? null }, null, 2))
