import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { setTimeout as delay } from "node:timers/promises"
import { run, childCall } from "./harness.mjs"

await run("private-restart-fault-boundaries", async h => {
  const plan = (id, answers, hold = false) => h.provider.childPlans.set(id, { answers, hold })
  const children = async parentID => {
    const result = [], seen = new Set(); let after
    for (let page = 0; page < 10; page++) {
      const value = await h.running.client.session.list({ parentID, ...(after ? { after } : {}) }, h.options())
      for (const session of value.data) if (!seen.has(session.id)) { seen.add(session.id); result.push(session) }
      if (!value.next) return result
      after = value.next
    }
    throw new Error("Child inventory budget")
  }
  const snapshot = async (rootID, childID, callID) => ({
    root: await h.running.client.session.get({ sessionID: rootID }), child: await h.running.client.session.get({ sessionID: childID }),
    rootMessages: await h.messages(rootID), childMessages: await h.messages(childID),
    rootInbox: await h.running.client.session.inbox.list({ sessionID: rootID }), childInbox: await h.running.client.session.inbox.list({ sessionID: childID }),
    active: await h.running.client.session.active(), binding: (await h.rpc("inspect")).bindings.find(record => record.value.callID === callID)?.value ?? null,
  })
  // API contract newly present in 2.0.22, tested rather than inferred from old docs.
  const linkedRoot = await h.parent("Native parentID API actual runtime")
  const linked = []
  let parentID = linkedRoot
  for (let depth = 1; depth <= 3; depth++) {
    const child = await h.running.client.session.create({ parentID, title: "API-linked-depth-" + depth, agent: "recursive" }, h.options())
    assert.equal(child.parentID, parentID); linked.push(child); parentID = child.id
  }
  await h.submit(parentID, ["NATIVE_API_LINKED_DEPTH3_EXECUTED"]); await h.wait(parentID)
  assert.equal((await h.family(parentID)).length, 4)
  assert(h.requests(parentID).length)
  h.observe("2.0.22 session.create parentID native depth3 linked family", "SUPPORTED", { rootID: linkedRoot, linkedIDs: linked.map(session => session.id), actualModelConsumption: true, notSubagentToolLaunch: true })

  const completedRoot = await h.parent("Child completed before parent consumes result")
  await h.control(completedRoot, "running", { fault: "after-result" })
  plan("completed_before_consume", ["DURABLE_CHILD_COMPLETED_REPORT"])
  await h.submit(completedRoot, [childCall("completed_before_consume")])
  const completedBinding = await h.binding("completed_before_consume")
  await h.until(async () => (await readFile(`${h.root}/hooks.jsonl`, "utf8")).includes('"callID":"completed_before_consume","result"'), "actual native result withheld before parent consumption")
  const completedBefore = await snapshot(completedRoot, completedBinding.childID, "completed_before_consume")
  assert.equal(completedBefore.child.outcome, "succeeded")
  assert(!h.requests(completedRoot).some(record => JSON.stringify(record.body.messages).includes("DURABLE_CHILD_COMPLETED_REPORT")))
  // Actual native reload disposes pending services before a Windows handle stop.
  // No public daemon-shutdown API exists; do not label TerminateProcess graceful.
  await h.restart(true)
  const completedAfter = await snapshot(completedRoot, completedBinding.childID, "completed_before_consume")
  assert.equal(completedAfter.child.parentID, completedRoot)
  assert(completedAfter.childMessages.some(message => JSON.stringify(message).includes("DURABLE_CHILD_COMPLETED_REPORT")))
  h.observe("quiesced private restart retains completed child before parent consumption", "SUPPORTED", { before: completedBefore, after: completedAfter, daemonShutdownWasGraceful: false })
  h.observe("true graceful Windows private daemon signal shutdown", "UNTESTED", { reason: "Current authenticated API has no daemon shutdown operation; Location reload plus exact ChildProcess stop is explicitly not claimed equivalent" })

  for (const [name, background, fault] of [
    ["fg_before_binding", false, "before-binding"],
    ["bg_before_binding", true, "before-binding"],
    ["fg_progress_persisted", false, "after-admission"],
    ["bg_progress_persisted", true, "after-admission"],
    ["fg_provider_awaiting", false, "none"],
    ["bg_provider_awaiting", true, "none"],
  ]) {
    const rootID = await h.parent(name); await h.control(rootID, "running", { fault })
    plan(name, ["ORIGINAL_ASSIGNMENT_RESULT:" + name], fault === "none")
    await h.submit(rootID, [childCall(name, { background })])
    let childID
    await h.until(async () => {
      const found = await children(rootID)
      childID = found[0]?.id
      if (!childID) return false
      const trace = (await readFile(`${h.root}/hooks.jsonl`, "utf8")).split("\n").filter(Boolean).map(JSON.parse)
      return fault === "none" ? h.provider.holds.has(childID) : trace.some(record => record.kind === "fault-held" && record.callID === name && record.fault === fault)
    }, "fault point " + name)
    if (fault !== "before-binding") childID = (await h.binding(name)).childID
    const before = await snapshot(rootID, childID, name)
    const requestsBefore = h.requests(childID).length
    const birthsBefore = h.events.filter(event => event.type === "session.created" && event.data.parentID === rootID).length
    await h.restart(false)
    h.provider.release(childID)
    const after = await snapshot(rootID, childID, name)
    assert.equal(after.child.parentID, rootID)
    const inventoryAfter = await children(rootID)
    assert.equal(inventoryAfter.length, 1)
    await delay(120)
    const automaticRequests = h.requests(childID).length - requestsBefore
    h.observe("crash/reopen same private DB at " + name, "OBSERVED_LIMIT", { rootID, childID, background, fault, before, after, birthsBefore, childCountAfter: inventoryAfter.length, automaticRequests, missingBinding: after.binding === null, environmentAdmissionNotExercised: fault === "after-admission" })
    await h.control(rootID, "running", { fault: "none" })
    const recoveredCall = "recover_" + name
    plan(recoveredCall, ["EXPLICIT_SAME_CHILD_CONTINUATION:" + name])
    await h.submit(rootID, [childCall(recoveredCall, { sessionID: childID })], "Explicit user-authorized continuation; do not replay original assignment")
    await h.wait(rootID)
    const continued = await h.binding(recoveredCall)
    assert.equal(continued.childID, childID)
    assert.equal((await children(rootID)).length, 1)
    assert(h.requests(rootID).at(-1).body.messages.some(message => JSON.stringify(message).includes("EXPLICIT_SAME_CHILD_CONTINUATION:" + name)))
    h.observe("legitimate explicit native continuation without duplicate birth " + name, "WORKAROUND_TESTED", { rootID, childID, recoveredCall, duplicateBirths: 0, originalAssignmentReplayed: false, actualResultConsumed: true })
  }
  h.observe("production exactly-once contract/report and crash between environment dispatch/receipt", "UNTESTED", { reason: "Native identity/transcript persistence and explicit continuation are measured; no automatic replay/outbox/atomic binding claim is made" })
})
