import assert from "node:assert/strict"
import { readFile, writeFile, access } from "node:fs/promises"
import { setTimeout as delay } from "node:timers/promises"
import { run, call, childCall } from "./harness.mjs"

await run("native-interrupt-and-durable-generation-gates", async h => {
  const plan = (id, answers, hold = false) => h.provider.childPlans.set(id, { answers, hold })
  const start = async (name, background, gate = false) => {
    const rootID = await h.parent(name); await h.control(rootID, "running", { gate })
    plan(`${name}_1`, [childCall(`${name}_2`)]); plan(`${name}_2`, [childCall(`${name}_3`)]); plan(`${name}_3`, ["LATE_LEAF_REPORT:" + name], true)
    if (background) h.provider.holdSteps.set(rootID, 2)
    await h.submit(rootID, [childCall(`${name}_1`, { background }), "ROOT_LAUNCH_CONSUMED"])
    const bindings = []
    for (let i = 1; i <= 3; i++) bindings.push(await h.binding(`${name}_${i}`))
    await h.until(() => h.provider.holds.has(bindings[2].childID) && (!background || h.provider.holds.has(rootID)), "held depth3 " + name)
    return { rootID, bindings, ids: [rootID, ...bindings.map(binding => binding.childID)] }
  }
  const snapshot = async ids => Object.fromEntries(await Promise.all(ids.map(async sessionID => [sessionID, { session: await h.running.client.session.get({ sessionID }), active: Boolean((await h.running.client.session.active())[sessionID]) }])))
  const fg = await start("raw_foreground", false)
  const fgAck = await h.running.client.session.interrupt({ sessionID: fg.rootID, resume: false }, h.options())
  for (const id of fg.ids) await h.wait(id)
  const fgState = await snapshot(fg.ids)
  assert(fg.ids.every(id => !fgState[id].active && fgState[id].session.outcome === "interrupted"))
  h.provider.release(fg.bindings[2].childID)
  h.observe("raw root interrupt recursively attached foreground depth3", "SUPPORTED", { ...fg, ack: fgAck, states: fgState })

  const bg = await start("raw_background", true)
  const rootRequests = h.requests(bg.rootID).length
  const bgAck = await h.running.client.session.interrupt({ sessionID: bg.rootID, resume: false }, h.options())
  await h.wait(bg.rootID); const bgState = await snapshot(bg.ids)
  assert(bgState[bg.bindings[2].childID].active)
  h.provider.release(bg.bindings[2].childID); h.provider.release(bg.rootID)
  await h.until(() => h.requests(bg.rootID).length > rootRequests, "raw late background notification wakes interrupted root")
  await h.wait(bg.rootID)
  assert(h.requests(bg.rootID).at(-1).body.messages.some(message => JSON.stringify(message).includes("LATE_LEAF_REPORT:raw_background")))
  h.observe("raw parent interrupt does not stop background family; late native wake", "OBSERVED_LIMIT", { ...bg, ack: bgAck, statesAtInterrupt: bgState, requestsBefore: rootRequests, requestsAfter: h.requests(bg.rootID).length, nativeModelConsumption: true })

  const guarded = await start("guarded_background", true, true)
  const before = h.requests().length, rootBefore = h.requests(guarded.rootID).length
  const stop = await h.control(guarded.rootID, "stopped", { gate: true })
  await h.running.client.session.interrupt({ sessionID: guarded.rootID, resume: false }, h.options())
  h.provider.release(guarded.rootID); h.provider.release(guarded.bindings[2].childID)
  for (const id of guarded.ids) await h.wait(id)
  await h.until(async () => (await readFile(`${h.root}/hooks.jsonl`, "utf8")).split("\n").filter(Boolean).map(JSON.parse).some(record => record.kind === "rejected" && record.sessionID === guarded.rootID && record.boundary === "context"), "durable hook rejects actual late root wake")
  await delay(250)
  const familyRequests = h.requests().slice(before).filter(record => guarded.ids.includes(record.sessionID))
  assert.equal(familyRequests.length, 0)
  const stoppedMessages = await h.messages(guarded.rootID)
  const lateNotifications = stoppedMessages.filter(message => message.type === "synthetic")
  h.observe("Stop durable context gate rejects native late background wake", "WORKAROUND_TESTED", { ...guarded, generation: stop.generation, providerRequestsAfterStop: familyRequests.length, rawSyntheticMessagesStillPossible: lateNotifications, rootRequestsBefore: rootBefore, rootRequestsAfter: h.requests(guarded.rootID).length })
  await assert.rejects(h.control(guarded.rootID, "running", { gate: true }))
  const count = h.requests(guarded.rootID).length
  const admission = await h.running.client.session.synthetic({ sessionID: guarded.rootID, text: "EXPLICIT_POST_STOP_SYNTHETIC", resume: true, delivery: "queue" }, h.options())
  await h.wait(guarded.rootID)
  assert.equal(h.requests(guarded.rootID).length, count)
  h.observe("synthetic admission versus blocked model consumption after irreversible Stop", "WORKAROUND_TESTED", { admissionID: admission.id, rootID: guarded.rootID, consumptionCount: 0 })

  const paused = await start("paused_explicit_family", true, true)
  await h.control(paused.rootID, "paused", { gate: true })
  // Explicit bounded known family, leaves first. This is not atomic recursive pause.
  const receipts = []
  for (const id of [...paused.ids].reverse()) receipts.push({ sessionID: id, ack: await h.running.client.session.interrupt({ sessionID: id, resume: false }, h.options()) })
  for (const id of paused.ids) {
    for (const item of await h.running.client.session.inbox.list({ sessionID: id })) await h.running.client.session.inbox.cancel({ sessionID: id, inboxID: item.id }, h.options())
    h.provider.release(id); await h.wait(id)
  }
  const pausedBefore = h.requests().length; await delay(200)
  assert(!h.requests().slice(pausedBefore).some(record => paused.ids.includes(record.sessionID)))
  h.observe("Pause explicit family interrupt plus pending native inbox cancellation", "WORKAROUND_TESTED", { ...paused, receipts, states: await snapshot(paused.ids), atomic: false })
  await h.control(paused.rootID, "running", { gate: true })
  plan("authorized_continue", ["EXPLICIT_PLAY_SAME_CHILD_CONTINUED"])
  await h.submit(paused.rootID, [childCall("authorized_continue", { sessionID: paused.bindings[0].childID })]); await h.wait(paused.rootID)
  assert.equal((await h.binding("authorized_continue")).childID, paused.bindings[0].childID)
  assert(h.requests(paused.rootID).at(-1).body.messages.some(message => JSON.stringify(message).includes("EXPLICIT_PLAY_SAME_CHILD_CONTINUED")))
  h.observe("explicit Play continues same child without automatic assignment replay", "WORKAROUND_TESTED", { rootID: paused.rootID, childID: paused.bindings[0].childID, consumed: true })

  const capture = await h.parent("captured shell after Stop")
  await h.control(capture, "running", { gate: true }); h.provider.holdNext.add(capture)
  await h.submit(capture, [call("shell", { command: "node -e \"require('fs').writeFileSync('forbidden-after-stop.txt','bad')\"" }, "captured_shell")])
  await h.until(() => h.provider.holds.has(capture), "captured provider tools before stop")
  await h.control(capture, "stopped", { gate: true }); h.provider.release(capture); await h.wait(capture)
  await assert.rejects(access(`${h.project}/forbidden-after-stop.txt`))
  assert.equal(h.tools(await h.messages(capture)).find(tool => tool.id === "captured_shell").state.status, "error")
  h.observe("captured pre-Stop shell executor cannot start protected operation", "WORKAROUND_TESTED", { rootID: capture, filesystemEffect: false })

  const question = await h.parent("depth3 pending native question")
  await h.control(question, "running", { gate: true })
  plan("question_1", [childCall("question_2")]); plan("question_2", [childCall("question_3")]); plan("question_3", [call("question", { questions: [{ header: "Private", question: "Continue owned probe?", options: [{ label: "Yes", description: "Private choice" }] }] }, "depth3_question")])
  await h.submit(question, [childCall("question_1")]); const qb = await h.binding("question_3")
  let forms
  await h.until(async () => { forms = await h.running.client.session.form.list({ sessionID: qb.childID }); return forms.length }, "real pending native form at depth3")
  await h.control(question, "stopped", { gate: true })
  await h.running.client.session.interrupt({ sessionID: question, resume: false }, h.options()); await h.wait(question)
  for (const form of await h.running.client.session.form.list({ sessionID: qb.childID })) await h.running.client.session.form.cancel({ sessionID: qb.childID, formID: form.id }, h.options())
  h.observe("pending native depth3 question during foreground Stop", "WORKAROUND_TESTED", { rootID: question, childID: qb.childID, formsBefore: forms, formsAfter: await h.running.client.session.form.list({ sessionID: qb.childID }) })

  const permission = await h.parent("depth3 pending shell permission", [{ action: "shell", resource: "*", effect: "ask" }])
  await h.control(permission, "running", { gate: true })
  plan("permission_1", [childCall("permission_2")]); plan("permission_2", [childCall("permission_3")]); plan("permission_3", [call("shell", { command: "node -e \"require('fs').writeFileSync('permission-effect.txt','bad')\"" }, "depth3_permission")])
  await h.submit(permission, [childCall("permission_1")]); const pb = await h.binding("permission_3")
  let pending
  await h.until(async () => { pending = await h.running.client.permission.list({ sessionID: pb.childID }); return pending.length }, "real depth3 pending permission")
  await h.control(permission, "paused", { gate: true })
  await h.running.client.session.interrupt({ sessionID: permission, resume: false }, h.options()); await h.wait(permission)
  for (const request of await h.running.client.permission.list({ sessionID: pb.childID })) await h.running.client.permission.reply({ sessionID: pb.childID, requestID: request.id, reply: "reject" }, h.options())
  await assert.rejects(access(`${h.project}/permission-effect.txt`))
  h.observe("pending inherited native depth3 shell permission during Pause", "WORKAROUND_TESTED", { rootID: permission, pendingBefore: pending, pendingAfter: await h.running.client.permission.list({ sessionID: pb.childID }), filesystemEffect: false })

  const stopState = await h.rpc("inspect")
  await h.restart(false)
  const rehydrated = await h.rpc("inspect")
  assert.deepEqual(rehydrated.policies, stopState.policies)
  const providerCount = h.requests().length
  await h.running.client.session.synthetic({ sessionID: guarded.rootID, text: "POST_RESTART_STOP_NOTIFICATION", resume: true }, h.options()); await h.wait(guarded.rootID)
  assert.equal(h.requests().length, providerCount)
  h.observe("durable Stop generation rehydrates after private daemon replacement", "WORKAROUND_TESTED", { rootID: guarded.rootID, policiesRehydrated: true, providerRequests: 0, noPermissionPromptReplay: true })
  h.observe("atomic descendant-birth fence", "UNTESTED", { guarantee: "Hooks gate model dispatch/tool starts; explicit known-family interrupts are non-atomic" })
})
