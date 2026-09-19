import assert from "node:assert/strict"
import { spawn, execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { tsImport } from "tsx/esm/api"
import { OpenCode } from "@opencode/client"

// Explicit executable + private home/database: never discovers the user's daemon.
const cli = process.argv[2]
if (!cli || !path.isAbsolute(cli)) throw new Error("Pass an absolute isolated CLI executable path")
const temporaryRoot = path.join(os.tmpdir(), "opencode")
await mkdir(temporaryRoot, { recursive: true })
const root = await mkdtemp(path.join(temporaryRoot, "fork-native-"))
const { forkAfterMessage } = await tsImport("../packages/ui/src/stores/session-fork.ts", import.meta.url)
const { createRuntimeFetch } = await tsImport("../packages/server/src/opencode/compatibility/transport.ts", import.meta.url)
const { rememberRuntime, contractProfile, runtimeIdentity } = await tsImport("../packages/server/src/opencode/compatibility/runtime.ts", import.meta.url)
const { locationRequestOptions } = await tsImport("../packages/server/src/opencode/compatibility/location.ts", import.meta.url)
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(OPENCODE_|XDG_)/i.test(key)))
for (const key of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) env[key] = path.join(root, key)
const password = randomUUID()
Object.assign(env, { HOME: root, USERPROFILE: root, OPENCODE_TEST_HOME: root,
  OPENCODE_CONFIG_DIR: path.join(root, "config"), OPENCODE_DB: path.join(root, "fixture.db"),
  OPENCODE_CONFIG_CONTENT: "{}", OPENCODE_CONFIG_PROJECT_DISABLE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1",
  OPENCODE_DISABLE_FFF: "1", OPENCODE_SERVER_PASSWORD: password })
await mkdir(env.OPENCODE_CONFIG_DIR)
let output = "", spawnError
const child = spawn(cli, ["serve", "--hostname", "127.0.0.1", "--port", "0", "--print-logs"], { cwd: root, env, windowsHide: true })
const stopped = new Promise(resolve => child.once("close", resolve))
child.on("error", error => { spawnError = error })
child.stdout.on("data", data => { output += data })
child.stderr.on("data", data => { output += data })
try {
  const deadline = Date.now() + 30000
  while (!/http:\/\/127\.0\.0\.1:\d+/.test(output)) {
    if (spawnError) throw spawnError
    if (Date.now() > deadline || child.exitCode !== null) throw new Error(output)
    await delay(20)
  }
  const endpoint = { url: output.match(/http:\/\/127\.0\.0\.1:\d+/)[0], auth: { type: "basic", username: "opencode", password } }
  const version = execFileSync(cli, ["--version"], { cwd: root, env, encoding: "utf8", windowsHide: true }).trim().split(/\s+/).at(-1).replace(/^v/, "")
  rememberRuntime(endpoint, { version, pid: child.pid, discovery: "status" })
  const client = OpenCode.make({ baseUrl: endpoint.url, fetch: createRuntimeFetch(endpoint) })
  const location = { directory: root, ...(contractProfile(runtimeIdentity(endpoint)) === "legacy" ? { workspaceID: "wrk_fork_fixture" } : {}) }
  const info = await client.session.create({ location }, locationRequestOptions(location))
  console.log(`OpenCode ${version}`)
  const model = { providerID: "fixture", id: "fixture" }
  const messages = [
    { id: "msg_user1", type: "user", text: "QUESTION_ONE", time: { created: 1 } },
    { id: "msg_assistant1", type: "assistant", agent: "build", model, content: [{ type: "text", text: "ANSWER_ONE" }], time: { created: 2, completed: 3 }, finish: "stop" },
    { id: "msg_hidden", type: "model-switched", model, time: { created: 4 } },
    { id: "msg_user2", type: "user", text: "QUESTION_TWO", time: { created: 5 } },
    { id: "msg_assistant2", type: "assistant", agent: "build", model, content: [{ type: "text", text: "ANSWER_TWO" }], time: { created: 6, completed: 7 }, finish: "stop" },
  ]
  await client.session.remove({ sessionID: info.id })
  const imported = await client.session.import({ info, messages })
  const actual = (await client.message.list({ sessionID: imported.id, order: "asc", limit: 100 })).data
  const contents = list => list.map(({ id, ...rest }) => rest)
  for (const index of [0, 1, 3, 4]) {
    // Force page crossings, including across a hidden native message.
    const paginated = { ...client, message: { ...client.message,
      list: input => client.message.list({ ...input, limit: 2 }) } }
    const fork = await forkAfterMessage(paginated, imported.id, actual[index].id, () => true)
    const copied = (await client.message.list({ sessionID: fork.id, order: "asc", limit: 100 })).data
    assert.deepEqual(contents(copied), contents(actual.slice(0, index + 1)))
    await client.session.remove({ sessionID: fork.id })
    console.log(`PASS native inclusive fork: ${actual[index].type} at ${index}`)
  }
  // Also exercise a user prompt as the last native message.
  const tail = await client.session.fork({ sessionID: imported.id, before: actual.at(-1).id })
  const tailMessages = (await client.message.list({ sessionID: tail.id, order: "asc", limit: 100 })).data
  const fork = await forkAfterMessage(client, tail.id, tailMessages.at(-1).id, () => true)
  assert.deepEqual(contents((await client.message.list({ sessionID: fork.id, order: "asc", limit: 100 })).data), contents(tailMessages))
  assert.deepEqual((await client.message.list({ sessionID: imported.id, order: "asc", limit: 100 })).data, actual)
  console.log("PASS native user tail, source preserved, no provider requests")
} finally {
  child.kill()
  await stopped
  await writeFile(path.join(root, "daemon.log"), output)
  console.log(`Isolated fixture: ${root}`)
}
