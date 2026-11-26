// Throwaway prototype, not product code: can the "new commits on dev" Mission calendar be a
// plain OpenCode Automation? Runs every experiment on an isolated OpenCode service and writes
// the observations to <root>/observations.json.
// Usage: node --import tsx scripts/proto/native-scheduling.mjs <absolute-opencode-cli> [experiments]
//   experiments: comma-separated subset of detect,tools,github,shell,subagent,rejected,busy,gate,restart (default: all)
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"
import { fixtureEnvironment, fixtureParent } from "../native-product-fixture.mjs"
import { stopFixtureChild } from "../native-fixture-guards.mjs"

const cli = process.argv[2], wanted = new Set((process.argv[3] ?? "detect,tools,github,shell,subagent,rejected,busy,gate,restart").split(","))
assert(cli && path.isAbsolute(cli), "Pass the absolute OpenCode CLI path")
const root = await mkdtemp(path.join(await fixtureParent(), "proto-native-scheduling-"))
const observations = { root, experiments: {} }
const note = (name, value) => { observations.experiments[name] = value; console.log(`[${name}]`, JSON.stringify(value, null, 1).slice(0, 1800)) }

// A scripted model: records every request and can hold a turn open.
const turns = []
let holdMs = 0
const provider = createServer(async (req, res) => {
  let raw = ""
  for await (const chunk of req) raw += chunk
  const body = JSON.parse(raw), tools = Array.isArray(body.tools) ? body.tools : []
  const text = JSON.stringify(body.messages ?? body.input ?? "")
  res.setHeader("Content-Type", "text/event-stream")
  const reply = async content => {
    for (const [delta, finish_reason] of [[{ role: "assistant", content }, null], [{}, "stop"]])
      res.write(`data: ${JSON.stringify({ id: "r", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
    res.end("data: [DONE]\n\n")
  }
  if (!tools.length) return reply("Fixture title")
  const turn = { at: Date.now(), marker: text.match(/PASSAGE [0-9a-f]{6,40}/g)?.at(-1) ?? null, held: holdMs }
  turns.push(turn)
  if (holdMs) await delay(holdMs)
  turn.endedAt = Date.now()
  return reply("Passage done.")
})
await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve))

// A local forge: one branch head the script moves at will.
let head = "a".repeat(40), forgeReads = 0
const randomHead = () => randomUUID().replaceAll("-", "").padEnd(40, "0")
const forge = createServer((req, res) => { forgeReads++; res.setHeader("Content-Type", "text/plain"); res.end(head) })
await new Promise(resolve => forge.listen(0, "127.0.0.1", resolve))
const forgeURL = `http://127.0.0.1:${forge.address().port}/repos/owner/repo/commits/dev`

const password = randomUUID()
const env = await fixtureEnvironment(root, {
  OPENCODE_CONFIG_DIR: path.join(root, "config"), OPENCODE_DB: path.join(root, "fixture.db"),
  OPENCODE_CONFIG_PROJECT_DISABLE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_FFF: "1", OPENCODE_SERVER_PASSWORD: password,
})
// A plugin limited to the public plugin API: one Code Mode tool telling whether the calling
// conversation is still working, and keeping a record of each passage it lets through.
const pluginDir = path.join(env.OPENCODE_CONFIG_DIR, "plugins", "proto-gate")
await mkdir(pluginDir, { recursive: true })
await writeFile(path.join(pluginDir, "package.json"), JSON.stringify({ name: "proto-gate", type: "module", exports: { ".": "./index.mjs" }, opencode: { server: "./index.mjs" } }))
await writeFile(path.join(pluginDir, "index.mjs"), `
export default { id: "proto.gate", setup: async ctx => {
  await ctx.tool.transform(editor => editor.add({
    name: "passage_gate", description: "Tells whether the calling conversation still runs a passage and records the one about to start.",
    input: { type: "object", properties: { sha: { type: "string" } }, required: ["sha"], additionalProperties: false },
    options: { namespace: "proto", codemode: true, permission: "proto_passage_gate" },
    execute: async (input, context) => {
      const sessionID = context?.sessionID
      const busy = await Promise.race([ctx.session.wait({ sessionID }).then(() => false), new Promise(resolve => setTimeout(() => resolve(true), 400))])
      let stored = "skipped"
      if (!busy) { try { await ctx.storage.set("proto/passages/" + input.sha, { sha: input.sha, sessionID, at: Date.now() }); stored = "stored" } catch (error) { stored = String(error?.message ?? error) } }
      return { content: JSON.stringify({ busy, sessionID, stored, context: Object.keys(context ?? {}) }) }
    },
  }))
} }
`)

env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
  automations: true, plugins: [pluginDir], model: "fixture/fixture",
  providers: { fixture: { package: "@opencode/ai/providers/openai-compatible",
    settings: { baseURL: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: "fixture-only" }, models: { fixture: {} } } },
})

async function startDaemon(label) {
  let output = ""
  const child = spawn(cli, ["serve", "--service", "--hostname", "127.0.0.1", "--port", "0", "--print-logs"], { cwd: root, env, windowsHide: true })
  const stopped = new Promise(resolve => child.once("close", resolve))
  child.stdout.on("data", data => { output += data }); child.stderr.on("data", data => { output += data })
  const deadline = Date.now() + 30_000, file = path.join(env.XDG_STATE_HOME, "opencode/service.json")
  let endpoint
  while (!endpoint) {
    if (child.exitCode !== null || Date.now() > deadline) throw new Error(`${label} failed:\n${output.slice(-2000)}`)
    try { if (JSON.parse(await readFile(file, "utf8")).pid === child.pid) endpoint = await Service.discover({ file }) } catch {}
    if (!endpoint) await delay(50)
  }
  const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
  return { client, stop: async () => { await stopFixtureChild(child, stopped); await writeFile(path.join(root, `daemon-${label}.log`), output) } }
}

const location = { directory: root }
const until = async (label, read, done, ms = 60_000) => {
  const end = Date.now() + ms
  let value
  while (Date.now() < end) { value = await read(); if (done(value)) return value; await delay(500) }
  throw new Error(`Timed out: ${label}: ${JSON.stringify(value).slice(0, 600)}`)
}
const row = info => ({ status: info.status, runCount: info.runCount, lastOutcome: info.lastOutcome, lastOutput: info.lastOutput, state: info.state,
  nextDueAt: info.nextDueAt, lastRunAt: info.lastRunAt, sessionID: info.sessionID })
// The whole calendar: keep the last head seen, start one passage per change.
const detectCode = `
const response = await fetch(args.url, { headers: { accept: "application/vnd.github.sha", "user-agent": "codenomad-proto" } })
if (!response.ok) throw new Error("forge " + response.status)
const sha = (await response.text()).trim()
if (!state) return { state: { sha, passages: 0 } }
if (sha === state.sha) return
return { state: { sha, passages: state.passages + 1 }, send: { prompt: "PASSAGE " + sha + " Review the new commits on dev." } }
`

const transcript = async (client, sessionID) => ((await client.message.list({ sessionID })).data ?? []).map(message => ({ id: message.id, type: message.type, text: String(message.text ?? "").slice(0, 70) }))
const attempt = async work => { try { return await work() } catch (failure) { return { error: { tag: failure?._tag, message: String(failure?.message ?? failure).slice(0, 500) } } } }
const automation = (client, id) => client.experimental.automation.get({ automationID: id })
const every = { type: "every", every: "15 seconds" }
const ran = info => info.runCount >= 1 || info.lastOutcome !== undefined

let daemon = await startDaemon("1")
try {
  const { client } = daemon
  observations.version = (await client.server.info()).version

  if (wanted.has("detect")) {
    const carrier = await client.session.create({ location, title: "Commits on dev" })
    let created, error
    try {
      created = await client.experimental.automation.create({ sessionID: carrier.id, name: "commits-on-dev",
        trigger: { type: "every", every: "15 seconds" }, action: { type: "code", code: detectCode, args: { url: forgeURL } } })
    } catch (failure) { error = { tag: failure?._tag, message: String(failure?.message ?? failure).slice(0, 600) } }
    note("detect.create", created ? { id: created.id, ...row(created) } : { error })
    if (created) {
      const baseline = await until("baseline run", () => client.experimental.automation.get({ automationID: created.id }), info => info.runCount >= 1)
      note("detect.baseline", { ...row(baseline), forgeReads, turns: turns.length })
      head = "b".repeat(40)
      const fired = await until("change run", () => client.experimental.automation.get({ automationID: created.id }), info => info.state?.passages === 1)
      await until("passage turn", async () => turns.filter(turn => turn.marker).length, count => count >= 1, 30_000).catch(() => undefined)
      note("detect.change", { ...row(fired), turns: structuredClone(turns), carrierMessages: await transcript(client, carrier.id) })
      const quiet = turns.length
      await delay(20_000)
      const unchanged = await client.experimental.automation.get({ automationID: created.id })
      note("detect.unchanged", { ...row(unchanged), newTurns: turns.length - quiet })
      observations.detectID = created.id; observations.carrierID = carrier.id
    }
  }
  if (wanted.has("tools")) {
    // What can unattended automation code reach besides fetch?
    const code = `const found = {}
for (const query of ["session", "shell", "git", "mission", "automation", "busy active status"]) found[query] = (await search({ query, limit: 30 })).items.map(item => item.path)
return { done: true, state: { found } }`
    const session = await client.session.create({ location, title: "Tool inventory" })
    const created = await attempt(() => client.experimental.automation.create({ sessionID: session.id, name: "tool-inventory", trigger: every, action: { type: "code", code } }))
    if (created.error) note("tools", created)
    else note("tools", row(await until("inventory", () => automation(client, created.id), ran)))
  }

  if (wanted.has("github")) {
    const session = await client.session.create({ location, title: "GitHub head" })
    const created = await attempt(() => client.experimental.automation.create({ sessionID: session.id, name: "github-head", trigger: every,
      action: { type: "code", code: detectCode, args: { url: "https://api.github.com/repos/NeuralNomadsAI/CodeNomad/commits/dev" } } }))
    if (created.error) note("github", created)
    else {
      note("github", row(await until("github run", () => automation(client, created.id), ran)))
      await client.experimental.automation.delete({ automationID: created.id })
    }
  }

  if (wanted.has("shell")) {
    // A shell action runs with the machine's own Git and credentials, and no model.
    const action = { type: "shell", command: "git ls-remote https://github.com/NeuralNomadsAI/CodeNomad refs/heads/dev" }
    const plain = await client.session.create({ location, title: "ls-remote without a rule" })
    const refused = await attempt(() => client.experimental.automation.create({ sessionID: plain.id, name: "ls-remote-unruled", trigger: { type: "every", every: "1 minute" }, action }))
    const session = await client.session.create({ location, title: "ls-remote", permissions: [{ action: "shell", resource: "*", effect: "allow" }] })
    const fast = await attempt(() => client.experimental.automation.create({ sessionID: session.id, name: "ls-remote-fast", trigger: every, action }))
    const created = await attempt(() => client.experimental.automation.create({ sessionID: session.id, name: "ls-remote", trigger: { type: "every", every: "1 minute" }, action }))
    if (!refused.error) await client.experimental.automation.delete({ automationID: refused.id })
    if (created.error) note("shell", { fast, created, withoutRule: refused.error ?? "accepted" })
    else {
      await until("shell run", () => automation(client, created.id), ran, 100_000)
      await delay(5_000)
      note("shell", { fast: fast.error ?? "accepted at 15 seconds", withoutRule: refused.error ?? "accepted", action: created.action, ...row(await automation(client, created.id)), transcript: await transcript(client, session.id) })
      await client.experimental.automation.delete({ automationID: created.id })
    }
    if (!fast.error) await client.experimental.automation.delete({ automationID: fast.id })
  }

  if (wanted.has("subagent")) {
    // The same calendar, each passage in its own fresh conversation.
    const code = detectCode.replace('send: { prompt: "PASSAGE " + sha + " Review the new commits on dev." }', 'send: { prompt: "PASSAGE " + sha + " Review the new commits on dev.", to: { subagent: "general" } }')
    const owner = await client.session.create({ location, title: "Commits on dev, one conversation per passage" })
    const created = await attempt(() => client.experimental.automation.create({ sessionID: owner.id, name: "commits-fresh", trigger: every, action: { type: "code", code, args: { url: forgeURL } } }))
    if (created.error) note("subagent", created)
    else {
      await until("baseline", () => automation(client, created.id), info => info.runCount >= 1)
      const before = turns.length
      head = randomHead()
      const fired = await until("fresh passage", () => automation(client, created.id), info => info.state?.passages === 1)
      await until("fresh turn", async () => turns.length, count => count > before, 30_000).catch(() => undefined)
      const children = await attempt(async () => ((await client.session.list({ parentID: owner.id })).data ?? []).map(session => ({ id: session.id, parentID: session.parentID, title: session.title, agent: session.agent })))
      note("subagent", { ...row(fired), children, ownerMessages: await transcript(client, owner.id), newTurns: turns.slice(before) })
      await client.experimental.automation.delete({ automationID: created.id })
    }
  }

  if (wanted.has("rejected")) {
    // A launch that OpenCode refuses must not consume the change.
    const code = detectCode.replace('send: { prompt: "PASSAGE " + sha + " Review the new commits on dev." }', 'send: { prompt: "PASSAGE " + sha, to: { subagent: "no-such-agent" } }')
    const owner = await client.session.create({ location, title: "Refused launch" })
    const created = await attempt(() => client.experimental.automation.create({ sessionID: owner.id, name: "commits-refused", trigger: every, action: { type: "code", code, args: { url: forgeURL } } }))
    if (created.error) note("rejected", created)
    else {
      const baseline = await until("baseline", () => automation(client, created.id), ran)
      head = randomHead()
      const refused = await until("refused launch", () => automation(client, created.id), info => info.lastOutcome === "failed" || info.state?.passages === 1, 45_000).catch(failure => ({ timeout: String(failure.message).slice(0, 300) }))
      note("rejected", { head, baseline: row(baseline), refused: refused.timeout ? refused : row(refused) })
      await client.experimental.automation.delete({ automationID: created.id })
    }
  }

  if (wanted.has("busy") && observations.detectID) {
    // A change arrives while the previous passage still runs in the carrier conversation.
    const id = observations.detectID, carrier = observations.carrierID, start = turns.length
    const passages = (await automation(client, id)).state.passages
    holdMs = 50_000
    head = randomHead()
    await until("held passage starts", async () => turns.length, count => count > start, 40_000)
    holdMs = 0
    head = randomHead()
    const second = await until("second change while busy", () => automation(client, id), info => info.state?.passages === passages + 2 || info.lastOutcome !== "fired", 45_000).catch(failure => ({ timeout: String(failure.message).slice(0, 300) }))
    const inbox = await attempt(async () => (await client.session.inbox.list({ sessionID: carrier })).map?.(item => ({ id: item.id, type: item.type, delivery: item.delivery })) ?? "unreadable")
    const during = { row: second.timeout ? second : row(second), inbox, turns: turns.slice(start).map(turn => ({ ...turn })) }
    await until("held turn ends", async () => turns[start]?.endedAt, Boolean, 70_000)
    await delay(20_000)
    note("busy", { during, after: { row: row(await automation(client, id)), turns: turns.slice(start).map(turn => ({ ...turn })), carrierMessages: (await transcript(client, carrier)).slice(-6) } })
  }

  if (wanted.has("gate")) {
    // Strict non-overlap with public means: a change seen while the conversation works is left
    // unconsumed, so the first free run starts one passage for everything that arrived meanwhile.
    const code = `
const response = await fetch(args.url, { headers: { accept: "application/vnd.github.sha", "user-agent": "codenomad-proto" } })
if (!response.ok) throw new Error("forge " + response.status)
const sha = (await response.text()).trim()
if (!state) return { state: { sha, passages: 0, deferred: 0 } }
if (sha === state.sha) return
const answer = await tools.proto.passage_gate({ sha })
const gate = JSON.parse(typeof answer === "string" ? answer : answer.content ?? JSON.stringify(answer))
if (gate.busy) return { state: { ...state, deferred: state.deferred + 1, gate } }
return { state: { sha, passages: state.passages + 1, deferred: state.deferred, gate }, send: { prompt: "PASSAGE " + sha + " Review the new commits on dev." } }
`
    // The ungated calendar watches the same forge: keep it quiet so every recorded turn belongs to this conversation.
    if (observations.detectID) await client.experimental.automation.pause({ automationID: observations.detectID })
    const carrier = await client.session.create({ location, title: "Commits on dev, gated", permissions: [
      { action: "execute", resource: "*", effect: "allow" }, { action: "proto_passage_gate", resource: "*", effect: "allow" }] })
    const created = await attempt(() => client.experimental.automation.create({ sessionID: carrier.id, name: "commits-gated", trigger: every, action: { type: "code", code, args: { url: forgeURL } } }))
    if (created.error) note("gate", created)
    else {
      await until("gate baseline", () => automation(client, created.id), ran)
      const start = turns.length
      holdMs = 50_000
      head = randomHead(); const first = head
      const opened = await until("first gated passage", () => automation(client, created.id), info => info.state?.passages === 1 || info.lastOutcome === "failed", 40_000)
      await until("held gated turn", async () => turns.length, count => count > start, 20_000).catch(() => undefined)
      holdMs = 0
      head = randomHead(); const second = head
      const deferred = await until("deferral", () => automation(client, created.id), info => (info.state?.deferred ?? 0) >= 1 || info.state?.passages === 2 || info.lastOutcome === "failed", 45_000).catch(failure => ({ timeout: String(failure.message).slice(0, 300) }))
      const inbox = await attempt(async () => (await client.session.inbox.list({ sessionID: carrier.id })).map(item => item.id))
      const settled = await until("second gated passage", () => automation(client, created.id), info => info.state?.passages === 2 || info.lastOutcome === "failed", 110_000).catch(failure => ({ timeout: String(failure.message).slice(0, 300) }))
      await delay(3_000)
      note("gate", { first, second, opened: row(opened), deferred: deferred.timeout ? deferred : row(deferred), inboxWhileBusy: inbox,
        settled: settled.timeout ? settled : row(settled), turns: turns.slice(start).map(turn => ({ ...turn })) })
      await client.experimental.automation.delete({ automationID: created.id })
    }
    if (observations.detectID) await client.experimental.automation.resume({ automationID: observations.detectID })
  }

  if (wanted.has("restart") && observations.detectID) {
    // OpenCode stops, a commit lands, OpenCode comes back. Nothing else runs.
    const id = observations.detectID, before = await automation(client, id), turnsBefore = turns.length
    await daemon.stop()
    head = randomHead()
    await delay(35_000) // at least two missed runs
    const stoppedAt = Date.now()
    daemon = await startDaemon("2")
    const after = await until("detection after restart", () => automation(daemon.client, id), info => info.state?.passages === before.state.passages + 1, 90_000)
    await until("turn after restart", async () => turns.length, count => count > turnsBefore, 30_000).catch(() => undefined)
    note("restart", { before: row(before), after: row(after), detectedAfterMs: Date.now() - stoppedAt, missedRunsCounted: after.runCount - before.runCount, newTurns: turns.slice(turnsBefore) })
  }

  note("list", (await daemon.client.experimental.automation.list({})).map(info => ({ id: info.id, name: info.name, trigger: info.trigger, ...row(info) })))
} finally {
  await writeFile(path.join(root, "observations.json"), JSON.stringify(observations, null, 2))
  await daemon.stop().catch(() => {})
  provider.closeAllConnections(); forge.closeAllConnections()
  await new Promise(resolve => provider.close(resolve)); await new Promise(resolve => forge.close(resolve))
  console.log("observations:", path.join(root, "observations.json"))
}
