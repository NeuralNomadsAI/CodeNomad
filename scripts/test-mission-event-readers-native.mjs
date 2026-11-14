// node --import tsx scripts/test-mission-event-readers-native.mjs <isolated-cli> <fresh-approved-scratch>
import assert from "node:assert/strict"
import { spawn, execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createServer } from "node:http"
import { setTimeout as delay } from "node:timers/promises"
import { build } from "esbuild"
import { OpenCode } from "@opencode/client"
import { nativePluginBuild } from "../packages/server/scripts/native-plugin-build.mjs"
import { stopFixtureChild } from "./native-fixture-guards.mjs"

const [cli, root] = process.argv.slice(2), approved = path.resolve(process.env.LOCALAPPDATA, "codenomad-agent-scratch/issue-926/impl")
assert(cli && root && path.isAbsolute(cli) && path.isAbsolute(root) && !existsSync(root))
const relative = path.relative(approved, root)
assert(relative && /^(logic|fix-logic)[\\/]/.test(relative) && !path.isAbsolute(relative), "Use a fresh approved reader scratch child")
await mkdir(root, { recursive: true })
const project = path.join(root, "project"), plugin = path.join(root, "plugin")
await mkdir(project); await mkdir(plugin)
await build({ ...nativePluginBuild, entryPoints: [fileURLToPath(new URL("./fixtures/mission-event-readers-plugin.ts", import.meta.url))], outfile: path.join(plugin, "index.mjs") })
await writeFile(path.join(plugin, "package.json"), JSON.stringify({ name: "codenomad-event-readers-fixture", version: "1.0.0", type: "module", exports: "./index.mjs" }))
const git = (...args) => execFileSync("git", ["-C", project, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
git("init", "-b", "selected"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@invalid")
await writeFile(path.join(project, "included.txt"), "baseline"); git("add", "."); git("commit", "-m", "baseline")
const linked = path.join(root, "linked")
git("worktree", "add", "-b", "linked", linked)
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(SystemRoot|WINDIR|ComSpec|PATHEXT|PATH)$/i.test(key)))
for (const key of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "ProgramData", "TEMP", "TMP", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR"])
  env[key] = path.join(root, key)
Object.assign(env, { OPENCODE_TEST_HOME: root, OPENCODE_CONFIG_DIR: path.join(root, "config"), OPENCODE_DB: path.join(root, "fixture.db"),
  OPENCODE_CONFIG_PROJECT_DISABLE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_FFF: "1", OPENCODE_SERVER_PASSWORD: randomUUID(),
  npm_config_cache: path.join(root, "npm-cache"), npm_config_userconfig: path.join(root, "npmrc"), npm_config_globalconfig: path.join(root, "global-npmrc") })
for (const directory of [...Object.keys(env).filter(key => /^(HOME|USERPROFILE|APPDATA|LOCALAPPDATA|ProgramData|TEMP|TMP|XDG_.*|OPENCODE_CONFIG_DIR)$/.test(key)).map(key => env[key])]) await mkdir(directory, { recursive: true })
const requests = [], provider = createServer(async (request, response) => {
  let raw = ""; for await (const chunk of request) { raw += chunk; assert(raw.length <= 1024 * 1024) }
  requests.push(JSON.parse(raw)); response.writeHead(200, { "content-type": "text/event-stream" })
  for (const [delta, finish_reason] of [[{ role: "assistant", content: "Source finished" }, null], [{}, "stop"]])
    response.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
  response.end("data: [DONE]\n\n")
})
await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve))
env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ update: "disable", snapshots: false, plugins: [{ package: plugin }], model: "fixture/fixture",
  providers: { fixture: { package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: "fixture-only" }, models: { fixture: {} } } } })
const definition = { id: "codenomad.event-readers-qualification", methods: Object.fromEntries(["initialize", "read", "begin", "complete", "reserve", "settle", "edit", "race"]
  .map(key => [key, { input: { type: "object" }, output: { type: "object" } }])), events: {} }
let child, closed, client, rpc, generation = 0
const location = { directory: project }, receipt = { cases: [], serviceStarts: 0, stopped: [], backend: "absent", outcome: "running" }
async function start() {
  let output = ""
  child = spawn(cli, ["serve", "--hostname", "127.0.0.1", "--port", "0"], { cwd: project, env, windowsHide: true })
  closed = new Promise(resolve => child.once("close", resolve))
  child.stdout.on("data", data => { output += data }); child.stderr.on("data", data => { output += data })
  for (const end = Date.now() + 30_000; !/http:\/\/127\.0\.0\.1:\d+/.test(output);) {
    if (child.exitCode !== null || Date.now() > end) throw new Error(output.slice(-2000)); await delay(50)
  }
  client = OpenCode.make({ baseUrl: output.match(/http:\/\/127\.0\.0\.1:\d+/)[0], headers: { authorization: `Basic ${Buffer.from(`opencode:${env.OPENCODE_SERVER_PASSWORD}`).toString("base64")}` },
    fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(30_000)]) }) })
  rpc = client.rpc(definition)
  receipt.serviceStarts++; generation++
  return async () => {
    await stopFixtureChild(child, closed)
    receipt.stopped.push({ pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode })
    await writeFile(path.join(root, `daemon-${generation}.log`), output)
  }
}
async function quiet(sessionID, after = 0) {
  for (const end = Date.now() + 30_000; Date.now() < end;) {
    const messages = await client.message.list({ sessionID, limit: 32 })
    if (messages.data.some(item => item.type === "idle" && item.time.created >= after)) return
    await delay(100)
  }
  throw new Error("Fixture source terminal deadline")
}
const read = kind => rpc.read({ id: `target_${kind}` }, { location })
let stop
try {
  stop = await start()
  const conversation = await client.session.create({ location: { directory: linked }, title: "Followed source", agent: "build", model: { providerID: "fixture", id: "fixture" } })
  const beforePlay = Date.now()
  await client.session.prompt({ sessionID: conversation.id, text: "Existing message before first Play", delivery: "queue" })
  await quiet(conversation.id, beforePlay)
  await rpc.initialize({ conversationID: conversation.id, extraDirectory: linked }, { location })
  const kinds = ["schedule-success", "mission-completed", "branch-commits", "conversation-message", "files-changed"]
  for (const kind of kinds) assert.equal((await read(kind)).changed, false, `baseline ${kind}`)
  for (const id of ["source_recurring", "source_once"]) {
    receipt.phase = `source ${id}`
    const source = await rpc.begin({ id }, { location }); await quiet(source.sessionID); await rpc.complete({ id }, { location })
  }
  const afterPlay = Date.now()
  await client.session.prompt({ sessionID: conversation.id, text: "New followed message", delivery: "queue" }); await quiet(conversation.id, afterPlay)
  await writeFile(path.join(project, "included.txt"), "first event"); git("add", "included.txt"); git("commit", "-m", "event")
  for (const kind of kinds) { receipt.phase = `event ${kind}`; assert.equal((await read(kind)).changed, true, `event ${kind}`) }
  receipt.cases.push("five native readers observe explicit changes without backend")
  await stop(); stop = undefined
  stop = await start()
  for (const kind of kinds) assert.equal((await read(kind)).changed, true, `restart retains ${kind}`)
  receipt.cases.push("five persisted baselines survive service restart")
  receipt.cases.push("authorized linked-worktree conversation and one-time family use the native source Location")
  const file = "target_files-changed", frozen = await rpc.reserve({ id: file }, { location })
  await writeFile(path.join(project, "included.txt"), "new during pending")
  const settled = await rpc.settle({ id: file, completed: true }, { location })
  assert.deepEqual(settled.checkpoints, frozen.pending.checkpoints)
  assert.equal((await read("files-changed")).changed, true)
  const failed = await rpc.reserve({ id: file }, { location }), failure = await rpc.settle({ id: file, completed: false }, { location })
  assert.notDeepEqual(failure.checkpoints, failed.pending.checkpoints)
  assert.equal(failure.blocked, "failed")
  receipt.cases.push("pending consumes only its frozen proof on success; failure preserves prior proof")
  const original = { kind: "conversation-message", conversationID: conversation.id }
  await rpc.edit({ id: "target_conversation-message", condition: null }, { location })
  await rpc.edit({ id: "target_conversation-message", condition: original }, { location })
  assert.equal((await read("conversation-message")).changed, true)
  const race = await rpc.race({ id: file }, { location }); assert.deepEqual(race, { refused: true, revisionUnchanged: true })
  receipt.cases.push("remove/re-add retains exact conversation cursor; changed file refuses CAS")
  receipt.outcome = "passed"
} catch (error) {
  receipt.outcome = "failed"
  throw error
} finally {
  if (stop) await stop()
  else if (child?.exitCode === null) await stopFixtureChild(child, closed)
  provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve))
  receipt.providerClosed = !provider.listening
  receipt.providerRequests = requests.length
  await writeFile(path.join(root, "receipt.json"), JSON.stringify(receipt, null, 2))
  console.log(JSON.stringify(receipt, null, 2))
}
