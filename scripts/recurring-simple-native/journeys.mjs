// Native journeys E/F/W/Q for scripts/test-recurring-simple-native.mjs. The deterministic
// provider plays the model through ordinary native tools only; no journal/schedule shortcut.
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { setTimeout as delay } from "node:timers/promises"

const OBSERVE = 10_000 // > 3 s settlement debounce: a pending passage must stay pending.
const id = prefix => `${prefix}_${randomUUID().replaceAll("-", "")}`
const toolResult = (turn, callID) => turn.messages.filter(m => m.role === "tool" && m.tool_call_id === callID)
  .map(m => typeof m.content === "string" ? m.content : JSON.stringify(m.content)).join("")
const callOf = (turn, predicate) => turn.messages.flatMap(m => m.tool_calls ?? []).find(predicate)

export async function runJourneys(c) {
  const location = { directory: c.project }
  const messages = async sessionID => (await c.client.message.list({ sessionID, limit: 100 })).data
  const active = async () => Object.keys(await c.client.session.active())
  const calls = sessionID => c.evidence.providerCalls.filter(call => call.sessionID === sessionID)
  // Read-only view of this fixture's own isolated database.
  const db = query => { const d = new DatabaseSync(c.env.OPENCODE_DB, { readOnly: true }); try { return query(d) } finally { d.close() } }
  const document = scheduleID => db(d => d.prepare("SELECT value FROM kv").all().map(row => { try { return JSON.parse(row.value) } catch { return undefined } })
    .find(value => value?.id === scheduleID && Array.isArray(value.cursors)))
  const idles = sessionID => db(d => d.prepare("SELECT json_extract(data,'$.outcome') AS outcome FROM session_message WHERE session_id=? AND type='idle'").all(sessionID)).map(row => row.outcome)
  const startText = async sessionID => (await messages(sessionID)).filter(m => m.type === "synthetic").map(m => m.text).join("\n")
  async function manual(scheduleID, n) {
    const { payload } = await c.runNow(scheduleID)
    let pending
    await c.until(async () => (pending = await c.snapshot(scheduleID)).pending?.conversationID)
    return { requestID: payload.requestID, passageID: pending.pending.passageID, sessionID: pending.pending.conversationID,
      messageID: pending.pending.messageID, n }
  }
  async function archived(scheduleID, count) {
    let after
    await c.until(async () => (after = await c.snapshot(scheduleID)).history.length === count, c.SETTLE, c.SLOW)
    return { after, observedAt: Date.now() }
  }
  const far = () => c.nextMinute(6 * 3_600_000)

  if (c.journeys.includes("E")) {
    c.setStage("E family quiescence")
    const marker = path.join(c.project, "e-wait.mjs"), release = path.join(c.project, "e-shell-release")
    await writeFile(marker, `import { existsSync, writeFileSync } from "node:fs"
writeFileSync("e-shell-started", String(Date.now()))
setTimeout(() => process.exit(2), 300000) // never outlive the fixture
const timer = setInterval(() => { if (!existsSync("e-shell-release")) return
  clearInterval(timer); writeFileSync("e-shell-ended", String(Date.now())); console.log("E_SHELL_" + "DONE"); process.exit(0) }, 200)
`)
    c.scenarios.push(turn => {
      if (turn.first.includes("[E-CHILD]")) return { hold: "E-child", text: "E_CHILD_RESULT" }
      if (!turn.first.includes("[JOURNEY-E]")) return undefined
      if (!turn.calls.includes("subagent")) return { calls: [
        { name: "subagent", args: { agent: "fixture-worker", description: "Background child", prompt: "[E-CHILD] Produce the child result", background: true } },
        { name: "shell", args: { command: "node e-wait.mjs", description: "Background wait", background: true } }] }
      if (turn.calls.includes("mission_report")) return { text: "Done" }
      return turn.all.includes("E_CHILD_RESULT") && turn.all.includes("E_SHELL_DONE")
        ? { calls: [{ name: "mission_report", args: { outcome: "completed", summary: "Background child and shell both finished", final: true } }] }
        : { text: "Waiting for background work" }
    })
    const scheduleID = await c.create("Native family quiescence", far(), { instructions: "[JOURNEY-E] Delegate a background child and a background shell; report only after both finish." })
    const E = c.evidence.journeys.E = { id: scheduleID }
    try {
      const passage = E.passage = await manual(scheduleID, 0)
      const coordinator = passage.sessionID
      await c.until(() => c.holds.has("E-child") && existsSync(path.join(c.project, "e-shell-started")))
      E.childID = (await c.sessions()).find(s => s.parentID === coordinator)?.id
      assert.ok(E.childID, "real native subagent child")
      const waits = () => calls(coordinator).filter(call => call.name === "Waiting for background work").length
      await c.until(async () => waits() >= 1 && !(await active()).includes(coordinator))
      E.coordinatorIdleAt = Date.now()
      await delay(OBSERVE)
      E.whileChildAndShell = { at: Date.now(), active: await active(), snapshot: await c.snapshot(scheduleID) }
      assert.ok(E.whileChildAndShell.snapshot.pending, "running child + shell keep the passage pending")
      assert.equal(E.whileChildAndShell.snapshot.history.length, 0)
      assert.ok(E.whileChildAndShell.active.includes(E.childID), "background child natively active")
      E.childReleasedAt = Date.now(); c.holds.get("E-child")(); c.holds.delete("E-child")
      await c.quiet(E.childID); E.childEndedAt = Date.now()
      await c.until(async () => waits() >= 2 && !(await active()).includes(coordinator))
      await delay(OBSERVE)
      E.whileShell = { at: Date.now(), active: await active(), snapshot: await c.snapshot(scheduleID) }
      assert.ok(E.whileShell.snapshot.pending, "a running background shell keeps the passage pending")
      assert.equal(E.whileShell.snapshot.history.length, 0)
      assert.equal(calls(coordinator).some(call => call.name === "mission_report"), false, "no final report before both end")
      E.shellReleasedAt = Date.now(); await writeFile(release, "go")
      await c.until(() => calls(coordinator).some(call => call.name === "mission_report"), 120_000)
      E.reportAt = calls(coordinator).find(call => call.name === "mission_report").at
      E.shellEndedAt = Number(await readFile(path.join(c.project, "e-shell-ended"), "utf8"))
      await c.quiet(coordinator); E.quiescentAt = Date.now()
      const { after, observedAt } = await archived(scheduleID, 1)
      E.archiveObservedAt = observedAt; E.archiveLatencyMs = observedAt - E.quiescentAt
      assert.equal(after.latestResult.outcome, "completed"); assert.equal(after.latestResult.passageID, passage.passageID)
      assert.ok(E.childEndedAt < E.shellEndedAt && E.shellEndedAt < E.reportAt && E.reportAt < E.archiveObservedAt, "child → shell → report → archive")
      // Native background-completion notices are synthetic too; only one is a Mission start.
      const synthetic = (await messages(coordinator)).filter(m => m.type === "synthetic" || m.type === "user")
      E.starts = synthetic.filter(m => m.metadata?.["codenomad.mission"]).map(m => m.id)
      E.nativeNotices = synthetic.filter(m => !m.metadata?.["codenomad.mission"]).map(m => ({ id: m.id, source: m.metadata?.source ?? m.metadata?.type ?? null }))
      assert.deepEqual(E.starts, [passage.messageID ?? E.starts[0]]); assert.equal(E.starts.length, 1)
      E.tools = calls(coordinator).map(call => call.name)
      E.result = "passed"
    } finally { if (!existsSync(release)) await writeFile(release, "cleanup"); c.holds.get("E-child")?.() }
    await c.control(scheduleID, "stop")
  }

  if (c.journeys.includes("F")) {
    c.setStage("F native provider failure")
    c.scenarios.push(turn => turn.first.includes("[JOURNEY-F]") ? { fail: true } : undefined)
    const scheduleID = await c.create("Native provider failure", far(), { instructions: "[JOURNEY-F] Attempt the work." })
    const F = c.evidence.journeys.F = { id: scheduleID }
    const passage = F.passage = await manual(scheduleID, 0)
    await c.until(() => calls(passage.sessionID).length > 0)
    await c.quiet(passage.sessionID); F.quiescentAt = Date.now()
    const { after, observedAt } = await archived(scheduleID, 1)
    F.archiveLatencyMs = observedAt - F.quiescentAt
    F.idleOutcomes = idles(passage.sessionID); F.eventRows = db(d => d.prepare("SELECT count(*) AS count FROM event").get().count)
    assert.equal(after.latestResult.outcome, "failed"); assert.equal(after.latestResult.reason, undefined)
    assert.ok(F.idleOutcomes.includes("failed"), "native projected the terminal failure")
    F.providerCallsAtArchive = calls(passage.sessionID).length
    await delay(OBSERVE)
    F.providerCallsLater = calls(passage.sessionID).length
    F.starts = await c.passageStarts(passage.sessionID)
    assert.equal(F.starts.length, 1); assert.equal(F.providerCallsLater, F.providerCallsAtArchive, "Missions never retries or replays")
    assert.equal((await c.snapshot(scheduleID)).pending, null)
    F.result = "passed"
    await c.control(scheduleID, "stop")
  }

  if (c.journeys.includes("W")) {
    c.setStage("W watched conversations")
    let failW = false
    c.scenarios.push(turn => {
      // The coordinator's start text embeds the source prose, so match it first.
      if (!turn.first.includes("[JOURNEY-W]")) return turn.first.includes("[W-SOURCE]") ? { text: "W-REPLY" } : undefined
      if (failW) return { fail: true }
      return turn.calls.includes("mission_report") ? { text: "Done" }
        : { calls: [{ name: "mission_report", args: { outcome: "completed", summary: "Watched messages processed", final: true } }] }
    })
    const source = await c.client.session.create({ location, title: "Watched ordinary conversation" })
    const say = async text => { await c.client.session.prompt({ sessionID: source.id, text }); await c.until(async () => (await messages(source.id)).some(m => m.type === "user" && m.text === text)); await c.quiet(source.id) }
    await say("[W-SOURCE] W-MSG-1")
    const scheduleID = await c.create("Native watched conversation", far(), { instructions: "[JOURNEY-W] Process new watched messages.", watched: [source.id] })
    const W = c.evidence.journeys.W = { id: scheduleID, sourceID: source.id, passages: [] }
    const cursor = () => document(scheduleID)?.cursors.find(item => item.conversationID === source.id)?.messageID ?? null
    const run = async (n, expectFailed) => {
      failW = expectFailed
      const before = cursor(), passage = await manual(scheduleID, n)
      const text = await startText(passage.sessionID)
      await c.quiet(passage.sessionID)
      const { after } = await archived(scheduleID, n + 1)
      failW = false
      const item = { ...passage, cursorBefore: before, cursorAfter: cursor(), outcome: after.latestResult.outcome,
        afterMessageID: text.match(/"afterMessageID":("[^"]*"|null)/)?.[1] ?? "absent",
        includes: ["W-MSG-1", "W-MSG-2", "W-MSG-3", "W-REPLY"].filter(word => text.includes(word)),
        starts: (await c.passageStarts(passage.sessionID)).length }
      W.passages.push(item); return item
    }
    const sourceIDs = async () => (await messages(source.id)).map(m => m.id)
    const p1 = await run(0, false)
    assert.equal(p1.outcome, "completed"); assert.ok(p1.includes.includes("W-MSG-1")); assert.equal(p1.afterMessageID, "null")
    assert.ok(p1.cursorAfter && (await sourceIDs()).includes(p1.cursorAfter), "completed advances the cursor to a real source message")
    await say("W-MSG-2")
    const p2 = await run(1, false)
    assert.equal(p2.outcome, "completed"); assert.deepEqual(p2.includes.filter(w => w.startsWith("W-MSG")), ["W-MSG-2"], "only messages since the cursor")
    assert.equal(p2.afterMessageID, JSON.stringify(p1.cursorAfter)); assert.notEqual(p2.cursorAfter, p1.cursorAfter)
    await say("W-MSG-3")
    const p3 = await run(2, true)
    assert.equal(p3.outcome, "failed"); assert.ok(p3.includes.includes("W-MSG-3"))
    assert.equal(p3.cursorAfter, p2.cursorAfter, "failed passage leaves the cursor unchanged")
    const p4 = await run(3, false)
    assert.equal(p4.outcome, "completed"); assert.ok(p4.includes.includes("W-MSG-3"), "unprocessed messages are offered again")
    assert.equal(p4.afterMessageID, JSON.stringify(p2.cursorAfter))
    for (const p of W.passages) assert.equal(p.starts, 1)
    W.result = "passed"
    await c.control(scheduleID, "stop")
  }

  if (c.journeys.includes("Q")) {
    c.setStage("Q Wayfinder human Form")
    const QUESTION = { question: "Choose the seam?", header: "Seam", options: [{ label: "Module", description: "Own the boundary" }] }
    let q = {}
    c.scenarios.push(async turn => {
      if (turn.first.includes("# CodeNomad Mission Assignment") && turn.first.includes("[JOURNEY-Q]"))
        return turn.calls.includes("question") ? { text: "Decision: Module (human answer received)" }
          : { calls: [{ name: "question", args: { questions: [QUESTION] } }] }
      if (!turn.first.includes("[JOURNEY-Q]")) return undefined
      if (!turn.calls.includes("mission_delegate")) return { calls: [{ name: "mission_delegate", id: q.delegateCall = id("call_qdel"),
        args: { taskKey: "decision", title: "Choose the seam", role: "decision", brief: "Ask the human which seam to use through a native question Form." } }] }
      if (!turn.calls.includes("subagent")) {
        const raw = toolResult(turn, q.delegateCall), start = raw.indexOf("{")
        q.delegated = JSON.parse(raw.slice(start, raw.lastIndexOf("}") + 1))
        return { calls: [{ name: "subagent", id: q.subagentCall = id("call_qsub"), args: { agent: "fixture-worker", description: "Decision worker", prompt: q.delegated.assignmentPrompt } }] }
      }
      const decision = callOf(turn, call => call.function.name === "mission_report" && JSON.parse(call.function.arguments).taskKey === "decision")
      if (!decision) {
        const parent = (await messages(turn.sessionID)).find(m => m.type === "assistant" && m.content?.some(p => p.type === "tool" && p.id === q.subagentCall))
        const delegation = parent.content.find(p => p.id === q.subagentCall), child = delegation.state.metadata?.sessionID
        const asked = (await messages(child)).find(m => m.type === "assistant" && m.content?.some(p => p.type === "tool" && p.name === "question"))
        const question = asked.content.find(p => p.type === "tool" && p.name === "question")
        const contract = q.delegated.contract
        q.provenance = { kind: "native-form-answer", contract: { missionID: contract.missionID, taskKey: contract.taskKey, generation: contract.generation },
          nativeCall: { generation: contract.generation, parentSessionID: turn.sessionID, parentMessageID: parent.id, toolCallID: q.subagentCall },
          sessionID: child, formID: q.formID, messageID: asked.id, toolCallID: question.id, fieldKey: "q0" }
        return { calls: [{ name: "mission_report", id: q.decisionCall = id("call_qrep"), args: { taskKey: "decision", outcome: "completed",
          summary: "The human chose Module", evidence: [], next: [], artifact: { kind: "decision", question: QUESTION.question, answer: "Module", provenance: q.provenance } } }] }
      }
      q.decisionResult ??= toolResult(turn, decision.id)
      if (!/"disposition"\s*:\s*"reported"/.test(q.decisionResult)) return { text: "Gate refused; no human decision recorded" }
      return turn.calls.filter(name => name === "mission_report").length >= 2 ? { text: "Done" }
        : { calls: [{ name: "mission_report", args: { outcome: "completed", summary: "Human decision recorded", final: true } }] }
    })
    const scheduleID = await c.create("Native Wayfinder decision", far(), { template: "wayfinder", instructions: "[JOURNEY-Q] Decide the seam with the human through a native Form." })
    const Q = c.evidence.journeys.Q = { id: scheduleID, runs: {} }
    for (const [n, mode] of [[0, "ui"], [1, "ordinary"]]) {
      q = {}
      const R = Q.runs[mode] = { passage: await manual(scheduleID, n) }
      let forms = []
      await c.until(async () => (forms = (await c.client.form.list({ location })).data).length === 1, 120_000)
      const form = R.form = { id: forms[0].id, sessionID: forms[0].sessionID, kind: forms[0].metadata?.kind }
      q.formID = form.id
      await delay(OBSERVE)
      R.whileForm = await c.snapshot(scheduleID)
      assert.ok(R.whileForm.pending, "a pending Form keeps the passage pending"); assert.equal(R.whileForm.history.length, n)
      const reply = await c.bridge().inject({ method: "POST", url: `/workspaces/${c.workspace().id}/instance/api/session/${form.sessionID}/form/${form.id}/reply`,
        headers: { cookie: "session=isolated-human", "content-type": "application/json", ...(mode === "ui" ? { "x-codenomad-human-answer": "1" } : {}) },
        payload: JSON.stringify({ answer: { q0: "Module" } }) })
      R.reply = { status: reply.statusCode, body: reply.body.slice(0, 300) }
      // Both the marked dock route and the ordinary proxy answer native's 204 No Content,
      // the only success status the generated client accepts for form replies.
      assert.equal(reply.statusCode, 204, reply.body)
      await c.quiet(R.passage.sessionID)
      const { after } = await archived(scheduleID, n + 1)
      R.outcome = after.latestResult.outcome; R.decisionResult = q.decisionResult?.slice(0, 600); R.provenance = q.provenance
      R.mark = db(d => d.prepare("SELECT key,value FROM kv WHERE key LIKE ?").all(`%/human-marks/%/${form.sessionID}/${form.id}`))
        .map(row => ({ state: JSON.parse(row.value).state, via: JSON.parse(row.value).via }))
      R.starts = (await c.passageStarts(R.passage.sessionID)).length
      assert.equal(R.starts, 1)
      if (mode === "ui") {
        assert.deepEqual(R.mark, [{ state: "confirmed", via: "ui" }])
        assert.match(R.decisionResult ?? "", /"disposition"\s*:\s*"reported"/, "Wayfinder gate accepts the confirmed UI mark")
        assert.equal(R.outcome, "completed")
      } else {
        assert.deepEqual(R.mark, [], "an ordinary answer leaves no UI mark")
        assert.doesNotMatch(R.decisionResult ?? "", /"disposition"\s*:\s*"reported"/, "gate refuses without the mark")
        // The model gets an actionable refusal, not the opaque Effect wrapper.
        assert.match(R.decisionResult ?? "", /Human decision required: the user must answer this question from the CodeNomad interface/)
        assert.doesNotMatch(R.decisionResult ?? "", /Effect\.tryPromise/)
        assert.equal(R.outcome, "ended-without-report", "no human decision, no final report")
      }
    }
    Q.result = "passed"
    await c.control(scheduleID, "stop")
  }

  if (c.journeys.includes("N")) {
    c.setStage("N ordinary question Form through the dock")
    const QUESTION = { question: "Pick a color?", header: "Color", options: [{ label: "Blue", description: "Calm" }] }
    c.scenarios.push(turn => {
      if (!turn.first.includes("[JOURNEY-N]")) return undefined
      if (!turn.calls.includes("question")) return { calls: [{ name: "question", args: { questions: [QUESTION] } }] }
      const answered = turn.messages.filter(m => m.role === "tool").map(m => typeof m.content === "string" ? m.content : JSON.stringify(m.content)).join("")
      return { text: answered.includes("Blue") ? "N-ANSWER-RECEIVED Blue" : "N-ANSWER-MISSING" }
    })
    const N = c.evidence.journeys.N = {}
    const session = await c.client.session.create({ location, title: "Ordinary conversation with a question" })
    N.sessionID = session.id
    N.missionMetadata = Boolean(session.metadata?.["codenomad.mission"])
    assert.equal(N.missionMetadata, false, "ordinary non-Mission session")
    await c.client.session.prompt({ sessionID: session.id, text: "[JOURNEY-N] Ask me a question." })
    let forms = []
    await c.until(async () => (forms = (await c.client.form.list({ location })).data.filter(f => f.sessionID === session.id)).length === 1, 120_000)
    const form = N.form = { id: forms[0].id, sessionID: forms[0].sessionID }
    const marksBefore = db(d => d.prepare("SELECT count(*) AS count FROM kv WHERE key LIKE '%/human-marks/%'").get().count)
    // Exactly what the InterruptionDock sends: authenticated cookie plus the human-answer hint.
    const reply = await c.bridge().inject({ method: "POST", url: `/workspaces/${c.workspace().id}/instance/api/session/${form.sessionID}/form/${form.id}/reply`,
      headers: { cookie: "session=isolated-human", "content-type": "application/json", "x-codenomad-human-answer": "1" },
      payload: JSON.stringify({ answer: { q0: "Blue" } }) })
    N.reply = { status: reply.statusCode, body: reply.body.slice(0, 300) }
    assert.equal(reply.statusCode, 204, `ordinary reply succeeds with native 204: ${reply.statusCode} ${reply.body}`)
    await c.until(() => calls(session.id).some(call => call.name.startsWith("N-ANSWER")), 120_000)
    await c.quiet(session.id)
    N.modelSaw = calls(session.id).map(call => call.name)
    assert.ok(N.modelSaw.includes("N-ANSWER-RECEIVED Blue"), "the native question received the dock answer")
    N.pendingForms = (await c.client.form.list({ location })).data.filter(f => f.sessionID === session.id).length
    assert.equal(N.pendingForms, 0)
    N.marks = db(d => d.prepare("SELECT key FROM kv WHERE key LIKE '%/human-marks/%'").all()).map(row => row.key)
    assert.equal(N.marks.length, marksBefore, "no UI mark is written for a non-Mission Form")
    assert.equal(N.marks.some(key => key.includes(session.id)), false)
    N.result = "passed"
  }
}
