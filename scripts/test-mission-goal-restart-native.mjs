// Isolated OpenCode 2.4.1 qualification probe for Mission coordinator `/goal`:
// 1. Restart behavior: exact pause reason, boot lifecycle, /goal resume
// 2. Background subagent interaction: /goal waits while a background child subagent runs
// 3. Pending `question` tool interaction: /goal stays quiet while waiting on a human
// 4. Unattended restart recovery: a Code Mode automation surviving daemon restart calls
//    a plugin RPC that reads `opencode.goal.get` and resumes the restart-paused `/goal`.
// Usage: node --import tsx scripts/test-mission-goal-restart-native.mjs <absolute-opencode-cli>
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"
import { fixtureEnvironment, fixtureParent } from "./native-product-fixture.mjs"
import { stopFixtureChild } from "./native-fixture-guards.mjs"

const cli = process.argv[2]
assert(cli && path.isAbsolute(cli), "Pass absolute OpenCode CLI path")

const root = await mkdtemp(path.join(await fixtureParent(), "mission-goal-probe-"))
const password = randomUUID()
const env = await fixtureEnvironment(root, {
  OPENCODE_CONFIG_DIR: path.join(root, "config"),
  OPENCODE_DB: path.join(root, "fixture.db"),
  OPENCODE_CONFIG_PROJECT_DISABLE: "1",
  OPENCODE_DISABLE_MODELS_FETCH: "1",
  OPENCODE_DISABLE_FFF: "1",
  OPENCODE_SERVER_PASSWORD: password,
})
const pluginDir = path.join(env.OPENCODE_CONFIG_DIR, "plugins", "goal-watchdog-probe")
await mkdir(pluginDir, { recursive: true })

// Minimal native plugin registered in the isolated config dir that exposes a Code Mode tool
// calling `opencode.goal.get` and `session.command({ name: "goal", text: "resume" })`.
await writeFile(path.join(pluginDir, "package.json"), JSON.stringify({
  name: "probe-goal-watchdog",
  type: "module",
  exports: { ".": "./index.mjs" },
  opencode: { server: "./index.mjs" },
}), "utf8")
await writeFile(path.join(pluginDir, "index.mjs"), `
const pass = { "~standard": { version: 1, vendor: "probe", validate: value => ({ value }) } }
const GoalRpcDef = {
  id: "opencode.goal",
  methods: { get: { input: pass, output: pass } },
  events: { changed: { schema: pass } },
}
export default {
  id: "probe.goal.watchdog",
  setup: async ctx => {
    const goalRpc = ctx.rpc(GoalRpcDef)
    await ctx.tool.transform(editor => editor.add({
      name: "probe_goal_reconcile",
      description: "Read a session's goal and resume it if paused by an OpenCode restart.",
      input: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false,
      },
      options: { namespace: "probe", codemode: true, permission: "probe_goal_reconcile" },
      execute: async input => {
        const goal = await goalRpc.get({ sessionID: input.sessionID })
        if (goal && goal.status === "paused" && goal.reason === "The server restarted while the goal was active") {
          await ctx.session.command({ sessionID: input.sessionID, name: "goal", text: "resume" })
          const after = await goalRpc.get({ sessionID: input.sessionID })
          return { content: JSON.stringify({ action: "resumed", beforeBoot: goal.boot, afterStatus: after?.status, afterBoot: after?.boot }) }
        }
        return { content: JSON.stringify({ action: "noop", status: goal?.status ?? null, reason: goal?.reason ?? null }) }
      },
    }))
  },
}
`, "utf8")

let scenario = "restart"
let childHoldRelease = null
let childStartedAt = 0
let childFinishedAt = 0
let rootTurnCount = 0
const turnsDuringChild = []

const provider = createServer(async (req, res) => {
  try {
    let raw = ""
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    const messages = Array.isArray(body.messages) ? body.messages : []
    const allText = messages.map(m => typeof m.content === "string" ? m.content : JSON.stringify(m.content)).join("\n")
    const tools = Array.isArray(body.tools) ? body.tools.map(t => t?.function?.name).filter(Boolean) : []
    const isChild = allText.includes("PROBE_CHILD_PROMPT")

    if (isChild) {
      childStartedAt = Date.now()
      await new Promise(resolve => {
        const timer = setTimeout(resolve, 3500)
        childHoldRelease = () => { clearTimeout(timer); resolve() }
      })
      childFinishedAt = Date.now()
      res.setHeader("Content-Type", "text/event-stream")
      for (const [delta, finish_reason] of [[{ role: "assistant", content: "CHILD_DONE" }, null], [{}, "stop"]]) {
        res.write(`data: ${JSON.stringify({ id: "child", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
      }
      res.end("data: [DONE]\n\n")
      return
    }

    // Ignore auxiliary tool-less LLM calls (title generation) when counting root turns.
    if (tools.length === 0) {
      res.setHeader("Content-Type", "text/event-stream")
      const auxReply = allText.includes("GOAL_REVIEW") || allText.toLowerCase().includes("goal") ? JSON.stringify({ done: false, reason: "Still waiting on child" }) : "Fixture Title"
      for (const [delta, finish_reason] of [[{ role: "assistant", content: auxReply }, null], [{}, "stop"]]) {
        res.write(`data: ${JSON.stringify({ id: "aux", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
      }
      res.end("data: [DONE]\n\n")
      return
    }

    rootTurnCount++
    if (scenario === "subagent" && childStartedAt > 0 && childFinishedAt === 0 && rootTurnCount > 2) {
      turnsDuringChild.push({ rootTurnCount, at: Date.now() })
    }
    res.setHeader("Content-Type", "text/event-stream")

    if ((scenario === "restart" || scenario === "watchdog-restart") && rootTurnCount === 1) {
      await delay(15_000)
      for (const [delta, finish_reason] of [[{ role: "assistant", content: "TURN1_LATE" }, null], [{}, "stop"]]) {
        res.write(`data: ${JSON.stringify({ id: "r1", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
      }
      res.end("data: [DONE]\n\n")
      return
    }

    if (scenario === "subagent" && rootTurnCount === 1) {
      const subTool = tools.find(t => t === "subagent")
      assert(subTool, "subagent tool must be available")
      const args = JSON.stringify({ agent: "explore", description: "Probe slow child", prompt: "PROBE_CHILD_PROMPT" })
      res.write(`data: ${JSON.stringify({ id: "s1", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_sub_1", type: "function", function: { name: subTool, arguments: args } }] }, finish_reason: null }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ id: "s1", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`)
      res.end("data: [DONE]\n\n")
      return
    }

    if (scenario === "question" && rootTurnCount === 1) {
      const qTool = tools.find(t => t === "question")
      assert(qTool, "question tool must be available")
      const args = JSON.stringify({ questions: [{ header: "Probe", question: "Proceed?", options: [{ label: "Yes", description: "Continue" }] }] })
      res.write(`data: ${JSON.stringify({ id: "q1", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_q_1", type: "function", function: { name: qTool, arguments: args } }] }, finish_reason: null }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ id: "q1", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`)
      res.end("data: [DONE]\n\n")
      return
    }

    if (scenario === "watchdog-arm" && rootTurnCount === 1) {
      // Root invokes Code Mode `execute` to create a persistent Code Mode automation that will survive daemon restart
      const execTool = tools.find(t => t === "execute")
      assert(execTool, `execute tool must be available; saw: ${tools.join(",")}`)
      const targetSessionID = globalThis.__watchdogTargetSessionID
      const code = `
const created = await tools.automation.create({
  name: "goal-watchdog-probe",
  trigger: { type: "every", every: "15 seconds" },
  action: {
    type: "code",
    code: \`
      const res = await tools.probe.probe_goal_reconcile({ sessionID: ${JSON.stringify(targetSessionID)} });
      const parsed = JSON.parse(typeof res === "string" ? res : JSON.stringify(res));
      if (parsed.action === "resumed") return { done: true, state: parsed };
      return { state: parsed };
    \`
  }
});
return created;
`
      res.write(`data: ${JSON.stringify({ id: "a1", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_exec_1", type: "function", function: { name: execTool, arguments: JSON.stringify({ code }) } }] }, finish_reason: null }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ id: "a1", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`)
      res.end("data: [DONE]\n\n")
      return
    }

    if (scenario === "watchdog-arm" && rootTurnCount === 2) {
      console.log("[PROBE 4] execute result message:", JSON.stringify(messages.at(-1)).slice(0, 400))
    }

    for (const [delta, finish_reason] of [[{ role: "assistant", content: `ROOT_REPLY_${scenario}_${rootTurnCount}` }, null], [{}, "stop"]]) {
      res.write(`data: ${JSON.stringify({ id: "rx", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
    }
    res.end("data: [DONE]\n\n")
  } catch (err) {
    console.error("[provider] error:", err)
    res.destroy(err)
  }
})

await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve))
env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
  automations: true,
  plugins: [pluginDir],
  model: "fixture/fixture",
  providers: {
    fixture: {
      package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: "fixture-only" },
      models: { fixture: {} },
    },
  },
})

async function startDaemon(label) {
  let output = "", spawnError
  const child = spawn(cli, ["serve", "--service", "--hostname", "127.0.0.1", "--port", "0", "--print-logs"], { cwd: root, env, windowsHide: true })
  const stopped = new Promise(resolve => child.once("close", resolve))
  child.on("error", err => { spawnError = err })
  child.stdout.on("data", d => { output += d })
  child.stderr.on("data", d => { output += d })
  const deadline = Date.now() + 30_000
  while (!/http:\/\/127\.0\.0\.1:\d+/.test(output)) {
    if (spawnError) throw spawnError
    if (child.exitCode !== null || Date.now() > deadline) throw new Error(`${label} failed:\n${output.slice(-2000)}`)
    await delay(25)
  }
  const file = path.join(env.XDG_STATE_HOME, "opencode/service.json")
  let endpoint
  while (!endpoint && Date.now() < deadline) {
    if (spawnError) throw spawnError
    if (child.exitCode !== null) throw new Error(`${label} exited before registration:\n${output.slice(-2000)}`)
    try {
      if (JSON.parse(await readFile(file, "utf8")).pid === child.pid) endpoint = await Service.discover({ file })
    } catch {}
    if (!endpoint) await delay(25)
  }
  assert(endpoint, `${label} did not register isolated service.json`)
  const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
  const getGoal = async sessionID => {
    const deadline = Date.now() + 15_000
    while (true) {
      try {
        return (await client.rpc.call({
          rpcID: "opencode.goal", method: "get", input: { sessionID }, location: { directory: root },
        }, { headers: { "x-opencode-directory": root } })).output
      } catch (error) {
        if (error?._tag === "RpcError" && error?.type === "rpc.unavailable" && Date.now() < deadline) {
          await delay(100)
          continue
        }
        throw error
      }
    }
  }
  return {
    child, stopped, client, getGoal,
    stop: async () => { await stopFixtureChild(child, stopped); await writeFile(path.join(root, `daemon-${label}.log`), output) },
  }
}

let d1, d2, d3
try {
  // === PROBE 1: RESTART ===
  d1 = await startDaemon("1")
  const ses1 = await d1.client.session.create({ location: { directory: root } })
  await d1.client.session.command({ sessionID: ses1.id, name: "goal", text: "Probe restart resilience", delivery: "steer" })
  let g1 = null
  for (let i = 0; i < 60 && g1?.status !== "active"; i++) { await delay(100); g1 = await d1.getGoal(ses1.id) }
  assert.equal(g1?.status, "active")

  await d1.stop(); d1 = null
  d2 = await startDaemon("2")
  const g2 = await d2.getGoal(ses1.id)
  assert.equal(g2?.id, g1.id)
  assert.equal(g2?.status, "paused")
  assert.equal(g2?.reason, "The server restarted while the goal was active")
  assert.equal(g2?.boot, g1.boot, "paused goal keeps the dead boot until resumed")

  scenario = "resumed"; rootTurnCount = 0
  await d2.client.session.command({ sessionID: ses1.id, name: "goal", text: "resume", delivery: "steer" })
  await delay(600)
  const g2Resumed = await d2.getGoal(ses1.id)
  assert.equal(g2Resumed?.id, g1.id)
  assert.notEqual(g2Resumed?.boot, g1.boot, "resumed goal adopts the new daemon boot")
  await d2.client.session.command({ sessionID: ses1.id, name: "goal", text: "clear", delivery: "steer" })
  console.log("PASS PROBE 1 (restart pause + dead boot preserved + resume updates boot)")

  // === PROBE 2: BACKGROUND SUBAGENT ===
  scenario = "subagent"; rootTurnCount = 0; childStartedAt = 0; childFinishedAt = 0; turnsDuringChild.length = 0
  const ses2 = await d2.client.session.create({ location: { directory: root } })
  await d2.client.session.command({ sessionID: ses2.id, name: "goal", text: "Wait for child subagent before finishing", delivery: "steer" })
  const subDeadline = Date.now() + 15_000
  while (childFinishedAt === 0 && Date.now() < subDeadline) await delay(100)
  assert.ok(childStartedAt > 0 && childFinishedAt > childStartedAt, "child ran and finished")
  assert.deepEqual(turnsDuringChild, [], "goal reviewer must NOT fire while background child subagent is running")
  await delay(800)
  await d2.client.session.command({ sessionID: ses2.id, name: "goal", text: "clear", delivery: "steer" }).catch(() => {})
  console.log("PASS PROBE 2 (/goal waits cleanly while background subagent runs; 0 premature turns)")

  // === PROBE 3: PENDING QUESTION ===
  scenario = "question"; rootTurnCount = 0
  const ses3 = await d2.client.session.create({ location: { directory: root } })
  await d2.client.session.command({ sessionID: ses3.id, name: "goal", text: "Ask user before continuing", delivery: "steer" })
  await delay(2500)
  const gQ = await d2.getGoal(ses3.id)
  assert.equal(gQ?.status, "active")
  assert.equal(rootTurnCount, 1, "goal reviewer stays quiet while question tool is pending")
  await d2.client.session.interrupt({ sessionID: ses3.id }).catch(() => {})
  await delay(200)
  await d2.client.session.command({ sessionID: ses3.id, name: "goal", text: "clear", delivery: "steer" }).catch(() => {})
  console.log("PASS PROBE 3 (/goal stays quiet while question tool is pending)")

  // === PROBE 4: UNATTENDED CODE MODE AUTOMATION WATCHDOG ACROSS RESTART ===
  const ses4 = await d2.client.session.create({ location: { directory: root } })
  globalThis.__watchdogTargetSessionID = ses4.id
  // First arm the Code Mode watchdog automation from an auxiliary session
  const sesWatch = await d2.client.session.create({ location: { directory: root } })
  scenario = "watchdog-arm"; rootTurnCount = 0
  await d2.client.session.prompt({ sessionID: sesWatch.id, text: "Arm watchdog" })
  await delay(1500)
  // Now arm `/goal` on ses4 and kill daemon #2 while ses4's goal is active!
  scenario = "watchdog-restart"; rootTurnCount = 0
  await d2.client.session.command({ sessionID: ses4.id, name: "goal", text: "Probe watchdog restart recovery", delivery: "steer" })
  let g4Before = null
  for (let i = 0; i < 60 && g4Before?.status !== "active"; i++) { await delay(100); g4Before = await d2.getGoal(ses4.id) }
  assert.equal(g4Before?.status, "active")
  console.log("[PROBE 4] armed ses4 goal before restart, boot=", g4Before.boot)

  await d2.stop(); d2 = null
  // Start daemon #3 WITHOUT calling any manual /goal resume — wait for the persistent Code Mode watchdog to resume it!
  scenario = "watchdog-recovered"; rootTurnCount = 0
  d3 = await startDaemon("3")
  let g4After = null
  const watchStart = Date.now()
  const watchDeadline = watchStart + 75_000
  while (Date.now() < watchDeadline) {
    g4After = await d3.getGoal(ses4.id)
    if (g4After && g4After.boot !== g4Before.boot) break
    await delay(500)
  }
  console.log(`[PROBE 4] after unattended restart (${Date.now() - watchStart}ms):`, g4After)
  assert.ok(g4After && g4After.boot !== g4Before.boot, "Code Mode watchdog automatically resumed /goal on daemon #3!")
  console.log("PASS PROBE 4 (unattended Code Mode automation resumed restart-paused /goal across OpenCode restart!)")
} finally {
  if (childHoldRelease) childHoldRelease()
  if (d1) await d1.stop().catch(() => {})
  if (d2) await d2.stop().catch(() => {})
  if (d3) await d3.stop().catch(() => {})
  provider.closeAllConnections()
  await new Promise(resolve => provider.close(resolve))
}
