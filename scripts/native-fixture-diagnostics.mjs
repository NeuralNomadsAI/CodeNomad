import { appendFileSync, writeFileSync } from "node:fs"
import { mkdtemp, mkdir } from "node:fs/promises"
import { spawn } from "node:child_process"
import os from "node:os"
import path from "node:path"
import { channel } from "node:diagnostics_channel"
import { performance } from "node:perf_hooks"

export function fixtureChildState(child) {
  return { at: new Date().toISOString(), pid: child?.pid ?? null, exitCode: child?.exitCode ?? null,
    signalCode: child?.signalCode ?? null, killed: Boolean(child?.killed) }
}

// Only the private fixture's pending reload. bodySent confirms transport emission;
// sendHeaders alone precedes the socket write. Never retain headers, bodies or URLs.
export function observeFixtureReload(url) {
  const origin = new URL(url).origin
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) throw new Error("Expected private fixture origin")
  const started = performance.now(), diagnostics = { events: [], dropped: 0 }
  let stopped = false
  const codes = error => {
    const result = []
    for (let depth = 0; error && depth < 4; depth++, error = error.cause) {
      const item = {}
      for (const key of ["name", "code", "reason"]) {
        const value = error[key]
        if (typeof value === "string" && /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/.test(value)) item[key] = value
      }
      result.push(item)
    }
    return result
  }
  const record = (event, extra = {}) => {
    if (diagnostics.events.length === 32) { diagnostics.dropped++; return }
    diagnostics.events.push({ event, at: new Date().toISOString(), durationMs: performance.now() - started,
      method: "POST", path: "/api/location/reload", ...extra })
  }
  const subscriptions = [
    ["undici:request:create", "scheduled"],
    ["undici:client:sendHeaders", "headers-sending"],
    ["undici:request:bodySent", "emitted"],
    ["undici:request:headers", "response"],
    ["undici:request:error", "error"],
  ].map(([name, event]) => {
    const source = channel(name)
    const listener = ({ request, response, error }) => {
      if (String(request?.origin) !== origin || request?.method !== "POST" || request?.path !== "/api/location/reload") return
      record(event, { ...(Number.isInteger(response?.statusCode) ? { status: response.statusCode } : {}),
        ...(error ? { causes: codes(error) } : {}) })
    }
    source.subscribe(listener)
    return () => source.unsubscribe(listener)
  })
  return { diagnostics, stop(error) {
    if (stopped) return
    stopped = true
    subscriptions.forEach(unsubscribe => unsubscribe())
    diagnostics.settled = { at: new Date().toISOString(), durationMs: performance.now() - started,
      ...(error ? { causes: codes(error) } : {}) }
  } }
}

export function createNativeFixtureReporter(root, output) {
  const receipt = process.env.CODENOMAD_NATIVE_TEST_RECEIPT ?? path.join(root, "test-diagnostics.jsonl")
  let stage = "fixture-created"
  const record = (event, details = {}) => {
    appendFileSync(receipt, JSON.stringify({ event, stage, root, pid: process.pid, ...details }) + "\n")
    writeFileSync(path.join(root, "server.log"), output())
  }
  const terminalRecord = (event, details) => {
    try { record(event, details) } catch (error) {
      console.error("Native fixture diagnostic write failed:", error)
      process.exitCode ||= 1
    }
  }
  const onError = error => terminalRecord("uncaught-error", { error: String(error?.stack ?? error) })
  const onExit = code => terminalRecord("exit", { code })
  process.on("uncaughtExceptionMonitor", onError)
  process.on("exit", onExit)
  record("start")
  console.log(`Isolated fixture diagnostics at ${root}`)
  return {
    stage(value) { stage = value; record("stage") },
    complete() { record("completed"); process.off("uncaughtExceptionMonitor", onError); process.off("exit", onExit) },
  }
}

// A parent survives child process.exit/native crashes and retains the actual
// status and pipe output. It never retries or converts an incomplete run to PASS.
export async function runNativeFixture(script, args, { directory = path.join(os.tmpdir(), "opencode"), env = process.env } = {}) {
  await mkdir(directory, { recursive: true })
  const root = await mkdtemp(path.join(directory, "native-fixture-run-"))
  const receipt = path.join(root, "child.jsonl")
  console.log(`Native fixture runner diagnostics at ${root}`)
  const child = spawn(process.execPath, [script, ...args], { env: { ...env, CODENOMAD_NATIVE_TEST_RECEIPT: receipt }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
  for (const [stream, name, target] of [[child.stdout, "stdout.log", process.stdout], [child.stderr, "stderr.log", process.stderr]]) {
    stream.on("data", chunk => { appendFileSync(path.join(root, name), chunk); target.write(chunk) })
  }
  let error
  child.on("error", value => { error = String(value.stack ?? value) })
  const status = await new Promise(resolve => child.on("close", (code, signal) => resolve({ code, signal, error })))
  const { readFile } = await import("node:fs/promises")
  let completed = false
  try { completed = (await readFile(receipt, "utf8")).split("\n").filter(Boolean).some(line => JSON.parse(line).event === "completed") } catch { /* Missing/malformed receipt is incomplete, not success. */ }
  const result = { ...status, completed, root }
  writeFileSync(path.join(root, "result.json"), JSON.stringify(result, null, 2) + "\n")
  console.log(`Native fixture child result: ${JSON.stringify(result)}`)
  return { ...result, exitCode: status.code === 0 && completed ? 0 : status.code || 1 }
}
