import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import os from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { OpenCode } from "@opencode/client"
import { clearFixtureGitEnvironment, stopFixtureChild } from "./native-fixture-guards.mjs"

/** The resolved `opencode` folder fixtures are created in. With `projectConfig` the daemon reads
 * every ancestor's `.opencode/`, so outside CI it must lie outside the user's home. */
export async function fixtureParent({ projectConfig = false } = {}) {
  const requested = path.join(projectConfig && process.env.CODENOMAD_NATIVE_FIXTURE_PARENT || os.tmpdir(), "opencode")
  await mkdir(requested, { recursive: true })
  // The resolved path is both checked and used, so a link out of the home cannot reintroduce its ancestors.
  const parent = await realpath(requested)
  if (projectConfig && !process.env.CI) {
    const relative = path.relative(await realpath(os.homedir()), parent)
    assert(path.isAbsolute(relative) || relative.split(path.sep)[0] === "..",
      "Project-config fixtures read every ancestor directory: set CODENOMAD_NATIVE_FIXTURE_PARENT outside your home")
  }
  return parent
}

// Shared by product-contract fixtures. Explicit owned process, random password,
// private discovery/database/home, and a loopback synthetic provider only.
// `projectConfig` lets the daemon read a fixture project's own `.opencode/` folder. Project discovery
// walks every ancestor directory, so outside CI the fixture must live outside the user's home
// (`CODENOMAD_NATIVE_FIXTURE_PARENT`), or it would read the user's own agents and skills.
export async function withProductRuntime(cli, prepare, run, { projectConfig = false } = {}) {
  assert(cli && path.isAbsolute(cli), "Pass an absolute isolated CLI executable path")
  const root = await mkdtemp(path.join(await fixtureParent({ projectConfig }), "product-native-"))
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(OPENCODE_|XDG_|npm_config_)/i.test(key)))
  // Inherited GIT_* variables would redirect the daemon's Git or expose the user's Git configuration.
  clearFixtureGitEnvironment(env)
  for (const key of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) env[key] = path.join(root, key)
  // 2.0.29+ reads system-managed settings from %ProgramData%\opencode on Windows.
  if (process.platform === "win32") {
    for (const key of Object.keys(env)) if (key.toLowerCase() === "programdata") delete env[key]
    env.ProgramData = path.join(root, "ProgramData")
  }
  const password = randomUUID()
  Object.assign(env, { HOME: root, USERPROFILE: root, OPENCODE_TEST_HOME: root,
    OPENCODE_CONFIG_DIR: path.join(root, "config"), OPENCODE_DB: path.join(root, "fixture.db"),
    ...(projectConfig ? {} : { OPENCODE_CONFIG_PROJECT_DISABLE: "1" }), OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_FFF: "1",
    OPENCODE_SERVER_PASSWORD: password })
  Object.assign(env, { npm_config_userconfig: path.join(root, ".npmrc"), npm_config_globalconfig: path.join(root, "global.npmrc"), npm_config_cache: path.join(root, "npm-cache") })
  await mkdir(env.OPENCODE_CONFIG_DIR)
  assert(Object.keys(env).every(key => !/^GIT_/i.test(key)), "The fixture daemon never inherits GIT_* variables")
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
    const endpoint = { url: output.match(/http:\/\/127\.0\.0\.1:\d+/)[0], auth: { type: "basic", username: "opencode", password } }
    const boundedFetch = (url, init) => fetch(url, { ...init, signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(30_000)]) })
    const client = OpenCode.make({ baseUrl: endpoint.url,
      headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` }, fetch: boundedFetch })
    await run({ client, root, requests, connection: { endpoint, client, fetch: boundedFetch, assertCurrent() {} } })
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
