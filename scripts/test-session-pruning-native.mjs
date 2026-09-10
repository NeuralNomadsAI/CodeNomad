// Explicit opt-in integration test. Never uses service discovery or a user DB.
import assert from "node:assert/strict"
import { spawn, execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { createServer } from "node:http"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { OpenCode } from "@opencode-ai/client"

const cli = process.argv[2]
if (!cli || !path.isAbsolute(cli)) throw new Error("Pass an absolute path to the isolated beta-19419 CLI executable")
assert.equal(execFileSync(cli, ["--version"], { encoding: "utf8" }).trim().replace(/^opencode2 v/, ""), "0.0.0-beta-19419")
const pluginDirectory = process.argv[3] ?? fileURLToPath(new URL("../packages/server/src/opencode/session-pruning/", import.meta.url))
if (!path.isAbsolute(pluginDirectory)) throw new Error("Plugin directory must be absolute")
const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-pruning-native-"))
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("OPENCODE_") && !key.startsWith("XDG_")))
for (const key of ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) env[key] = path.join(root, key)
Object.assign(env, {
  USERPROFILE: root, HOME: root, OPENCODE_TEST_HOME: root,
  OPENCODE_CONFIG_DIR: path.join(root, "config"), OPENCODE_DB: path.join(root, "test.db"),
  OPENCODE_SERVER_PASSWORD: "isolated-pruning-fixture", OPENCODE_CONFIG_PROJECT_DISABLE: "1",
  OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_FILEWATCHER: "1", OPENCODE_DISABLE_FFF: "1",
})
await mkdir(env.OPENCODE_CONFIG_DIR)
await mkdir(path.join(root, "plugin"))
const requests = []
let primaryCount = 0
let held
let releaseProvider
const provider = createServer(async (request, response) => {
  let raw = ""
  for await (const chunk of request) raw += chunk
  const body = JSON.parse(raw)
  const kind = request.headers["x-pruning-test-kind"]
  const text = kind === "compaction"
    ? ["## Objective", "## Requirements", "## Decisions", "## Work State", "### Completed", "### Active", "### Blocked", "## Next Move", "## Relevant Files", "## Important Context"].map(heading => `${heading}\n- Fixture`).join("\n\n")
    : "Retain this conclusion"
  requests.push({ kind, body })
  if (kind === "primary" && held) await held
  if (!body.stream) {
    response.setHeader("Content-Type", "application/json")
    response.end(JSON.stringify({ id: "aux", choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
    return
  }
  const tool = kind === "primary" && primaryCount++ === 0
  response.setHeader("Content-Type", "text/event-stream")
  const chunk = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({
    id: "fixture", object: "chat.completion.chunk", model: "fixture",
    choices: [{ index: 0, delta, finish_reason }],
    ...(finish_reason ? { usage: { prompt_tokens: 30, completion_tokens: 5, total_tokens: 35 } } : {}),
  })}\n\n`)
  chunk({ role: "assistant" })
  if (tool) {
    chunk({ reasoning_content: "REASONING_PRUNING_CANARY" })
    chunk({ tool_calls: [{ index: 0, id: "fixture-call", type: "function", function: { name: "prune_probe", arguments: "{}" } }] })
  } else chunk({ content: text })
  chunk({}, tool ? "tool_calls" : "stop")
  response.end("data: [DONE]\n\n")
})
await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve))
await writeFile(path.join(root, "plugin", "index.ts"), `
export default { id:'pruning-test-fixture', async setup(ctx) {
  await ctx.session.hook('http.request', event => event.request.headers.set('x-pruning-test-kind', event.kind))
  await ctx.tool.transform(editor => editor.add({ name:'prune_probe', description:'Fixture', input:{type:'object',properties:{}}, options:{codemode:false}, execute:async()=>({content:'TOOL_PRUNING_CANARY'}) }))
} }
`)
env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
  model: "fixture/fixture",
  providers: { fixture: { package: "@opencode/ai/providers/openai-compatible", settings: {
    baseURL: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: "fixture-only",
  }, models: { fixture: {} } } },
  plugins: [path.join(root, "plugin"), { package: pluginDirectory, options: { databasePath: env.OPENCODE_DB, mode: "prune" } }],
})
let output = ""
function start() {
  const child = spawn(cli, ["serve", "--hostname", "127.0.0.1", "--port", "0", "--log-level", "debug", "--print-logs"], { cwd: root, env, windowsHide: true })
  const stopped = new Promise(resolve => child.once("close", resolve))
  child.stdout.on("data", data => { output += data })
  child.stderr.on("data", data => { output += data })
  return { child, stopped }
}
let { child, stopped } = start()
let db
const streams = new AbortController()
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => [key, canonical(entry)])) : value
const revision = content => createHash("sha256").update(JSON.stringify(canonical(content))).digest("hex")
async function until(predicate) {
  for (let attempt = 0; attempt < 3000; attempt++) {
    if (await predicate()) return
    if (child.exitCode !== null) throw new Error("Isolated server exited early")
    await delay(20)
  }
  throw new Error("Isolated test condition timed out")
}
try {
  await until(() => /http:\/\/127\.0\.0\.1:\d+/.test(output))
  const baseUrl = output.match(/http:\/\/127\.0\.0\.1:\d+/)[0]
  const makeClient = () => OpenCode.make({ baseUrl, headers: {
    Authorization: `Basic ${Buffer.from("opencode:isolated-pruning-fixture").toString("base64")}`,
  } })
  const client = makeClient()
  assert.equal((await client.health.get()).version, "0.0.0-beta-19419")
  const location = { directory: root }
  const session = await client.session.create({ location })
  await until(async () => {
    const plugins = (await client.plugin.list({ location })).data
    const failed = plugins.filter(item => item.source.type !== "builtin" && item.state.status === "failed")
    if (failed.length) throw new Error(JSON.stringify(failed))
    return plugins.some(item => item.id === "codenomad-session-pruning" && item.state.status === "active")
  })
  const first = [], second = []
  const observe = (subscriber, events) => (async () => {
    for await (const event of subscriber.event.subscribe({ signal: streams.signal })) events.push(event)
  })().catch(error => { if (!streams.signal.aborted) throw error })
  const observers = [observe(client, first), observe(makeClient(), second)]
  await until(() => first.length && second.length)
  const wait = () => client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(20_000) })
  await client.session.prompt({ sessionID: session.id, text: "Use prune_probe, then conclude" })
  await wait()
  const messages = (await client.message.list({ sessionID: session.id, limit: 100, order: "asc" })).data
  const target = messages.find(message => message.type === "assistant" && message.content.some(part => part.type === "tool"))
  assert(target)
  const fork = await client.session.fork({ sessionID: session.id, boundary: { type: "before", messageID: messages.at(-1).id } })
  const forkTarget = (await client.message.list({ sessionID: fork.id, limit: 100, order: "asc" })).data.find(message => message.type === "assistant")
  assert.deepEqual(forkTarget.content, target.content)
  const preview = (await client.rpc.call({ rpcID: "codenomad.session-pruning", method: "preview", location, input: { sessionID: session.id, messageID: target.id } })).output
  assert.equal(preview.status, "preview")
  assert.equal(preview.liveMutation, true)
  assert.equal(preview.revision, revision(target.content))
  assert.deepEqual(preview.parts.map(part => part.type), ["reasoning", "tool"])
  const input = { sessionID: session.id, messageID: target.id, revision: preview.revision, indexes: [0] }
  const prune = () => client.rpc.call({ rpcID: "codenomad.session-pruning", method: "prune", location, input })
  db = new DatabaseSync(env.OPENCODE_DB)
  const claim = () => db.prepare("SELECT time_suspended FROM session_v2 WHERE id=?").get(session.id).time_suspended
  held = new Promise(resolve => { releaseProvider = resolve })
  const beforeBusy = requests.length
  await client.session.prompt({ sessionID: session.id, text: "In-flight proof" })
  await until(() => requests.slice(beforeBusy).some(item => item.kind === "primary"))
  assert.notEqual(claim(), null)
  assert.deepEqual((await prune()).output, { status: "blocked", reason: "maintenance_required" })
  releaseProvider(); held = undefined
  await wait()
  assert.equal(claim(), null)
  const result = (await prune()).output
  assert.equal(result.status, "pruned")
  assert.deepEqual((await prune()).output, result)
  await until(() => [first, second].every(events => events.some(event => event.type === "rpc.codenomad.session-pruning.pruned" && event.data.messageID === target.id)))
  assert.deepEqual((await client.session.message({ sessionID: session.id, messageID: target.id })).content, target.content.slice(1))
  // The second ordering: native admission begins while our write lock is held.
  db.exec("BEGIN IMMEDIATE")
  assert.equal(claim(), null)
  const before = requests.length
  const competing = client.session.prompt({ sessionID: session.id, text: "Reply after cleanup" })
  await delay(150)
  assert.equal(requests.length, before)
  db.prepare("UPDATE session_message SET data=json_set(data,'$.content',json('[]')) WHERE session_id=? AND id=?").run(session.id, target.id)
  db.exec("COMMIT")
  await competing; await wait()
  const next = requests.slice(before).filter(item => item.kind === "primary")
  assert(next.length > 0)
  assert(!JSON.stringify(next).includes("TOOL_PRUNING_CANARY"))
  assert(!JSON.stringify(next).includes("REASONING_PRUNING_CANARY"))
  assert(JSON.stringify(next).includes("Retain this conclusion"))
  assert.deepEqual((await client.session.message({ sessionID: session.id, messageID: target.id })).content, [])
  assert.deepEqual((await client.session.message({ sessionID: fork.id, messageID: forkTarget.id })).content, target.content, "parent cleanup does not alter a fork's independent copy")
  await client.session.compact({ sessionID: fork.id })
  await client.session.wait({ sessionID: fork.id }, { signal: AbortSignal.timeout(20_000) })
  const contextBefore = await client.session.context({ sessionID: fork.id })
  assert(contextBefore.some(message => message.type === "compaction" && message.status === "completed"))
  assert(!contextBefore.some(message => message.id === forkTarget.id))
  const historical = { sessionID: fork.id, messageID: forkTarget.id, revision: revision(forkTarget.content), indexes: [0, 1] }
  assert.equal((await client.rpc.call({ rpcID: "codenomad.session-pruning", method: "prune", location, input: historical })).output.status, "pruned")
  assert.deepEqual((await client.session.message({ sessionID: fork.id, messageID: forkTarget.id })).content, [])
  assert.deepEqual(await client.session.context({ sessionID: fork.id }), contextBefore, "deleting pre-compaction content does not rewrite or re-expand a summary")
  assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok")
  streams.abort(); await Promise.all(observers)
  db.close(); db = undefined
  child.kill(); await stopped
  await writeFile(path.join(root, "before-restart.log"), output)
  output = ""
  ;({ child, stopped } = start())
  await until(() => /http:\/\/127\.0\.0\.1:\d+/.test(output))
  const restarted = OpenCode.make({ baseUrl: output.match(/http:\/\/127\.0\.0\.1:\d+/)[0], headers: {
    Authorization: `Basic ${Buffer.from("opencode:isolated-pruning-fixture").toString("base64")}`,
  } })
  assert.deepEqual((await restarted.session.message({ sessionID: session.id, messageID: target.id })).content, [])
  assert.deepEqual((await restarted.session.message({ sessionID: fork.id, messageID: forkTarget.id })).content, [])
  assert.deepEqual(await restarted.session.context({ sessionID: fork.id }), contextBefore)
  console.log("PASS: native plugin preview/prune RPC, active-claim refusal, idempotent retry, two subscribers, competing prompt, next model payload, fork isolation, pre-compaction history and restart")
} finally {
  streams.abort(); releaseProvider?.()
  if (db?.isTransaction) db.exec("ROLLBACK")
  db?.close()
  child.kill(); await stopped
  provider.closeAllConnections(); provider.close()
  await writeFile(path.join(root, "server.log"), output)
  console.log(`Isolated fixture retained at ${root}`)
}
