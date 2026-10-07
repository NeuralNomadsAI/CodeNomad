// Exercise the exact NEW negative receipt gate with an owned Node child, never a daemon.
import assert from "node:assert/strict"
import { fork } from "node:child_process"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"

if (process.argv.includes("--custody-double")) {
  process.on("message", message => { if (message?.kind === "owned-test-close") { process.disconnect(); process.exit(0) } })
  const root = process.argv[2], nonce = "owned-test-double-not-native-enrollment"
  const source = await readFile(new URL("job-stock-run.mjs", import.meta.url), "utf8")
  const body = source.match(/const parkAfterReceipt = `([\s\S]*?)`/)[1]
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  const gate = new AsyncFunction("evidence", "root", "nonce", "process", "writeFile", "path", body)
  await gate({ cleanup: { custodyRetained: true }, jobScope: { service: null } }, root, nonce, process, writeFile, path)
  process.send?.({ kind: "wrongly-released" })
  process.disconnect()
} else {
  const root = await mkdtemp(path.join(process.env.LOCALAPPDATA, "Temp/opencode/job-stock-custody-negative-"))
  const child = fork(fileURLToPath(import.meta.url), [root, "--custody-double"], { stdio: ["ignore", "ignore", "ignore", "ipc"] })
  const watchdog = setTimeout(() => child.kill(), 5_000) // exact owned Node double only
  let closed = false, timer
  const done = new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("close", code => { closed = true; resolve(code) })
  })
  const ready = new Promise((resolve, reject) => {
    child.on("message", message => { if (message?.kind === "job-custody-parked") resolve(message); else reject(new Error("Negative gate released custody")) })
    child.once("error", reject)
    child.once("close", () => reject(new Error("Custody double closed before publication")))
    timer = setTimeout(() => reject(new Error("Custody publication deadline")), 2_000)
  })
  try {
    const message = await ready
    clearTimeout(timer)
    assert.equal(message.workerPID, child.pid)
    assert.equal(message.root, root)
    assert.equal(message.custodyRetained, true)
    assert.equal(message.qualification, "unqualified")
    assert.equal(message.automaticNativeActions, false)
    assert.equal(message.historicalOrCurrentExitACKInvented, false)
    await delay(100)
    assert.equal(closed, false, "Bounded negative publication must keep actual owned worker IPC alive")
    assert.equal(child.connected, true)
    const file = JSON.parse(await readFile(path.join(root, "custody-parked.json"), "utf8"))
    assert.equal(file.workerPID, child.pid)
    assert.equal(file.custodyRetained, true)
    child.send({ kind: "owned-test-close" }) // explicit test-only exit, not a native cleanup assertion
    assert.equal(await done, 0)
    console.log(JSON.stringify({ passed: 1, failed: 0, root, workerPID: child.pid, negativePublishedWithoutDisconnect: true,
      explicitOwnedDoubleCloseObserved: closed, nativeAdmissions: 0, nativeActions: 0 }))
  } finally {
    clearTimeout(timer)
    clearTimeout(watchdog)
    if (!closed) child.kill()
    await done
  }
}
