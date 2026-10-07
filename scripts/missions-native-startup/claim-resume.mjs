import assert from "node:assert/strict"
import { createServer } from "node:http"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { isAgentNotFoundError } from "@opencode/client"

// Local deterministic MODEL fixture, not a CodeNomad backend or production bootstrap.
export async function startClaimProvider(nonce) {
  const calls = [], callID = `call_claim_${nonce.replaceAll("-", "")}`
  let failure, resume
  const resumedResponse = new Promise(resolve => { resume = resolve })
  const server = createServer(async (request, response) => {
    try {
      let bytes = 0
      for await (const chunk of request) { bytes += chunk.length; assert.ok(bytes < 512 * 1024) }
      const kind = request.headers["x-claim-kind"]
      assert.equal(kind, "primary", "Only the two expected native primary requests")
      assert.ok(calls.length < 2, "No model waiting loop or repeated tool admission")
      calls.push({ sessionID: request.headers["x-claim-session"], at: Date.now() })
      const initial = calls.length === 1
      if (!initial) await resumedResponse
      response.setHeader("content-type", "text/event-stream")
      const delta = initial ? { role: "assistant", tool_calls: [{ index: 0, id: callID, type: "function",
        function: { name: "fixture_hold", arguments: JSON.stringify({ nonce }) } }] }
        : { role: "assistant", content: "The interrupted fixture tool must not be retried." }
      for (const [content, finish_reason] of [[delta, null], [{}, initial ? "tool_calls" : "stop"]])
        response.write(`data: ${JSON.stringify({ id: "claim-fixture", object: "chat.completion.chunk", model: "fixture",
          choices: [{ index: 0, delta: content, finish_reason }] })}\n\n`)
      response.end("data: [DONE]\n\n")
    } catch { failure = "bounded-provider-contract-refused"; response.destroy() }
  })
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve) })
  return { calls, callID, failure: () => failure, release: resume,
    config: { model: "fixture/fixture", providers: { fixture: { package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "fixture" }, models: { fixture: {} } } } },
    async stop() { resume(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) } }
}

export async function runClaimResume({ root, nonce, env, provider, evidence, guard, successful, connected, configure, marker, beforeResumeSettlement, observeBeforeResumeModel }) {
  const file = path.join(root, "markers", "claim-resume.jsonl")
  for (const [key, value] of Object.entries({ NATIVE_STARTUP_MARKER: file, NATIVE_STARTUP_PHASE: "claim-resume",
    NATIVE_STARTUP_PERSISTED_NONCE: nonce })) await configure(key, value)
  const result = evidence.claimResume = { sourceTag: "v2.0.24", sourceCommit: "e7a34f09bfd9134dfade5a8ddb843f7030bc9a69",
    nativeAdmissionCount: 0, providerScope: "local-scripted-model-only", schedulerQualified: false }
  const options = () => ({ signal: AbortSignal.timeout(10_000) })
  const until = async check => {
    const end = Date.now() + 20_000
    while (Date.now() < end) {
      assert.equal(provider.failure(), undefined)
      const value = await check()
      if (value) return value
      await delay(50)
    }
    throw Object.assign(new Error("Claim proof deadline"), { code: "claim-proof-timeout" })
  }
  // Existing exact-tag private SQL columns, never write claims or inspect a session inventory.
  assert.equal(path.resolve(env.OPENCODE_DB), path.resolve(root, "fixture.db"))
  const { DatabaseSync } = await import("node:sqlite")
  const claim = sessionID => {
    const db = new DatabaseSync(env.OPENCODE_DB, { readOnly: true })
    try {
      const row = db.prepare("SELECT time_suspended, resume_attempts FROM session_v2 WHERE id = ?").get(sessionID)
      assert.ok(row, "Exact fixture session exists")
      return { ...row }
    }
    finally { db.close() }
  }
  await guard("stopped")
  await successful(["service", "start"])
  const first = await connected()
  assert.equal(first.snapshot.version, "2.0.24", "Qualification targets the explicitly requested artifact, not a runtime allowlist")
  result.before = first.snapshot
  const actor = await first.client.session.create({ title: "Native claim fixture", location: { directory: path.join(root, "project") } }, options())
  const idle = await first.client.session.create({ title: "Idle control fixture", location: { directory: path.join(root, "idle-project") } }, options())
  result.sessionID = actor.id
  result.idleSessionID = idle.id
  await until(async () => {
    const plugins = await first.client.plugin.list({ location: { directory: actor.location.directory } }, options())
    return plugins.data.some(plugin => plugin.id === "missions.native-claim-fixture" && plugin.state.status === "active")
  })
  // Permission evaluation precedes prompt admission, so select the native agent explicitly first.
  await first.client.session.switchAgent({ sessionID: actor.id, agent: "build" }, options())
  // Session creation/switching does not await every config transform. Demand the exact owned
  // Location's resolved native policy before the single permission evaluation; no mutation retries.
  await until(async () => {
    const selected = await first.client.agent.get({ agentID: "build", location: { directory: actor.location.directory } }, options())
      .catch(error => { if (isAgentNotFoundError(error)) return undefined; throw error })
    if (!selected) return false
    const rule = selected.data.permissions.findLast(rule => (rule.action === "*" || rule.action === "fixture_hold")
      && (rule.resource === "*" || rule.resource === nonce))
    return rule?.effect === "allow"
  })
  const permission = await first.client.permission.create({ sessionID: actor.id, action: "fixture_hold", resources: [nonce] }, options())
  result.nativePermission = permission
  assert.equal(permission.effect, "allow")
  await writeFile(path.join(root, "claim-enrollment.json"), JSON.stringify({ sessionID: actor.id, directory: actor.location.directory, nonce, permission }))
  // One explicit fixture admission. Unknown acknowledgements are never retried.
  const inputID = `msg_claim_${nonce.replaceAll("-", "")}`
  result.inputID = inputID
  result.nativeAdmissionCount++
  await first.client.session.prompt({ sessionID: actor.id, id: inputID, text: "Run the single nonce-bound fixture hold tool." }, options())
  const entered = await until(async () => (await marker(file)).find(entry => entry.kind === "claim-tool-enter" && entry.sessionID === actor.id))
  assert.equal(entered.callID, provider.callID)
  result.originalToolContext = { sessionID: entered.sessionID, messageID: entered.messageID, callID: entered.callID }
  result.claimBefore = claim(actor.id)
  result.idleClaimBefore = claim(idle.id)
  assert.ok(result.claimBefore.time_suspended !== null)
  assert.equal(result.idleClaimBefore.time_suspended, null)
  assert.equal(provider.calls.length, 1)
  await guard(first.snapshot)
  await successful(["service", "restart"])
  const second = await connected()
  result.after = second.snapshot
  assert.notEqual(second.snapshot.id, first.snapshot.id)
  assert.notEqual(second.snapshot.pid, first.snapshot.pid)
  // No Location/session API reads before this boot observation: only private registration + global info.
  await delay(2_000)
  const cold = (await marker(file)).filter(entry => entry.pid === second.snapshot.pid)
  result.bootObservation = { milliseconds: 2_000, scope: "observed-window-only",
    moduleEvaluations: cold.filter(entry => entry.kind.endsWith("-plugin-module")).map(entry => ({ kind: entry.kind, at: entry.at,
      pid: entry.pid, moduleURL: entry.moduleURL, moduleSHA256: entry.moduleSHA256, sourceFingerprintSHA256: entry.sourceFingerprintSHA256 })),
    enrolledLocationSetups: cold.filter(entry => entry.kind === "claim-plugin-setup" && entry.directory === actor.location.directory).length,
    idleLocationSetups: cold.filter(entry => entry.kind === "claim-plugin-setup" && entry.directory === idle.location.directory).length,
    toolEntries: cold.filter(entry => entry.kind === "claim-tool-enter").length }
  assert.equal(result.bootObservation.enrolledLocationSetups, 1)
  assert.equal(result.bootObservation.idleLocationSetups, 0)
  assert.equal(result.bootObservation.toolEntries, 0)
  if (observeBeforeResumeModel) return observeBeforeResumeModel({ actor, idle, client: second.client, snapshot: second.snapshot,
    file, claim, until, options, marker, guard, successful, connected, provider, evidence, nonce, entered })
  await until(() => provider.calls.length === 2)
  result.claimDuringResume = claim(actor.id)
  assert.ok(result.claimDuringResume.time_suspended !== null)
  assert.equal(result.claimDuringResume.resume_attempts, 1)
  if (beforeResumeSettlement) await beforeResumeSettlement({ client: second.client, snapshot: second.snapshot, actor, nonce, evidence, options })
  provider.release()
  await second.client.session.wait({ sessionID: actor.id }, options())
  const messages = await second.client.session.context({ sessionID: actor.id }, options())
  assert.ok(messages.length <= 30)
  const original = messages.find(message => message.id === entered.messageID)
  const tool = original?.content?.find(part => part.type === "tool" && part.id === entered.callID)
  assert.equal(tool?.state.status, "error")
  assert.equal(tool.state.error?.type, "aborted")
  result.originalToolAfter = { id: tool.id, status: tool.state.status, errorType: tool.state.error?.type ?? null }
  result.claimAfter = claim(actor.id)
  assert.equal(result.claimAfter.time_suspended, null)
  assert.equal(result.claimAfter.resume_attempts, 0)
  assert.equal(claim(idle.id).time_suspended, null)
  const entries = (await marker(file)).filter(entry => entry.kind === "claim-tool-enter")
  assert.equal(entries.length, 1)
  assert.equal(provider.calls.length, 2)
  assert.ok(provider.calls.every(call => call.sessionID === actor.id))
  result.toolExecutorEntries = entries.length
  result.primaryModelRequests = provider.calls.length
  result.coldPluginLoadedWithoutLocationDemand = true
  result.sameToolCallReentered = false
  result.outcome = "native-claim-cold-activation-proved-tool-aborted-fresh-model-continuation"
  evidence.outcome = result.outcome
  evidence.managedQualification = "claim-entry-only-not-scheduling"
  return { actor, idle, client: second.client, snapshot: second.snapshot, file, claim, until, options }
}
