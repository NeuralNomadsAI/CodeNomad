import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { run, childCall } from "./harness.mjs"
import { launch } from "./runtime.mjs"
await run("native-private-shutdown-handler-workaround", async h => {
  const rootID = await h.parent("Child completed at graceful native handler boundary")
  await h.control(rootID, "running", { fault: "after-result" })
  h.provider.childPlans.set("graceful_child", { answers: ["COMPLETED_BEFORE_GRACEFUL_HANDLER"] })
  await h.submit(rootID, [childCall("graceful_child")])
  const binding = await h.binding("graceful_child")
  await h.until(async () => (await readFile(`${h.root}/hooks.jsonl`, "utf8")).split("\n").filter(Boolean).map(JSON.parse).some(record => record.kind === "native-result" && record.callID === "graceful_child"), "completed child result before parent consumes")
  const before = await h.running.client.session.get({ sessionID: binding.childID })
  assert.equal(before.outcome, "succeeded")
  const request = await h.rpc("gracefulHandler")
  let naturalExit = false
  if (request.attempted) {
    try { await h.until(() => h.running.child.exitCode !== null, "already registered native signal handler closes private daemon", 8_000); naturalExit = true }
    catch { /* Native handler attempt preserved; exact owned handle cleanup below. */ }
  }
  const old = h.running
  await old.stop() // Clears watchdog; exited handles are never killed.
  h.logs.push(old.logs)
  h.running = await launch(h.cli, h.root, process.env, h.deadline)
  const after = await h.running.client.session.get({ sessionID: binding.childID })
  assert.equal(after.parentID, rootID)
  const messages = await h.messages(binding.childID)
  assert(messages.some(message => JSON.stringify(message).includes("COMPLETED_BEFORE_GRACEFUL_HANDLER")))
  const hooks = (await readFile(`${h.root}/hooks.jsonl`, "utf8")).split("\n").filter(Boolean).map(JSON.parse)
  h.observe("registered native shutdown handler invoked on owned private daemon", naturalExit ? "WORKAROUND_TESTED" : "OBSERVED_LIMIT", { rootID, binding, request, naturalExit, nativeCleanupObserved: hooks.some(record => record.kind === "plugin-disposed"), before, after, parentDidNotConsumeBeforeRestart: !h.requests(rootID).some(record => JSON.stringify(record.body.messages).includes("COMPLETED_BEFORE_GRACEFUL_HANDLER")), ordinaryWindowsOSSignalQualified: false })
})
