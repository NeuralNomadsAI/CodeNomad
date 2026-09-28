import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import os from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { OpenCode } from "@opencode/client"
import toast from "solid-toast"
import { stopFixtureChild } from "./native-fixture-guards.mjs"
import { createClientSession } from "../packages/ui/src/types/session.ts"
import { sdkManager } from "../packages/ui/src/lib/sdk-manager.ts"
import { addInstance, removeInstance } from "../packages/ui/src/stores/instances.ts"
import { createSession } from "../packages/ui/src/stores/session-api.ts"
import { cleanupBlankSessions, sessions, setSessions } from "../packages/ui/src/stores/session-state.ts"

// node --conditions=browser --import tsx scripts/test-blank-session-cleanup-native.mjs <absolute CLI>
// All requests target this fixture's authenticated daemon and private storage.
const cli = process.argv[2]
assert(cli && path.isAbsolute(cli), "Pass an absolute isolated CLI executable path")
const parent = path.join(os.tmpdir(), "opencode")
await mkdir(parent, { recursive: true })
const root = await mkdtemp(path.join(parent, "blank-cleanup-native-"))
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(OPENCODE_|XDG_)/i.test(key)))
for (const key of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) env[key] = path.join(root, key)
const password = randomUUID()
Object.assign(env, { HOME: root, USERPROFILE: root, OPENCODE_TEST_HOME: root,
  OPENCODE_CONFIG_DIR: path.join(root, "config"), OPENCODE_DB: path.join(root, "fixture.db"),
  OPENCODE_CONFIG_PROJECT_DISABLE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_FFF: "1",
  OPENCODE_SERVER_PASSWORD: password })
await mkdir(env.OPENCODE_CONFIG_DIR)
let providerError
const provider = createServer(async (req, res) => {
  try {
    let raw = ""
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    if (!body.stream) {
      res.setHeader("Content-Type", "application/json")
      res.end(JSON.stringify({ id: "fixture", choices: [{ message: { role: "assistant", content: "Fixture" }, finish_reason: "stop" }] }))
      return
    }
    res.setHeader("Content-Type", "text/event-stream")
    for (const [delta, finish_reason] of [[{ role: "assistant", content: "Keep this reply" }, null], [{}, "stop"]]) {
      res.write("data: " + JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture",
        choices: [{ index: 0, delta, finish_reason }],
        ...(finish_reason ? { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } } : {}),
      }) + "\n\n")
    }
    res.end("data: [DONE]\n\n")
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
const instanceId = "blank-native"
const originalToast = toast.custom
toast.custom = () => "fixture-toast"
try {
  const deadline = Date.now() + 30_000
  while (!/http:\/\/127\.0\.0\.1:\d+/.test(output)) {
    if (spawnError) throw spawnError
    if (child.exitCode !== null || Date.now() > deadline) throw new Error(output.slice(-3000))
    await delay(25)
  }
  const client = OpenCode.make({ baseUrl: output.match(/http:\/\/127\.0\.0\.1:\d+/)[0],
    headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
    fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(30_000)]) }),
  })
  const used = await client.session.create({ location: { directory: root } })
  const blank = await client.session.create({ location: { directory: root } })
  await client.session.prompt({ sessionID: used.id, text: "Keep this conversation" })
  await client.session.wait({ sessionID: used.id })
  if (providerError) throw providerError
  const before = await client.message.list({ sessionID: used.id, limit: 100 })
  assert(before.data.some(message => message.type === "user"))
  assert(before.data.some(message => message.type === "assistant"))

  sdkManager.clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
  addInstance({ id: instanceId, folder: root, port: 0, pid: 0, proxyPath: "", status: "ready", client })
  // Reproduce the UI's unchanged creation snapshot, without loading its transcript.
  assert.equal(used.time.created, used.time.updated)
  setSessions(new Map([[instanceId, new Map([used, blank].map(info => [info.id, createClientSession(info, instanceId)]))]]))
  const created = await createSession(instanceId)
  await cleanupBlankSessions(instanceId, created.id)
  const remaining = await client.session.list({ directory: root, limit: 100 })
  assert(remaining.data.some(info => info.id === used.id), "Used session must remain in native storage")
  assert.ok(sessions().get(instanceId)?.has(used.id), "Used session must stay in the UI")
  assert.deepEqual(await client.message.list({ sessionID: used.id, limit: 100 }), before, "Native history must remain intact")
  await client.session.get({ sessionID: created.id })
  assert(!remaining.data.some(info => info.id === blank.id), "A genuinely blank session should still be deleted")
  console.log("PASS: native history retained despite equal UI timestamps; empty session deleted; new session excluded")
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  toast.custom = originalToast
  removeInstance(instanceId, { authoritative: false })
  sdkManager.destroyClientsForInstance(instanceId)
  try { await stopFixtureChild(child, stopped) } catch (error) {
    console.error(error)
    process.exitCode = 1
  } finally {
    provider.closeAllConnections()
    await new Promise(resolve => provider.close(resolve))
    await writeFile(path.join(root, "daemon.log"), output)
    console.log(`Isolated fixture: ${root}`)
  }
}
// The imported UI stores own application-lifetime timers. All fixture-owned
// native and HTTP resources have been explicitly stopped above.
process.exit(process.exitCode ?? 0)
