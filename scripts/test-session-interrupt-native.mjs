// Explicit isolated native regression: no service discovery or real provider.
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { OpenCode } from "@opencode/client"

const cli = process.argv[2]
if (!cli || !path.isAbsolute(cli)) throw new Error("Pass an absolute CLI path; shared service discovery is forbidden")
const temporary = path.join(os.tmpdir(), "opencode")
await mkdir(temporary, { recursive: true })
const root = await mkdtemp(path.join(temporary, "interrupt-native-"))
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(OPENCODE_|XDG_)/i.test(key)))
for (const key of ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) env[key] = path.join(root, key)
Object.assign(env, {
  HOME: root, USERPROFILE: root, OPENCODE_TEST_HOME: root,
  OPENCODE_CONFIG_DIR: path.join(root, "config"), OPENCODE_DB: path.join(root, "test.db"),
  OPENCODE_SERVER_PASSWORD: "interrupt-fixture", OPENCODE_CONFIG_PROJECT_DISABLE: "1",
  OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_FFF: "1",
})
await mkdir(env.OPENCODE_CONFIG_DIR)
await mkdir(path.join(root, "plugin"))
await writeFile(path.join(root, "plugin", "index.ts"), `export default { id: 'interrupt-fixture', async setup(ctx) {
  await ctx.session.hook('http.request', event => {
    event.request.headers.set('x-fixture-kind', event.kind)
    event.request.headers.set('x-fixture-session', event.sessionID)
  })
} }`)
const requests = new Map()
let parentID
let providerError
const provider = createServer(async (request, response) => {
  try {
    let raw = ""
    for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw)
    if (request.headers["x-fixture-kind"] !== "primary") {
      response.setHeader("Content-Type", "application/json")
      response.end(JSON.stringify({ id: "aux", choices: [{ message: { role: "assistant", content: "Fixture" }, finish_reason: "stop" }] }))
      return
    }
    const sessionID = request.headers["x-fixture-session"]
    const count = (requests.get(sessionID) ?? 0) + 1
    requests.set(sessionID, count)
    response.setHeader("Content-Type", "text/event-stream")
    const chunk = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({
      id: "fixture", object: "chat.completion.chunk", model: "fixture",
      choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`)
    chunk({ role: "assistant" })
    if (sessionID === parentID && count === 1) {
      const tool = body.tools.find(tool => tool.function?.name === "subagent")
      assert(tool, "Native subagent tool must be available")
      chunk({ tool_calls: [{ index: 0, id: "fixture-child", type: "function", function: {
        name: tool.function.name,
        arguments: JSON.stringify({ agent: "general", description: "Isolated interruption fixture", prompt: "Hold the response", background: true }),
      } }] })
      chunk({}, "tool_calls")
      response.end("data: [DONE]\n\n")
    }
    // Parent follow-up and child stream remain open until native interruption.
  } catch (error) { providerError = error; response.destroy(error) }
})
await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve))
env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
  model: "fixture/fixture", plugins: [path.join(root, "plugin")],
  providers: { fixture: { package: "@opencode/ai/providers/openai-compatible", settings: {
    baseURL: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: "fixture-only",
  }, models: { fixture: {} } } },
})
let output = ""
const child = spawn(cli, ["serve", "--hostname", "127.0.0.1", "--port", "0", "--print-logs"], { cwd: root, env, windowsHide: true })
const stopped = new Promise(resolve => child.once("close", resolve))
child.stdout.on("data", data => { output += data })
child.stderr.on("data", data => { output += data })
async function until(predicate) {
  for (let attempt = 0; attempt < 1000; attempt++) {
    if (providerError) throw providerError
    if (await predicate()) return
    if (child.exitCode !== null) throw new Error("Isolated native server exited")
    await delay(20)
  }
  throw new Error("Isolated condition timed out")
}
try {
  await until(() => /http:\/\/127\.0\.0\.1:\d+/.test(output))
  const client = OpenCode.make({ baseUrl: output.match(/http:\/\/127\.0\.0\.1:\d+/)[0], headers: {
    Authorization: `Basic ${Buffer.from("opencode:interrupt-fixture").toString("base64")}`,
  } })
  console.log("Runtime", (await client.server.info()).version)
  for (const cascade of [true, false]) {
    const session = await client.session.create({ location: { directory: root }, model: { providerID: "fixture", id: "fixture" } })
    parentID = session.id
    await client.session.prompt({ sessionID: parentID, text: "Start the background fixture" })
    await until(() => requests.get(parentID) === 2)
    const list = await client.session.list({ location: { directory: root } })
    const descendant = list.data.find(item => item.parentID === parentID)
    assert(descendant)
    await until(() => requests.has(descendant.id))
    if (cascade) {
      // Parallel HTTP requests need not reach the daemon in dispatch order:
      // model a child request delayed by proxy ownership validation.
      let parentSettled
      const settled = new Promise(resolve => { parentSettled = resolve })
      await Promise.all([descendant.id, parentID].map(async sessionID => {
        if (sessionID === descendant.id) await settled
        await client.session.interrupt({ sessionID })
        if (sessionID === parentID) {
          await client.session.wait({ sessionID }, { signal: AbortSignal.timeout(10_000) })
          parentSettled()
        }
      }))
      await until(() => requests.get(parentID) > 2)
      console.log("REPRODUCED: descendant interruption wakes the stopped parent")
    } else {
      await client.session.interrupt({ sessionID: parentID, resume: true })
      await client.session.wait({ sessionID: parentID }, { signal: AbortSignal.timeout(10_000) })
      await delay(500)
      assert.equal(requests.get(parentID), 2, "Selected-session stop must not restart parent")
      assert((await client.session.active())[descendant.id], "Background child remains independently owned")
      console.log("PASS: TUI-compatible selected-session interruption stays stopped")
    }
    await client.session.interrupt({ sessionID: descendant.id, resume: false })
    await client.session.wait({ sessionID: descendant.id }, { signal: AbortSignal.timeout(10_000) })
    await delay(200)
    await client.session.interrupt({ sessionID: parentID, resume: false })
  }
} catch (error) {
  await writeFile(path.join(root, "native.log"), output)
  console.error("Evidence:", root)
  throw error
} finally {
  child.kill()
  await stopped
  provider.closeAllConnections()
  await new Promise(resolve => provider.close(resolve))
}
