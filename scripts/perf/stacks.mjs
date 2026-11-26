import { randomUUID } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { fixtureChildPid, spawnFixtureChild, stopFixtureChild } from "../native-fixture-guards.mjs"
import { createAttestedFetch, createStreamRedactor, fixtureAttestationEnv, redactSecrets, resolveLocalExecutable, withoutFixtureProxy } from "../native-fixture-http.mjs"
import { registerFixtureChild } from "../../packages/rune-app/fixtures/fixture-host.mjs"
import { privatePath } from "./isolation.mjs"
import { sleep } from "./lib.mjs"
import assert from "node:assert/strict"

export const assetsDirectory = tree => path.join(tree, "packages/ui/src/renderer/dist/assets")

export async function withBackend(daemon, tree, root, followLongReplies, run, {rustBinary} = {}) {
  root = privatePath(root)
  await mkdir(root, { recursive: true })
  const password = randomUUID()
  const config = path.join(root, "server.yaml")
  await writeFile(config, JSON.stringify({ server: { opencodeBinary: daemon.cli, updateFeed: "stable" } }))
  const resolvedRust = rustBinary ? resolveLocalExecutable(rustBinary, "Rust benchmark binary") : undefined
  const command = resolvedRust ? [resolvedRust, [daemon.project, path.join(root, "identity.json"), "0", daemon.cli]] : [process.execPath, [
    fileURLToPath(new URL("./ts-wrapper.mjs", import.meta.url)),
    "--http", "true", "--http-port", "0", "--https", "false", "--host", "127.0.0.1", "--ui-no-update",
    "--ui-dir", path.dirname(assetsDirectory(tree)), "--config", config, "--workspace-root", daemon.project,
  ]]
  const group = process.platform !== "win32"
  const child = spawnFixtureChild(...command, { env: withoutFixtureProxy({ ...daemon.env, CLI_CONFIG: config, PERF_SERVER_DIST: fileURLToPath(new URL("../../packages/server/dist", import.meta.url)),
    PERF_DAEMON_URL: daemon.url, PERF_DAEMON_PID: String(daemon.pid), CODENOMAD_SERVER_PASSWORD: password,
    ...(resolvedRust
      ? {CNRS_FIXTURE_URL: daemon.relayUrl ?? daemon.url, CNRS_FIXTURE_PASSWORD: daemon.relayPassword ?? daemon.password, CNRS_SERVER_PASSWORD: password, CNRS_FIXTURE_STDIN_STOP: "1"}
      : {OPENCODE_SERVER_PASSWORD: daemon.password, ...fixtureAttestationEnv(process.env)}),
    CODENOMAD_REMOTE_CONTROL: "disabled" }), cwd: root, detached: group, windowsHide: true, stdio: [resolvedRust ? "pipe" : "ignore", "pipe", "pipe"] })
  const startedBy = new Date()
  const outRedactor = createStreamRedactor([password, daemon.password])
  const errRedactor = createStreamRedactor([password, daemon.password])
  let output = "", stdout = "", spawnError, completed = false, backendFetch
  const appendOut = chunk => { if (chunk) { stdout = (stdout + chunk).slice(-500_000); output = (output + chunk).slice(-500_000) } }
  const appendErr = chunk => { if (chunk) output = (output + chunk).slice(-500_000) }
  const currentStdout = () => stdout + outRedactor.peek()
  const currentOutput = () => output + outRedactor.peek() + errRedactor.peek()
  const stopped = new Promise(resolve => child.once("close", code => {
    appendOut(outRedactor.flush())
    appendErr(errRedactor.flush())
    resolve(code)
  }))
  if (resolvedRust) daemon.allowRelayClient?.(fixtureChildPid(child), stopped)
  const untrack = registerFixtureChild(() => stopFixtureChild(child, stopped, 1_000, 2_000, { group, startedBy }))
  void stopped.finally(untrack)
  const sanitize = text => redactSecrets(text, [password, daemon.password])
  child.on("error", error => { spawnError = error })
  child.stdout.on("data", bytes => appendOut(outRedactor.push(bytes)))
  child.stderr.on("data", bytes => appendErr(errRedactor.push(bytes)))
  try {
    const deadline = Date.now() + 60_000
    let origin
    while (!(origin = currentStdout().match(resolvedRust ? /^(http:\/\/127\.0\.0\.1:\d+)\r?\n/m : /Local Connection URL\s*:\s*(http:\/\/127\.0\.0\.1:\d+)\r?\n/)?.[1])) {
      if (spawnError) throw spawnError
      if (child.exitCode !== null || child.signalCode !== null || Date.now() >= deadline) {
        throw Error(`CodeNomad failed to start (${child.exitCode ?? child.signalCode ?? "timeout"}): ${sanitize(currentOutput().slice(-3000))}`)
      }
      await sleep(50)
    }
    const backendPid = await fixtureChildPid(child)
    backendFetch = createAttestedFetch(origin, Number(new URL(origin).port), backendPid)
    const request = (route, method, body, cookie) => backendFetch(`${origin}${route}`, {
      method, headers: { origin, "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body), signal: AbortSignal.timeout(30_000),
    })
    const response = await request("/api/auth/login", "POST", { username: "codenomad", password })
    const cookie = response.headers.get("set-cookie")?.split(";", 1)[0]
    if (!response.ok || !cookie?.startsWith("codenomad_session=")) throw Error(`CodeNomad login failed (${response.status})`)
    const patched = await request("/api/storage/state/ui", "PATCH", {
      recentFolders: [{ path: daemon.project, projectName: "project", lastAccessed: Date.now() }],
    }, cookie)
    if (!patched.ok) throw Error(`Could not set recent folder (${patched.status})`)
    if (followLongReplies) {
      const setting = await request("/api/storage/config/ui", "PATCH", { settings: { holdLongAssistantReplies: false } }, cookie)
      if (!setting.ok) throw Error(`Could not enable long-reply following (${setting.status})`)
    }
    await run(origin, cookie.slice(cookie.indexOf("=") + 1), {password, backendPid, fetch: backendFetch})
    completed = true
  } finally {
    await backendFetch?.close().catch(() => {})
    let graceful = false
    if (resolvedRust && child.exitCode === null) {
      child.stdin.on("error", () => {})
      child.stdin.end("shutdown\n")
      await Promise.race([stopped, sleep(15_000, undefined, {ref: false})])
      graceful = child.exitCode === 0 && child.signalCode === null
    }
    try { await stopFixtureChild(child, stopped, 1_000, 2_000, { group, startedBy }) } finally {
      await writeFile(path.join(root, "server.log"), sanitize(output))
      if(resolvedRust)await writeFile(path.join(root,"server-lifecycle.json"),JSON.stringify({completed,shutdown:"shutdown",graceful,exitCode:child.exitCode,signal:child.signalCode},null,2))
    }
    if(resolvedRust && completed)assert(graceful,"Rust benchmark server must acknowledge shutdown by exiting 0 without forced cleanup")
  }
}
