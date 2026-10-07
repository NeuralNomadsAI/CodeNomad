// No native artifact admission: verify actual generated entry teardown on a missing CLI.
import assert from "node:assert/strict"
import { execFile, fork } from "node:child_process"
import { readFile, stat } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import path from "node:path"

const runner = fileURLToPath(new URL("job-stock-run.mjs", import.meta.url))
const missing = path.join(process.env.LOCALAPPDATA, "Temp/opencode/job-stock-stop-no-such-artifact.exe")
await assert.rejects(stat(missing), error => error.code === "ENOENT")
const checked = JSON.parse((await promisify(execFile)(process.execPath, [runner, missing, "--worker", "--check-adapter"],
  { timeout: 15_000, windowsHide: true, maxBuffer: 16 * 1024 })).stdout)
assert.equal(checked.nativeOperations, 0)
const child = fork(runner, [missing], { stdio: ["ignore", "pipe", "pipe", "ipc"] })
let stdout = "", stderrBytes = 0, closed = false, timer
child.stdout.setEncoding("utf8")
child.stdout.on("data", chunk => { stdout += chunk })
child.stderr.on("data", chunk => { stderrBytes += chunk.length })
const close = new Promise((resolve, reject) => {
  child.once("error", reject)
  child.once("close", code => { closed = true; clearTimeout(timer); resolve(code) })
  timer = setTimeout(() => { child.kill(); reject(new Error("owned-test-supervisor-close-deadline")) }, 60_000)
})
assert.equal(await close, 1)
assert.equal(stderrBytes, 0)
assert.ok(stdout.length < 32 * 1024)
const evidence = JSON.parse(stdout)
assert.equal(evidence.reason, "ENOENT")
assert.equal(evidence.outcome, "probe-unqualified")
assert.equal(evidence.cleanup.confirmed, true)
assert.equal(evidence.cleanup.kind, "never-admitted-private-registration-absent")
assert.equal(evidence.jobScope, undefined)
assert.equal(evidence.externalService, undefined)
const worker = JSON.parse(await readFile(path.join(evidence.root, "receipt.json.job-close.json"), "utf8"))
assert.equal(worker.workerForkCloseObserved, true)
assert.equal(worker.nativeCleanupConfirmed, true)
assert.equal(worker.exitCode, 1)
assert.equal(worker.sentinelNativeHandleCloseObserved, false)
console.log(JSON.stringify({ passed: 1, failed: 0, nativeAdmissions: 0, generatedAdapterSHA256: checked.generatedAdapterSHA256,
  receipt: path.join(evidence.root, "receipt.json"), ownedSupervisorPID: child.pid, ownedSupervisorCloseObserved: closed,
  workerClose: worker, originalTestsRetargeted: false }))
