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

// Shared by product-contract fixtures. Explicit owned process, random password,
// private discovery/database/home, and a loopback synthetic provider only.
export async function withProductRuntime(cli, prepare, run) {
  assert(cli && path.isAbsolute(cli), "Pass an absolute isolated CLI executable path")
  const parent = path.join(os.tmpdir(), "opencode")
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(path.join(parent, "product-native-"))
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(OPENCODE_|XDG_)/i.test(key)))
  for (const key of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) env[key] = path.join(root, key)
  const password = randomUUID()
  Object.assign(env, { HOME: root, USERPROFILE: root, OPENCODE_TEST_HOME: root,
    OPENCODE_CONFIG_DIR: path.join(root, "config"), OPENCODE_DB: path.join(root, "fixture.db"),
    OPENCODE_CONFIG_PROJECT_DISABLE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_FFF: "1",
    OPENCODE_SERVER_PASSWORD: password })
  await mkdir(env.OPENCODE_CONFIG_DIR)
  const configuration = await prepare({ root, configDirectory: env.OPENCODE_CONFIG_DIR })
  const requests = []
  let providerError
  const provider = createServer(async (req, res) => {
    try {
      let raw = ""
      for await (const chunk of req) raw += chunk
      requests.push(JSON.parse(raw))
      res.setHeader("Content-Type", "text/event-stream")
      for (const [delta, finish_reason] of [[{ role: "assistant", content: "FIXTURE_ANSWER" }, null], [{}, "stop"]]) {
        res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture",
          choices: [{ index: 0, delta, finish_reason }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`)
      }
      res.end("data: [DONE]\n\n")
    } catch (error) { providerError = error; res.destroy(error) }
  })
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve))
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ ...configuration, model: "fixture/fixture", providers: { fixture: {
    package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: "fixture-only" }, models: { fixture: {} },
  } } })
  let output = "", spawnError
  const child = spawn(cli, ["serve", "--hostname", "127.0.0.1", "--port", "0", "--print-logs"], { cwd: root, env, windowsHide: true })
  const stopped = new Promise(resolve => child.once("close", resolve))
  child.on("error", error => { spawnError = error })
  child.stdout.on("data", data => { output += data })
  child.stderr.on("data", data => { output += data })
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
    await run({ client, root, requests })
    if (providerError) throw providerError
  } finally {
    try { await stopFixtureChild(child, stopped) } finally {
      provider.closeAllConnections()
      await new Promise(resolve => provider.close(resolve))
      await writeFile(path.join(root, "daemon.log"), output)
      console.log(`Isolated fixture: ${root}`)
    }
  }
}
