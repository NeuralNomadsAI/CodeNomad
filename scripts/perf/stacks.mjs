import { randomUUID } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawnFixtureChild as spawn, stopFixtureChild } from "../native-fixture-guards.mjs"
import { privatePath } from "./isolation.mjs"
import { sleep } from "./lib.mjs"
import assert from "node:assert/strict"

export const assetsDirectory = tree => path.join(tree, "packages/ui/src/renderer/dist/assets")

export async function withBackend(daemon, tree, root, followLongReplies, run, {rustBinary} = {}) {
  root = privatePath(root)
  await mkdir(root, { recursive: true })
  const password = randomUUID()
  const config = path.join(root, "server.yaml")
  await writeFile(config, JSON.stringify({ server: { opencodeBinary: daemon.cli } }))
  if (rustBinary) assert(path.isAbsolute(rustBinary), "Rust benchmark binary must be absolute")
  const command = rustBinary ? [rustBinary, [daemon.project, path.join(root, "identity.json"), "0", daemon.cli]] : [process.execPath, [
    fileURLToPath(new URL("./ts-wrapper.mjs", import.meta.url)),
    "--http", "true", "--http-port", "0", "--https", "false", "--host", "127.0.0.1", "--ui-no-update",
    "--ui-dir", path.dirname(assetsDirectory(tree)), "--config", config, "--workspace-root", daemon.project,
  ]]
  const child = spawn(...command, { env: { ...daemon.env, CLI_CONFIG: config, PERF_SERVER_DIST: fileURLToPath(new URL("../../packages/server/dist", import.meta.url)),
    PERF_DAEMON_URL: daemon.url, PERF_DAEMON_PID: String(daemon.pid), CODENOMAD_SERVER_PASSWORD: password,
    ...(rustBinary && {CNRS_FIXTURE_URL: daemon.url, CNRS_FIXTURE_PASSWORD: daemon.password, CNRS_SERVER_PASSWORD: password, CNRS_FIXTURE_STDIN_STOP: "1"}),
    CODENOMAD_REMOTE_CONTROL: "disabled" }, cwd: root, windowsHide: true, stdio: [rustBinary ? "pipe" : "ignore", "pipe", "pipe"] })
  const stopped = new Promise(resolve => child.once("close", resolve))
  let output = "", spawnError, completed = false
  child.on("error", error => { spawnError = error })
  for (const pipe of [child.stdout, child.stderr]) pipe.on("data", bytes => { output = (output + bytes).slice(-500_000) })
  try {
    const deadline = Date.now() + 60_000
    let origin
    while (!(origin = output.match(rustBinary ? /^(http:\/\/127\.0\.0\.1:\d+)\r?$/m : /Local Connection URL\s*:\s*(http:\/\/127\.0\.0\.1:\d+)/)?.[1])) {
      if (spawnError) throw spawnError
      if (child.exitCode !== null || child.signalCode !== null || Date.now() >= deadline) {
        throw Error(`CodeNomad failed to start (${child.exitCode ?? child.signalCode ?? "timeout"}): ${output.slice(-3000)}`)
      }
      await sleep(50)
    }
    const request = (route, method, body, cookie) => fetch(`${origin}${route}`, {
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
    await run(origin, cookie.slice(cookie.indexOf("=") + 1), {password})
    completed = true
  } finally {
    let graceful = false
    if (rustBinary && child.exitCode === null) {
      child.stdin.on("error", () => {})
      child.stdin.end("shutdown\n")
      await Promise.race([stopped, sleep(15_000, undefined, {ref: false})])
      graceful = child.exitCode === 0 && child.signalCode === null
    }
    try { await stopFixtureChild(child, stopped) } finally {
      await writeFile(path.join(root, "server.log"), output.replaceAll(password, "<fixture password>").replaceAll(daemon.password, "<fixture password>"))
      if(rustBinary)await writeFile(path.join(root,"server-lifecycle.json"),JSON.stringify({completed,shutdown:"shutdown",graceful,exitCode:child.exitCode,signal:child.signalCode},null,2))
    }
    if(rustBinary && completed)assert(graceful,"Rust benchmark server must acknowledge shutdown by exiting 0 without forced cleanup")
  }
}
