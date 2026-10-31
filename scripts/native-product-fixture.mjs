import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import os from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { OpenCode } from "@opencode/client"
import { stopFixtureChild } from "./native-fixture-guards.mjs"

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

// Inherited only to run binaries: never provider credentials, cloud SDK settings, Git
// variables or user profile paths (a daemon reads all of them for provider discovery).
const INHERITED = /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|SYSTEMDRIVE|OS|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMW6432|COMMONPROGRAMFILES|COMMONPROGRAMFILES\(X86\)|COMMONPROGRAMW6432|LANG|LANGUAGE|LC_[A-Z_]+|TZ|CI|SHELL|USER|LOGNAME|TERM)$/i

/** The environment of a fixture-owned child: allowlisted process variables, then a private
 * home, profile, temp, XDG and npm tree under `root`, then `extra`. */
export async function fixtureEnvironment(root, extra = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => INHERITED.test(key)))
  const temp = path.join(root, "tmp")
  Object.assign(env, {
    HOME: root, USERPROFILE: root, OPENCODE_TEST_HOME: root,
    APPDATA: path.join(root, "AppData", "Roaming"), LOCALAPPDATA: path.join(root, "AppData", "Local"),
    // 2.0.29+ reads system-managed settings from %ProgramData%\opencode on Windows.
    ProgramData: path.join(root, "ProgramData"), TEMP: temp, TMP: temp, TMPDIR: temp,
    XDG_CONFIG_HOME: path.join(root, "XDG_CONFIG_HOME"), XDG_DATA_HOME: path.join(root, "XDG_DATA_HOME"),
    XDG_STATE_HOME: path.join(root, "XDG_STATE_HOME"), XDG_CACHE_HOME: path.join(root, "XDG_CACHE_HOME"),
    npm_config_userconfig: path.join(root, ".npmrc"), npm_config_globalconfig: path.join(root, "global.npmrc"), npm_config_cache: path.join(root, "npm-cache"),
    ...extra,
  })
  for (const directory of [env.APPDATA, env.LOCALAPPDATA, env.ProgramData, temp]) await mkdir(directory, { recursive: true })
  assertFixtureEnvironment(env)
  return env
}

/** Every key a fixture child receives from this process is allowlisted; the rest is the fixture's own. */
export function assertFixtureEnvironment(env) {
  const leaked = Object.keys(env).filter(key => process.env[key] !== undefined && process.env[key] === env[key] && !INHERITED.test(key))
  assert.deepEqual(leaked, [], "A fixture child inherits only allowlisted variables")
  assert(Object.keys(env).every(key => !/^(GIT_|CLOUDSDK_|GOOGLE_|AWS_|AZURE_)|_API_KEY$/i.test(key)), "No Git, cloud or provider credential variable reaches a fixture child")
}

/** Registers the fixture daemon where host-side discovery looks (`$XDG_STATE_HOME/opencode/service[-<name>].json`
 * of the fixture `env`), so a fixture host child finds this daemon and never the user's shared service. */
export async function writeFixtureServiceRegistration(env, { url, pid, version, password }, name) {
  const directory = path.join(env.XDG_STATE_HOME, "opencode")
  await mkdir(directory, { recursive: true })
  const file = path.join(directory, name ? `service-${name}.json` : "service.json")
  await writeFile(file, JSON.stringify({ url, pid, version, password }))
  return file
}

// Shared by product-contract fixtures. Explicit owned process, random password,
// private discovery/database/home, and a loopback synthetic provider only.
// `projectConfig` lets the daemon read a fixture project's own `.opencode/` folder. Project discovery
// walks every ancestor directory, so outside CI the fixture must live outside the user's home
// (`CODENOMAD_NATIVE_FIXTURE_PARENT`), or it would read the user's own agents and skills.
// `registry` points the daemon's package installs at a loopback fake npm registry
// (`npm_config_registry`), so package fixtures never reach the public registry.
// `run` also receives the daemon's `env`, the environment of every other fixture-owned child.
export async function withProductRuntime(cli, prepare, run, { projectConfig = false, registry } = {}) {
  assert(cli && path.isAbsolute(cli), "Pass an absolute isolated CLI executable path")
  assert(!registry || /^http:\/\/127\.0\.0\.1:\d+\/?$/.test(registry), "A fixture registry must be loopback")
  const root = await mkdtemp(path.join(await fixtureParent({ projectConfig }), "product-native-"))
  const password = randomUUID()
  const env = await fixtureEnvironment(root, {
    ...(registry ? { npm_config_registry: registry, npm_config_audit: "false", npm_config_fund: "false" } : {}),
    OPENCODE_CONFIG_DIR: path.join(root, "config"), OPENCODE_DB: path.join(root, "fixture.db"),
    ...(projectConfig ? {} : { OPENCODE_CONFIG_PROJECT_DISABLE: "1" }), OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_FFF: "1",
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
    const endpoint = { url: output.match(/http:\/\/127\.0\.0\.1:\d+/)[0], auth: { type: "basic", username: "opencode", password } }
    const boundedFetch = (url, init) => fetch(url, { ...init, signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(30_000)]) })
    const client = OpenCode.make({ baseUrl: endpoint.url,
      headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` }, fetch: boundedFetch })
    await run({ client, root, requests, env, connection: { endpoint, client, fetch: boundedFetch, assertCurrent() {} } })
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
