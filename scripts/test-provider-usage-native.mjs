// Pass an absolute 2.0.20+ CLI path. Only synthetic credentials in a fresh
// fixture database are written; no service discovery or shared daemon is used.
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { OpenCode } from "@opencode/client"
import { tsImport } from "tsx/esm/api"

const cli = process.argv[2]
assert.ok(cli && path.isAbsolute(cli), "Pass an absolute isolated CLI executable path")
const parent = path.join(os.tmpdir(), "opencode")
await mkdir(parent, { recursive: true })
const root = await mkdtemp(path.join(parent, "codenomad-usage-native-"))
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(OPENCODE_|XDG_|OPENAI_|CODEX_|ANTHROPIC_)/i.test(key)))
for (const key of ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "APPDATA", "LOCALAPPDATA"]) {
  env[key] = path.join(root, key)
  await mkdir(env[key], { recursive: true })
}
const password = randomUUID()
Object.assign(env, {
  HOME: root, USERPROFILE: root, OPENCODE_TEST_HOME: root,
  OPENCODE_DB: path.join(root, "fixture.db"), OPENCODE_CONFIG_DIR: path.join(root, "config"),
  OPENCODE_SERVER_PASSWORD: password, OPENCODE_CONFIG_PROJECT_DISABLE: "1",
  OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_FFF: "1",
  OPENCODE_CONFIG_CONTENT: JSON.stringify({ providers: { openai: { package: "@opencode/ai/providers/openai", models: { fixture: {} } } } }),
})
await mkdir(env.OPENCODE_CONFIG_DIR)
const child = spawn(cli, ["serve", "--hostname", "127.0.0.1", "--port", "0", "--log-level", "error", "--print-logs"], { cwd: root, env, windowsHide: true })
const stopped = new Promise(resolve => child.once("close", resolve))
let output = "", spawnError
child.on("error", error => { spawnError = error })
child.stdout.on("data", data => { output += data })
child.stderr.on("data", data => { output += data })
const result = { root, assertions: [] }
const originalFetch = globalThis.fetch
try {
  const deadline = Date.now() + 30_000
  while (!/http:\/\/127\.0\.0\.1:\d+/.test(output)) {
    if (spawnError || child.exitCode !== null || Date.now() > deadline) throw new Error("Isolated fixture failed to start")
    await delay(20)
  }
  const baseUrl = output.match(/http:\/\/127\.0\.0\.1:\d+/)[0]
  const client = OpenCode.make({ baseUrl, headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` } })
  result.version = (await client.server.info()).version
  const directory = path.join(root, "project")
  await mkdir(directory)
  const location = { directory }
  // Initialize native catalogues as the application does before model selection.
  await client.integration.list({ location })
  await client.provider.list({ location })
  const oauth = await client.credential.create({ integrationID: "openai", label: "Synthetic ChatGPT", activate: true,
    value: { type: "oauth", methodID: "chatgpt-headless", refresh: "synthetic-refresh-never-used", access: "synthetic-access-never-sent", expires: Date.now() + 3600_000, metadata: { accountID: "synthetic-account" } } })
  const provider = await client.provider.get({ providerID: "openai", location })
  assert.equal(provider.data.integrationID ?? "openai", "openai")
  assert.equal((await client.integration.get({ integrationID: "openai", location })).data.connections[0].id, oauth.id)
  const { createNativeCodexUsage } = await tsImport("../packages/server/src/usage/native-codex.ts", import.meta.url)
  const usage = createNativeCodexUsage()
  const connection = { client, assertCurrent() {} }
  const scope = { instanceId: "fixture", sessionId: "synthetic", directory: provider.location.directory, providerId: "openai", modelId: "fixture" }
  let quotaCalls = 0
  globalThis.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url === "https://chatgpt.com/backend-api/wham/usage") {
      quotaCalls++
      assert.equal(init.headers["ChatGPT-Account-Id"], "synthetic-account")
      assert.equal(init.headers.Authorization, "Bearer synthetic-access-never-sent")
      assert.equal(init.redirect, "error")
      return Response.json({ rate_limit: { primary_window: { limit_window_seconds: 18_000, used_percent: 25 } } })
    }
    assert.ok(url.startsWith(`${baseUrl}/`), "Fixture must not send provider credentials or access other services")
    return originalFetch(input, init)
  }
  const read = () => usage(connection, scope, AbortSignal.timeout(15_000))
  const fresh = await read()
  assert.equal(fresh.ok, true)
  assert.equal(fresh.windows["5h"].usedPercent, 25)
  assert.equal(JSON.stringify(fresh).includes("synthetic-access"), false)
  assert.equal((await read()).ok, true)
  assert.equal(quotaCalls, 1, "Warm normalized snapshot should share the same account")
  result.assertions.push("Production quota adapter reads real native selected OAuth and accountID; only normalized snapshots are cached")
  const key = await client.credential.create({ integrationID: "openai", label: "Synthetic API key", activate: true, value: { type: "key", key: "synthetic-key-never-sent" } })
  assert.equal((await client.integration.get({ integrationID: "openai", location })).data.connections[0].id, key.id)
  assert.equal((await read()).ok, false)
  assert.equal(quotaCalls, 1, "An active key must not use a warm inactive OAuth snapshot")
  result.assertions.push("Native account switch revokes warm quota and never substitutes inactive OAuth")
  const stalePath = path.join(env.XDG_DATA_HOME, "opencode", "auth.json")
  await mkdir(path.dirname(stalePath), { recursive: true })
  await writeFile(stalePath, JSON.stringify({ openai: { type: "oauth", access: "synthetic-stale-file", refresh: "synthetic-stale-refresh", expires: 1 } }))
  await client.credential.activate({ credentialID: oauth.id })
  assert.equal((await read()).ok, true)
  assert.equal(quotaCalls, 2)
  result.assertions.push("Native reactivation recovers despite a stale legacy file; no OAuth refresh or real quota request")
  result.success = true
} finally {
  globalThis.fetch = originalFetch
  if (child.pid) child.kill()
  await stopped
  // Never store exported credentials or raw native errors/logs.
  await writeFile(path.join(root, "results.json"), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
}
