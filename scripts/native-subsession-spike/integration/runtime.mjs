import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { createServer } from "node:http"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { OpenCode } from "@opencode/client"
import { ASSIGNED_CLI, privateRoot } from "../../missions-child-environment/runtime.mjs"

export const EXPERIMENT = "D:/CodeNomad/.codenomad/worktrees/missions-native-subsessions-20261003"
export const sha = bytes => createHash("sha256").update(bytes).digest("hex")
export async function protect() {
  assert.equal(path.resolve(process.cwd()).toLowerCase(), path.resolve(EXPERIMENT).toLowerCase())
  const source = "D:/CodeNomad/.codenomad/worktrees/tauri-integrated-20261002-1841-b62f"
  const manifest = JSON.parse(await readFile("C:/Users/Admin/AppData/Local/Temp/opencode/missions-native-rollback-V0FPSs/source-before.json", "utf8"))
  const actual = await Promise.all(manifest.map(async item => ({ path: item.path, sha256: sha(await readFile(path.join(source, item.path))) })))
  assert.deepEqual(actual, manifest, "Frozen 2225 source bytes")
  const gitDir = path.resolve(source, (await readFile(path.join(source, ".git"), "utf8")).trim().slice(8))
  const lane1 = {}
  for (const file of ["run.mjs", "index.ts", "mission.ts"]) lane1[file] = sha(await readFile(path.join(EXPERIMENT, "scripts/native-subsession-spike/native-first", file)))
  assert.deepEqual(lane1, { "run.mjs": "d6c71c648a856d4616b298909f9ee959fbba96f570735adf7fc05ec1b3616998",
    "index.ts": "4bf8087b4d4cbcb60183f33058117327ab2bc5c1cc44750d76256af86159e8de", "mission.ts": "535a7157e3c9e223c36dae47f9f8da249e7edb7168b7d045b3c6795d0c59783b" }, "Independently verified lane1 immutable")
  return { files: actual.length, digest: sha(JSON.stringify(actual)), index: sha(await readFile(path.join(gitDir, "index"))), lane1 }
}
export async function privateRuntime() {
  for (const key of Object.keys(process.env)) if (/(TOKEN|SECRET|API_KEY|PASSWORD|WSL|CONTEXT)/i.test(key)) delete process.env[key]
  return privateRoot(ASSIGNED_CLI)
}
export async function launch(root, deadline) {
  let output = "", failure
  const child = spawn(ASSIGNED_CLI, ["serve", "--hostname", "127.0.0.1", "--port", "0", "--print-logs"], { cwd: root, env: process.env, windowsHide: true })
  const closed = new Promise(resolve => child.once("close", resolve))
  child.once("error", error => { failure = error })
  for (const stream of [child.stdout, child.stderr]) stream.on("data", bytes => { output += bytes })
  const watchdog = setTimeout(() => child.kill(), Math.max(1, deadline - Date.now()))
  watchdog.unref()
  const stop = async () => { clearTimeout(watchdog); if (child.exitCode === null) child.kill(); await closed }
  try {
    const end = Math.min(deadline, Date.now() + 30000)
    while (!/http:\/\/127\.0\.0\.1:\d+/.test(output)) {
      if (failure || child.exitCode !== null || Date.now() >= end) throw failure ?? new Error("Owned private serve startup failed")
      await delay(30)
    }
    const url = output.match(/http:\/\/127\.0\.0\.1:\d+/)[0]
    const headers = { authorization: `Basic ${Buffer.from("opencode:" + process.env.OPENCODE_SERVER_PASSWORD).toString("base64")}` }
    const client = OpenCode.make({ baseUrl: url, headers }), info = await client.server.info({ signal: AbortSignal.timeout(10000) })
    assert.equal(info.version, "2.0.22")
    return { child, client, info, url, headers, stop, logs: () => output.replaceAll(process.env.OPENCODE_SERVER_PASSWORD, "[REDACTED]") }
  } catch (error) { await stop(); throw error }
}

export function deterministicProvider(deadline) {
  const requests = [], plans = new Map(), markerPlans = new Map(), holds = new Map(), waiting = new Map()
  let failure
  function emit(response, answer) {
    response.setHeader("content-type", "text/event-stream")
    const calls = Array.isArray(answer) ? answer : typeof answer === "string" ? undefined : [answer]
    const delta = calls ? { role: "assistant", tool_calls: calls.map((call, index) => ({ index, id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.input) } })) } : { role: "assistant", content: answer }
    for (const [content, finish_reason] of [[delta, null], [{}, calls ? "tool_calls" : "stop"]]) response.write(`data: ${JSON.stringify({ id: "integration", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta: content, finish_reason }] })}\n\n`)
    response.end("data: [DONE]\n\n")
  }
  const server = createServer(async (request, response) => {
    try {
      let raw = ""
      for await (const chunk of request) raw += chunk
      const body = JSON.parse(raw), sessionID = request.headers["x-integration-session"], kind = request.headers["x-integration-kind"]
      const entry = { index: requests.length, sessionID, kind, time: Date.now(), body }
      requests.push(entry)
      assert(requests.length <= 200 && Date.now() < deadline, "Bounded native provider")
      if (kind !== "primary") { emit(response, "Private title"); return }
      if (!plans.has(sessionID)) for (const [marker, steps] of markerPlans) if (JSON.stringify(body.messages).includes(marker)) { plans.set(sessionID, steps); markerPlans.delete(marker); break }
      const step = plans.get(sessionID)?.shift() ?? {}
      const missing = (step.require ?? []).filter(required => !JSON.stringify(body.messages).includes(required))
      if (missing.length) {
        const count = (waiting.get(sessionID) ?? 0) + 1; waiting.set(sessionID, count)
        assert(count <= 8, "Bounded coordinator native-inbox waits")
        plans.get(sessionID).unshift(step)
        entry.decision = { kind: "await-native-inbox", missing }
        // A native result and a separately queued business receipt can arrive in different turns.
        // No prompt, dispatch or executor retry: let the already admitted native inbox wake this session.
        emit(response, "COORDINATOR_WAITING_FOR_NATIVE_INBOX:" + missing.join(",")); return
      }
      if (step.hold) await new Promise(resolve => { holds.set(step.hold, resolve); response.once("close", resolve) })
      if (!response.destroyed) emit(response, typeof step.answer === "function" ? step.answer(entry) : step.answer ?? "NATIVE_DONE:" + sessionID)
    } catch (error) { failure = error; response.destroy() }
  })
  return { server, requests, plans, markerPlans, holds, failure: () => failure,
    release(name) { assert(holds.has(name), "Expected hold " + name); holds.get(name)(); holds.delete(name) },
    async stop() { for (const release of holds.values()) release(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) } }
}
