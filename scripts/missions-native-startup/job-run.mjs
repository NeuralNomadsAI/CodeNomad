// One opt-in immutable adapter. Frozen startup12 and running/completed slow proofs are not rewritten.
import assert from "node:assert/strict"
import { fork, execFileSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { cancelJobProbe } from "./job-scope.mjs"

if (!process.argv.includes("--worker")) {
  const parent = path.join(process.env.LOCALAPPDATA, "Temp/opencode")
  await mkdir(parent, { recursive: true })
  const controlDirectory = await mkdtemp(path.join(parent, "job-control-"))
  const startedAt = Date.now(), deadlineAt = startedAt + 240_000
  await writeFile(path.join(controlDirectory, "launch.json"), JSON.stringify({ startedAt, deadlineAt,
    supervisorPID: process.pid, originalRPCDeadlineMs: 2_000, authority: "fixture-custody-only" }), { flag: "wx" })
  const child = fork(fileURLToPath(import.meta.url), [process.argv[2], "--worker", "--claim-watcher"], {
    stdio: ["ignore", "inherit", "inherit", "ipc"], env: { ...process.env, JOB_PROBE_CONTROL_DIRECTORY: controlDirectory } })
  await writeFile(path.join(controlDirectory, "worker.json"), JSON.stringify({ workerPID: child.pid, supervisorPID: process.pid }), { flag: "wx" })
  const watchdog = setTimeout(async () => {
    if (child.connected) child.send({ kind: "cancel" }, () => {})
    await writeFile(path.join(controlDirectory, "deadline.json"), JSON.stringify({ at: Date.now(), qualification: "unqualified",
      custodyRetained: !actualClose, workerForkCloseObserved: actualClose }), { flag: "wx" })
  }, Math.max(0, deadlineAt - Date.now()))
  let actualClose = false, receiptMessage, ownedService
  child.on("message", async message => {
    if (message?.kind === "job-fixture-receipt") receiptMessage = message
    if (message?.kind === "job-owned-service") {
      ownedService = message
      await writeFile(path.join(controlDirectory, "owned-service.json"), JSON.stringify(message), { flag: "wx" })
    }
  })
  child.on("error", () => { process.exitCode = 1 })
  child.on("close", async code => {
    actualClose = true; clearTimeout(watchdog); process.exitCode = code ?? 1
    await writeFile(path.join(controlDirectory, "fork-close.json"), JSON.stringify({ workerPID: child.pid,
      workerForkCloseObserved: true, ownedService: ownedService ?? null, nativeCleanupConfirmed: receiptMessage?.cleanupConfirmed === true,
      sentinelNativeHandleCloseObserved: receiptMessage?.sentinelClosed === true,
      qualification: code === 0 && receiptMessage?.cleanupConfirmed && receiptMessage?.sentinelClosed ? "passed" : "unqualified",
      exitCode: code }), { flag: "wx" })
    if (receiptMessage) await writeFile(`${receiptMessage.path}.job-close.json`, JSON.stringify({ workerPID: child.pid,
      workerForkCloseObserved: true, nativeCleanupConfirmed: receiptMessage.cleanupConfirmed,
      sentinelNativeHandleCloseObserved: receiptMessage.sentinelClosed, exitCode: code }, null, 2), { flag: "wx" })
  })
  process.on("exit", () => { if (!actualClose) process.exitCode = 1 })
} else {
  process.on("message", message => { if (message?.kind === "cancel") cancelJobProbe() })
  const startedAt = Date.now(), hash = bytes => createHash("sha256").update(bytes).digest("hex")
  const mainURL = new URL("../test-missions-native-startup.mjs", import.meta.url)
  const paths = execFileSync("git", ["show", "--format=", "--name-only", "bdd6f874"], { encoding: "utf8" }).trim().split(/\r?\n/)
  assert.equal(paths.length, 12)
  const frozen = await Promise.all(paths.map(async file => {
    const bytes = await readFile(file)
    assert.equal(hash(bytes), hash(execFileSync("git", ["show", `bdd6f874:${file}`])))
    return { file, sha256: hash(bytes) }
  }))
  let source = await readFile(mainURL, "utf8")
  const substitutions = []
  const replace = (from, to, reason) => {
    assert.equal(source.split(from).length, 2, `Frozen adapter seam changed: ${reason}`)
    source = source.replace(from, to)
    substitutions.push(reason)
  }
  replace('import { startClaimProvider, runClaimResume } from "./missions-native-startup/claim-resume.mjs"',
    'import { startClaimProvider } from "./missions-native-startup/claim-resume.mjs"\nimport { runJobScope as runClaimResume } from "./missions-native-startup/job-scope.mjs"', "new owner probe, no claim/prompt/restart fixture execution")
  replace('claimWatcher ? "watcher" : "timer"', 'claimWatcher ? "job" : "timer"', "new native plugin")
  replace('["watcher-plugin.mjs", "watcher-scope.mjs", "claim-plugin.mjs", "emit.cjs"]',
    '["job-plugin.mjs", "job-contract.mjs", "job-scope.mjs", "job-run.mjs", "slow-expiry-safety.mjs", "managed-exit-witness.mjs", "claim-plugin.mjs", "emit.cjs"]', "exact authored source fingerprints")
  replace('"one-artifact-native-standing-execution-hook-only"', '"one-artifact-native-global-Job-owner-only"', "narrow process-lifetime scope")
  replace('let stage = "copy"', `evidence.jobFrozen12 = ${JSON.stringify(frozen)};\nevidence.jobAdapter = { baseSHA256: ${JSON.stringify(hash(await readFile(mainURL)))}, affectedModes: "new Job mode only", substitutions: ${JSON.stringify(substitutions)} };\nlet nativeServiceStartAttempted = false, fixtureCleaning = false;\nlet stage = "copy"`, "baseline freeze in actual native receipt")
  replace('  try {\n    const value = await exec(executable, args,',
    '  if (!fixtureCleaning) jobProbeSignal.throwIfAborted();\n  if (args[0] === "service" && ["start", "restart"].includes(args[1])) nativeServiceStartAttempted = true;\n  try {\n    const value = await exec(executable, args,', "deadline stops admission; attempted unknown outcomes retain custody")
  replace('cwd: root, env: environment, timeout, windowsHide:',
    'cwd: root, env: environment, signal: fixtureCleaning ? undefined : jobProbeSignal, timeout, windowsHide:', "owned CLI work respects qualification deadline; cleanup remains available")
  replace('} finally {\n  // Release only', '} finally {\n  fixtureCleaning = true;\n  // Release only', "deadline never disables acknowledged teardown")
  replace('async function successful(args) {\n  const result = await run(args)\n  if (result.code !== 0) throw Object.assign(new Error("Private CLI command failed"), { code: result.reason })\n  return result.stdout\n}', `async function successful(args) {
    let witness;
    try {
      let current;
      if (args[0] === "service" && args[1] === "stop") {
        current = await connected(); await guard(current.snapshot);
        const startIdentity = await lookupManagedIdentity(current.snapshot.pid);
        witness = await captureManagedExit({ pid: current.snapshot.pid, startIdentity, executable: cli, nonce });
        await witness.ready;
        await guard(current.snapshot);
        assert.equal(await lookupManagedIdentity(current.snapshot.pid), startIdentity, "Owner changed before stop");
      }
      const result = await run(args);
      if (witness) {
        const proof = await witness.exited;
        assert.ok(exitHandleAcknowledged(proof, nonce));
        const receipt = { ...proof, operation: "stop", requestedFor: current.snapshot };
        (evidence.managedExitWitnesses ??= []).push(receipt);
        await writeFile(path.join(root, "service-exit.json"), JSON.stringify(receipt), { flag: "wx" });
      }
      if (result.code !== 0) throw Object.assign(new Error("Private CLI command failed"), { code: result.reason });
      return result.stdout;
    } finally { await witness?.close() }
  }`, "reuse owned same-handle witness ready before stop; persist proof before qualification assertions")
  replace('async function stopOwned() {', 'let cleanupPID;\nasync function stopOwned() {', "retain exact authenticated native cleanup PID")
  replace('    await successful(["service", "stop"])', '    cleanupPID = current.snapshot.pid;\n    await successful(["service", "stop"])', "capture service ownership before stop mutation")
  replace('  evidence.cleanup = { confirmed: true, ...after }',
    '  const handle = evidence.managedExitWitnesses?.at(-1);\n  assert.ok(!nativeServiceStartAttempted || (handle?.operation === "stop" && exitHandleAcknowledged(handle, nonce) && (!cleanupPID || handle.pid === cleanupPID)), "Managed same-handle exit ACK required after attempted admission");\n  evidence.cleanup = { confirmed: true, managedExitHandle: handle, ...after }', "PID absence cannot release custody; same-handle ACK survives failed qualification")
  const oldCleanup = source.slice(source.indexOf('  if (registrationFile && port) {', source.indexOf('} finally {')), source.indexOf('  if (provider) {', source.indexOf('} finally {')))
  replace(oldCleanup, `  const teardown = memoizedTeardown(async () => {
    if (registrationFile && port) await stopOwned();
    else {
      assert.equal(nativeServiceStartAttempted, false);
      assert.ok(inside(await realpath(parent), await realpath(root)));
      registrationFile ??= path.join(root, ".local/state/opencode/service.json");
      assert.equal(await registration(), undefined);
      evidence.cleanup = { confirmed: true, kind: "never-admitted-private-registration-absent" };
    }
    if (sentinel) {
      const closed = await closeOwnedSentinel(sentinel, async () => {
        if (evidence.externalService.preserved === true) return;
        const after = await sentinel.client.server.info({ signal: AbortSignal.timeout(2_000) });
        assert.deepEqual({ pid: after.pid, version: after.version }, sentinelBefore);
        evidence.externalService.after = { pid: after.pid, version: after.version };
        evidence.externalService.preserved = true;
      });
      evidence.externalService.ownedSentinelClosed = closed.sentinelCloseObserved;
      return { confirmed: closed.sentinelCloseObserved };
    }
    return { confirmed: true };
  });
  let cleanupAck;
  do {
    try { cleanupAck = await teardown() } catch { cleanupAck = { confirmed: false } }
    if (!cleanupAck.confirmed) {
      evidence.cleanup = { confirmed: false, custodyRetained: true };
      await writeFile(path.join(root, "cleanup-pending.json"), JSON.stringify(evidence.cleanup));
      await delay(1_000);
    }
  } while (!cleanupAck.confirmed);
`, "same acknowledged native teardown primitives; unknown owner never abandoned")
  replace('  console.log(JSON.stringify(evidence, null, 2))',
    '  console.log(JSON.stringify(evidence, null, 2));\n  process.send?.({ kind: "job-fixture-receipt", path: path.join(root, "receipt.json"), cleanupConfirmed: evidence.cleanup?.confirmed === true, sentinelClosed: evidence.externalService?.ownedSentinelClosed === true });', "native cleanup evidence before worker fork close")
  source = `import { jobProbeSignal } from ${JSON.stringify(new URL("job-scope.mjs", import.meta.url).href)}\nimport { captureManagedExit, lookupManagedIdentity, exitHandleAcknowledged } from ${JSON.stringify(new URL("managed-exit-witness.mjs", import.meta.url).href)}\nimport { memoizedTeardown, closeOwnedSentinel } from ${JSON.stringify(new URL("slow-expiry-safety.mjs", import.meta.url).href)}\n${source}`
  source = source.replaceAll('AbortSignal.timeout(5_000)', 'AbortSignal.timeout(2_000)')
  source = source.replace(/^(import .+ from )"([^"\n]+)"$/gm, (whole, prefix, specifier) => specifier.startsWith("node:") ? whole
    : `${prefix}${JSON.stringify(specifier.startsWith(".") ? new URL(specifier, mainURL).href : import.meta.resolve(specifier))}`)
    .replace('import.meta.resolve("effect/package.json")', JSON.stringify(import.meta.resolve("effect/package.json")))
    .replace('await import("esbuild")', `await import(${JSON.stringify(import.meta.resolve("esbuild"))})`)
    .replaceAll('import.meta.url', JSON.stringify(mainURL.href))
  if (process.argv.includes("--check-adapter")) {
    const { transform } = await import("esbuild")
    await transform(source, { loader: "js", target: "esnext" })
    console.log(JSON.stringify({ generatedAdapterSHA256: hash(source), nativeOperations: 0 }))
  } else await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`)
  for (const entry of frozen) assert.equal(hash(await readFile(entry.file)), entry.sha256)
  assert.ok(Date.now() - startedAt < 300_000)
  process.disconnect?.()
}
