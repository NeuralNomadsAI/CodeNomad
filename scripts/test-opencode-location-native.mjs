// Native location authority fixture. Invoke with an absolute CLI path, or call
// testNativeLocationIdentity from an already-isolated native test. No discovery,
// shared daemon, user config or non-fixture database is ever used.
import assert from "node:assert/strict"
import { spawn, execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import { OpenCode } from "@opencode/client"
import { tsImport } from "tsx/esm/api"
import { testNativeWorktreeFamily } from "./test-worktree-families-native.mjs"
import { testNativeWorktreeManagement } from "./test-native-worktree-management.mjs"
import { testNativeEventRelay } from "./test-native-event-relay.mjs"

export async function testNativeLocationIdentity({ client, root, service }) {
  const { locationRequestOptions } = await tsImport("../packages/server/src/opencode/compatibility/location.ts", import.meta.url)
  const directory = path.join(root, `identity-project-${randomUUID()}`)
  const worktree = path.join(root, `identity-worktree-${randomUUID()}`)
  await mkdir(directory)
  const git = (...args) => execFileSync("git", args, { cwd: directory, stdio: "pipe" })
  git("init")
  git("config", "user.name", "CodeNomad isolated fixture")
  git("config", "user.email", "fixture@example.invalid")
  await writeFile(path.join(directory, "fixture.txt"), "synthetic native identity fixture\n")
  git("add", "fixture.txt")
  git("commit", "-m", "Synthetic native identity fixture")
  git("worktree", "add", "-b", "fixture-worktree", worktree)
  const rootLocation = await client.location.get({ location: { directory } })
  const worktreeLocation = await client.location.get({ location: { directory: worktree } })
  assert.equal(rootLocation.project.id, worktreeLocation.project.id)
  await testNativeEventRelay({ client, location: rootLocation, service })
  await testNativeWorktreeFamily({ client, rootLocation, worktreeLocation })
  await testNativeWorktreeManagement({ client, root })
  await assert.rejects(client.location.get({ location: { directory } }, locationRequestOptions({ directory, workspaceID: "wrk_fixture_one" })))
  console.log("PASS: native modern worktree location and obsolete-selector rejection")
}

export async function runIsolated(cli, run = testNativeLocationIdentity) {
  if (!cli || !path.isAbsolute(cli)) throw new Error("Pass an absolute isolated CLI executable path")
  const temporaryRoot = path.join(os.tmpdir(), "opencode")
  await mkdir(temporaryRoot, { recursive: true })
  const root = await mkdtemp(path.join(temporaryRoot, "codenomad-location-native-"))
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("OPENCODE_") && !key.startsWith("XDG_")))
  for (const key of ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) env[key] = path.join(root, key)
  const password = randomUUID()
  Object.assign(env, {
    HOME: root, USERPROFILE: root, OPENCODE_TEST_HOME: root,
    OPENCODE_DB: path.join(root, "fixture.db"), OPENCODE_CONFIG_DIR: path.join(root, "config"),
    OPENCODE_SERVER_PASSWORD: password, OPENCODE_CONFIG_PROJECT_DISABLE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_FFF: "1", OPENCODE_CONFIG_CONTENT: "{}",
  })
  await mkdir(env.OPENCODE_CONFIG_DIR)
  let output = ""
  const child = spawn(cli, ["serve", "--hostname", "127.0.0.1", "--port", "0", "--log-level", "debug", "--print-logs"], {
    cwd: root, env, windowsHide: true,
  })
  const stopped = new Promise(resolve => child.once("close", resolve))
  child.stdout.on("data", data => { output += data })
  child.stderr.on("data", data => { output += data })
  console.log(`Isolated location fixture: ${root}`)
  try {
    const deadline = Date.now() + 30_000
    while (!/http:\/\/127\.0\.0\.1:\d+/.test(output)) {
      if (child.exitCode !== null || Date.now() > deadline) throw new Error(`Isolated daemon failed to start: ${output}`)
      await delay(20)
    }
    const baseUrl = output.match(/http:\/\/127\.0\.0\.1:\d+/)[0]
    const { OpenCodeCliService } = await tsImport("../packages/server/src/workspaces/opencode-cli-service.ts", import.meta.url)
    const { runtimeIdentity } = await tsImport("../packages/server/src/opencode/compatibility/runtime.ts", import.meta.url)
    // Replace only CLI discovery; exercise production authenticated health probes.
    const lifecycle = new OpenCodeCliService({ label: "Fixture", timeoutMs: 30_000,
      command: args => ({ command: cli, args, options: {} }),
    }, { execFile: async (_file, args) => ({ stdout: args.at(-1) === "password" ? password : baseUrl, stderr: "" }) })
    const endpoint = await lifecycle.discover()
    const identity = runtimeIdentity(endpoint)
    const { createRuntimeTransport } = await tsImport("../packages/server/src/opencode/compatibility/transport.ts", import.meta.url)
    const transport = createRuntimeTransport(endpoint)
    const client = OpenCode.make({ baseUrl, fetch: transport.fetch })
    const connection = { endpoint, client, ...transport, assertCurrent() {}, invalidate() {} }
    console.log(`Testing official runtime ${identity.version}`)
    assert.equal((await client.server.info()).version, identity.version)
    console.log(`PASS: production ${identity.discovery} discovery and canonical client.server.info()`)
    await run({ client, connection, root })
  } finally {
    child.kill()
    await stopped
    await writeFile(path.join(root, "daemon.log"), output)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runIsolated(process.argv[2])
