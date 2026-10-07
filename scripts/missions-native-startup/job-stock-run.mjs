// Immutable stock-stop adapter of the accepted Job harness; no edits to its graceful variant.
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { runStockStopScope } from "./job-stock-stop.mjs"

assert.equal(typeof runStockStopScope, "function")
const baseURL = new URL("job-run.mjs", import.meta.url)
const bytes = await readFile(baseURL)
const baseSHA256 = createHash("sha256").update(bytes).digest("hex")
assert.equal(baseSHA256, "c86b6d052e91b175aa55f0fa863da2d84ec6785ef96515b3300eb84e8508e8dc")
let source = bytes.toString("utf8")
const replace = (from, to) => { assert.equal(source.split(from).length, 2, from); source = source.replace(from, to) }
replace("fork(fileURLToPath(import.meta.url)", `fork(${JSON.stringify(fileURLToPath(import.meta.url))}`)
replace('import { runJobScope as runClaimResume } from "./missions-native-startup/job-scope.mjs"',
  'import { runStockStopScope as runClaimResume } from "./missions-native-startup/job-stock-stop.mjs"')
replace('["job-plugin.mjs", "job-contract.mjs", "job-scope.mjs", "job-run.mjs", "slow-expiry-safety.mjs", "managed-exit-witness.mjs", "claim-plugin.mjs", "emit.cjs"]',
  '["job-plugin.mjs", "job-contract.mjs", "job-scope.mjs", "job-run.mjs", "job-stock-stop.mjs", "job-stock-run.mjs", "slow-expiry-safety.mjs", "managed-exit-witness.mjs", "claim-plugin.mjs", "emit.cjs"]')
replace("witness = await captureManagedExit({ pid: current.snapshot.pid, startIdentity, executable: cli, nonce });\n        await witness.ready;",
  `witness = await captureManagedExit({ pid: current.snapshot.pid, startIdentity, executable: cli, nonce });
        const ready = { ...await witness.ready, requestedFor: current.snapshot, root, nonce, operation: "stop", persistedAt: Date.now() };
        await (await import("node:fs/promises")).appendFile(path.join(root, "service-exit-ready.jsonl"), JSON.stringify(ready) + "\\\\n");
        (evidence.managedExitReady ??= []).push(ready);`)
replace("      const result = await run(args);", `      if (witness) {
        evidence.stockStopCommand = { at: Date.now(), requestedFor: current.snapshot };
        await writeFile(path.join(root, "stock-stop-command.json"), JSON.stringify(evidence.stockStopCommand), { flag: "wx" });
      }
      const result = await run(args);`)
replace('"one-artifact-native-global-Job-owner-only"', '"one-artifact-native-process-bound-Job-stock-Windows-stop-only"')
replace('affectedModes: "new Job mode only"', 'affectedModes: "new stock-stop variant only"')
replace("deadlineAt = startedAt + 240_000", "deadlineAt = startedAt + 180_000")
// Give cleanup its own bounded drain window. Missing proof stays negative, never becomes success.
replace("  let cleanupAck;\n  do {", "  let cleanupAck;\n  teardownDeadline = Date.now() + 40_000;\n  const cleanupDeadline = teardownDeadline;\n  do {")
replace("  } while (!cleanupAck.confirmed);", `  } while (!cleanupAck.confirmed && Date.now() < cleanupDeadline);
  if (!cleanupAck.confirmed) {
    evidence.cleanup = { confirmed: false, custodyRetained: true, reason: "bounded-cleanup-ACK-missing" };
    process.exitCode = 1;
  }`)
// Partial sentinel startup still has an owned child handle, even when readiness throws.
replace("let nativeServiceStartAttempted = false, fixtureCleaning = false;", "let nativeServiceStartAttempted = false, fixtureCleaning = false, sentinelCustody, teardownDeadline;")
replace("signal: fixtureCleaning ? undefined : jobProbeSignal, timeout, windowsHide:",
  "signal: fixtureCleaning ? undefined : jobProbeSignal, timeout: fixtureCleaning ? Math.min(timeout, Math.max(1, teardownDeadline - Date.now())) : timeout, windowsHide:")
replace("  const oldCleanup = source.slice", `  replace('  const done = new Promise(resolve => child.once("close", resolve))',
    '  const done = new Promise(resolve => child.once("close", resolve));\\n  sentinelCustody = { child, done };', "retain exact sentinel child from spawn");
  replace('  const deadline = Date.now() + 25_000',
    '  sentinelCustody.client = client;\\n  sentinelCustody.snapshot = { pid: child.pid, version: evidence.artifact.version };\\n  const deadline = Date.now() + 25_000', "retain partial sentinel identity");
  const oldCleanup = source.slice`)
replace("    if (sentinel) {\n      const closed = await closeOwnedSentinel(sentinel,", `    sentinel ??= sentinelCustody;
    if (sentinel) {
      evidence.externalService ??= { scope: "partial-owned-sentinel", before: sentinel.snapshot };
      sentinelBefore ??= sentinel.snapshot;
      const closed = await closeOwnedSentinel(sentinel,`)
// A negative native teardown must not skip independently owned sentinel teardown.
replace("    if (registrationFile && port) await stopOwned();", "    let managedConfirmed = false;\n    try {\n    if (registrationFile && port) await stopOwned();")
replace("    }\n    sentinel ??= sentinelCustody;", `    }
    managedConfirmed = evidence.cleanup?.confirmed === true;
    } catch { evidence.cleanup = { confirmed: false, custodyRetained: true } }
    sentinel ??= sentinelCustody;`)
replace("return { confirmed: closed.sentinelCloseObserved };", "return { confirmed: managedConfirmed && closed.sentinelCloseObserved };")
replace("    return { confirmed: true };", "    return { confirmed: managedConfirmed };")
// Publish a bounded negative qualification without abandoning an unconfirmed daemon.
// The provider/sentinel drains and receipt write precede this terminal custody wait.
const parkAfterReceipt = `  if (evidence.cleanup?.custodyRetained === true) {
    const custody = { root, nonce, workerPID: process.pid, receipt: path.join(root, "receipt.json"),
      managed: evidence.jobScope?.service ?? null, qualification: "unqualified", custodyRetained: true,
      automaticNativeActions: false, historicalOrCurrentExitACKInvented: false };
    await writeFile(path.join(root, "custody-parked.json"), JSON.stringify(custody), { flag: "wx" });
    process.send?.({ kind: "job-custody-parked", ...custody });
    await new Promise(() => {}); // Live worker IPC and supervisor fork handle retain custody; no native retry.
  }`
replace('  source = `import { jobProbeSignal }', `  replace('  console.log(JSON.stringify(evidence, null, 2));',
    ${JSON.stringify('  console.log(JSON.stringify(evidence, null, 2));\n' + parkAfterReceipt)}, "bounded negative receipt preserves live custody instead of disconnecting");
  source = \`import { jobProbeSignal }`)
replace('    if (message?.kind === "job-owned-service") {', `    if (message?.kind === "job-custody-parked") {
      process.exitCode = 1;
      await writeFile(path.join(controlDirectory, "custody-parked.json"), JSON.stringify(message), { flag: "wx" });
    }
    if (message?.kind === "job-owned-service") {`)
source = source.replace(/(?<!['"])import\.meta\.url(?!['"])/g, JSON.stringify(baseURL.href))
// Resolve the accepted runner's existing dependencies before entering its data module.
const main = await readFile(new URL("../test-missions-native-startup.mjs", import.meta.url), "utf8")
const imports = Object.fromEntries([...main.matchAll(/^import .+ from "([^"\n]+)"$/gm)].map(match => match[1])
  .filter(specifier => !specifier.startsWith("node:") && !specifier.startsWith("."))
  .map(specifier => [specifier, import.meta.resolve(specifier)]))
replace("import.meta.resolve(specifier)", "stockResolve(specifier)")
source = `const stockResolve = specifier => { if (specifier.startsWith("file:")) return specifier; const resolved = ${JSON.stringify(imports)}[specifier]; if (!resolved) throw new Error("Unknown fixture dependency"); return resolved }\n${source}`
source = source.replaceAll('JSON.stringify(import.meta.resolve("effect/package.json"))', JSON.stringify(JSON.stringify(import.meta.resolve("effect/package.json"))))
  .replaceAll('JSON.stringify(import.meta.resolve("esbuild"))', JSON.stringify(JSON.stringify(import.meta.resolve("esbuild"))))
  .replaceAll('const { transform } = await import("esbuild")', `const { transform } = await import(${JSON.stringify(import.meta.resolve("esbuild"))})`)
source = source.replace(/^(import .+ from )"([^"\n]+)"$/gm, (whole, prefix, specifier) => specifier.startsWith("node:") ? whole
  : `${prefix}${JSON.stringify(specifier.startsWith(".") ? new URL(specifier, baseURL).href : import.meta.resolve(specifier))}`)
await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`)
