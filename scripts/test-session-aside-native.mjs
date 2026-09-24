import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import os from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { OpenCode } from "@opencode/client"
import { stopFixtureChild } from "./native-fixture-guards.mjs"

// Explicit CLI, private home/database, local fake provider. Never discovers or
// connects to the shared daemon and never uses real provider credentials.
const cli = process.argv[2]
assert(cli && path.isAbsolute(cli), "Pass an absolute isolated CLI executable path")
const parent = path.join(os.tmpdir(), "opencode")
await mkdir(parent, { recursive: true })
const root = await mkdtemp(path.join(parent, "aside-native-"))
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(OPENCODE_|XDG_)/i.test(key)))
for (const key of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) env[key] = path.join(root, key)
const password = randomUUID()
Object.assign(env, { HOME: root, USERPROFILE: root, OPENCODE_TEST_HOME: root,
  OPENCODE_CONFIG_DIR: path.join(root, "config"), OPENCODE_DB: path.join(root, "fixture.db"),
  OPENCODE_CONFIG_PROJECT_DISABLE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_FFF: "1",
  OPENCODE_SERVER_PASSWORD: password })
await mkdir(env.OPENCODE_CONFIG_DIR)
let finishMain, providerError
const sideRequests = []
const provider = createServer(async (req, res) => {
  try {
    let raw = ""
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    const last = JSON.stringify(body.messages.at(-1))
    const side = last.includes("SIDE_QUESTION")
    if (side) sideRequests.push(body)
    if (!body.stream) {
      res.setHeader("Content-Type", "application/json")
      res.end(JSON.stringify({ id: "fixture", choices: [{ message: { role: "assistant", content: last.includes("SIDE_QUESTION") ? "SIDE_ANSWER" : "Fixture" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }))
      return
    }
    res.setHeader("Content-Type", "text/event-stream")
    const chunk = (delta, finish_reason = null) => res.write("data: " + JSON.stringify({
      id: "fixture", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta, finish_reason }],
      ...(finish_reason ? { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } } : {}),
    }) + "\n\n")
    chunk({ role: "assistant" })
    const finish = () => { chunk({ content: side ? "SIDE_ANSWER" : "MAIN_ANSWER" }); chunk({}, "stop"); res.end("data: [DONE]\n\n") }
    if (last.includes("MAIN_PENDING")) finishMain = finish
    else finish()
  } catch (error) { providerError = error; res.destroy(error) }
})
await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve))
env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ model: "fixture/fixture", providers: { fixture: {
  package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: "fixture-only" }, models: { fixture: {} },
} } })
let output = "", spawnError
const child = spawn(cli, ["serve", "--hostname", "127.0.0.1", "--port", "0", "--print-logs"], { cwd: root, env, windowsHide: true })
const stopped = new Promise(resolve => child.once("close", resolve))
child.on("error", error => { spawnError = error })
child.stdout.on("data", data => { output += data })
child.stderr.on("data", data => { output += data })
async function until(predicate) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (providerError) throw providerError
    if (spawnError) throw spawnError
    if (child.exitCode !== null) throw new Error(output)
    if (await predicate()) return
    await delay(25)
  }
  throw new Error(`Timed out: ${output.slice(-3000)}`)
}
try {
  await until(() => /http:\/\/127\.0\.0\.1:\d+/.test(output))
  const client = OpenCode.make({ baseUrl: output.match(/http:\/\/127\.0\.0\.1:\d+/)[0],
    headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
    fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(30_000)]) }),
  })
  const session = await client.session.create({ location: { directory: root } })
  await client.session.prompt({ sessionID: session.id, text: "CONTEXT_CANARY: explain the repository" })
  await client.session.wait({ sessionID: session.id })
  const messages = () => client.message.list({ sessionID: session.id, order: "asc", limit: 100 })
  const before = await messages()
  const answer = await client.session.generate({ sessionID: session.id, prompt: "SIDE_QUESTION: summarize the context without tools" })
  assert.equal(answer.text, "SIDE_ANSWER")
  assert.deepEqual(await messages(), before, "Side generation must not mutate history")
  assert.equal(sideRequests.length, 1)
  assert.match(JSON.stringify(sideRequests[0]), /CONTEXT_CANARY/)
  assert.match(JSON.stringify(sideRequests[0]), /MAIN_ANSWER/)
  console.log("PASS idle: native context reused, history unchanged")

  await client.session.prompt({ sessionID: session.id, text: "MAIN_PENDING: keep working" })
  await until(() => Boolean(finishMain))
  const activeBefore = await client.session.active()
  assert.ok(activeBefore[session.id], "Main session should still be active")
  assert.equal((await client.session.generate({ sessionID: session.id, prompt: "SIDE_QUESTION: what are you doing?" })).text, "SIDE_ANSWER")
  assert.ok((await client.session.active())[session.id], "Side generation must not interrupt the main session")
  assert.equal(sideRequests.length, 2)
  assert.match(JSON.stringify(sideRequests[1]), /MAIN_PENDING/)
  finishMain()
  finishMain = undefined
  await client.session.wait({ sessionID: session.id })
  assert.doesNotMatch(JSON.stringify(await messages()), /SIDE_QUESTION|SIDE_ANSWER/)
  const sessions = await client.session.list({ location: { directory: root } })
  assert.equal(sessions.data.length, 1, "No temporary or child session should be created")
  assert.equal((await client.session.inbox.list({ sessionID: session.id })).length, 0)
  console.log("PASS busy: main execution continues, no side messages, inbox entries or child sessions")
} finally {
  finishMain?.()
  try { await stopFixtureChild(child, stopped) } finally {
    provider.closeAllConnections()
    await new Promise(resolve => provider.close(resolve))
    await writeFile(path.join(root, "daemon.log"), output)
    console.log(`Isolated fixture: ${root}`)
  }
}
