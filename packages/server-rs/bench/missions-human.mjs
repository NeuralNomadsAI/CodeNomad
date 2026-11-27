// Headless native Wayfinder proof; only the owned fixture's daemon, profile and plugin bridge.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { copyFile, cp, mkdir, mkdtemp, realpath, rm, rmdir, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { setTimeout as delay } from "node:timers/promises"
import { assertPrivateHost, assertPrivateOpenCodeExecutable, outsideUserHome } from "./private-profile.mjs"

const [rawSource, binary, plugins] = process.argv.slice(2)
assert([rawSource, binary, plugins].every(p => p && path.isAbsolute(p)),
  "Usage: node missions-human.mjs <OpenCode exe> <Rust exe> <bundled plugins dir>")
const source = await assertPrivateOpenCodeExecutable(rawSource)
assert(process.platform === "win32", "Usage: node missions-human.mjs <OpenCode exe> <Rust exe> <bundled plugins dir> (Windows)")
const { fixtureParent, withProductRuntime } = await import("../../../scripts/native-product-fixture.mjs")
const { spawnFixtureChild: spawn, stopFixtureChild } = await import("../../../scripts/native-fixture-guards.mjs")
const parent = await outsideUserHome(await fixtureParent({ projectConfig: true }))
assert.equal(parent, await realpath(path.join(os.tmpdir(), "opencode")), "The native fixture temp must also be private")
const owned = await mkdtemp(path.join(parent, "missions-cli-"))
const cli = path.join(owned, "opencode.exe")
const selection = { coordinator: { agent: "build", model: { providerID: "fixture", id: "fixture" } } }
const questionID = "call_fixture_question"
const taskKey = "choose"
const decisionTag = mission => `[decision ${taskKey} ${createHash("sha256").update(`decision-question\0${mission}\0${taskKey}`).digest("hex").slice(0, 8)}]`
const eventually = async (label, read) => {
  for (const until = Date.now() + 35_000; Date.now() < until; await delay(80)) {
    const value = await read()
    if (value) return value
  }
  throw new Error(`Timed out: ${label}`)
}

try {
  await copyFile(source, cli)
  await withProductRuntime(cli, async () => ({
    update: "disable", snapshots: false,
    permissions: [{ action: "question", resource: "*", effect: "allow" }],
  }), async ({ client, env, connection, root: fixture }) => {
    const project = path.join(fixture, "project"), server = path.join(fixture, "server")
    const ui = path.join(fixture, "ui"), config = path.join(fixture, "fixture.yaml")
    for (const directory of [project, server, ui]) await mkdir(directory)
    execFileSync("git", ["init", "-q", project], { env: { ...env, GIT_CONFIG_NOSYSTEM: "1" }, cwd: fixture, windowsHide: true })
    await writeFile(path.join(ui, "index.html"), "<!doctype html><title>Fixture only</title>")
    const rust = path.join(server, "codenomad-rs.exe"), shim = path.join(fixture, "fixture-opencode.cmd")
    await copyFile(binary, rust)
    await cp(plugins, path.join(server, "plugins"), { recursive: true })
    // Only this child can be discovered by Rust. The shim cannot start a daemon.
    const url = connection.endpoint.url, nativePassword = connection.endpoint.auth.password
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/)
    assert.match(nativePassword, /^[A-Za-z0-9_-]{16,128}$/)
    await writeFile(shim, '@echo off\r\nif "%*"=="service status" (echo %FIXTURE_NATIVE_URL%& exit /b 0)\r\nif "%*"=="service get password" (echo %FIXTURE_NATIVE_PASSWORD%& exit /b 0)\r\nexit /b 1\r\n')
    const password = randomUUID()
    const vars = { ...env, CLI_CONFIG: config, CODENOMAD_SERVER_PASSWORD: password,
      CODENOMAD_REMOTE_CONTROL: "disabled", FIXTURE_NATIVE_URL: url, FIXTURE_NATIVE_PASSWORD: nativePassword }
    await assertPrivateHost(vars, fixture, config)
    await writeFile(config, `server:\n  opencodeBinary: ${JSON.stringify(shim)}\n`)
    const child = spawn(rust, ["serve", "--http", "true", "--http-port", "0", "--https", "false",
      "--ui-dir", ui, "--workspace-root", project], { cwd: fixture, env: vars, windowsHide: true })
    const stopped = new Promise(resolve => child.once("close", resolve))
    let output = "", spawnError
    child.stdin.on("error", () => {})
    child.on("error", error => { spawnError = error })
    for (const stream of [child.stdout, child.stderr]) stream.on("data", data => { output += data })
    try {
      const origin = await eventually("Rust ready", () => {
        if (spawnError || child.exitCode !== null) throw new Error(`Rust startup failed: ${spawnError ?? output.slice(-2000)}`)
        return /^Local Connection URL\s*:\s*(http:\/\/127\.0\.0\.1:\d+)/m.exec(output)?.[1]
      })
      const get = (route, init) => fetch(origin + route, { signal: AbortSignal.timeout(30_000), ...init })
      let cookie
      const post = (route, body, headers) => get(route, { method: "POST", body: JSON.stringify(body),
        headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...headers } })
      const json = async (response, status) => {
        const r = await response, text = await r.text()
        assert.equal(r.status, status, text)
        return text && JSON.parse(text)
      }
      const login = await post("/api/auth/login", { username: "codenomad", password })
      assert.equal(login.status, 200)
      cookie = login.headers.get("set-cookie").split(";")[0]
      const ws = await json(post("/api/workspaces", { path: project }), 201)
      const location = { directory: ws.location.directory }
      await eventually("Missions plugin", async () =>
        (await client.plugin.list({ location })).data.some(p => p.id === "codenomad.missions" && p.state.status === "active"))
      const base = `/api/workspaces/${ws.id}/missions`
      const formPath = form => `/workspaces/${ws.id}/instance/api/session/${form.sessionID}/form/${form.id}/reply`
      for (const mode of ["ordinary", "marked", "nonmission"]) {
        const marked = mode === "marked"
        const { mission } = mode === "nonmission" ? {} : await json(post(base, {
          requestId: `human-answer-${mode}`, template: "wayfinder", taskMode: "native",
          objective: "Choose a module", profiles: selection,
        }), 200)
        const session = mission?.coordinatorSessionId ?? (await client.session.create({ location, title: "Ordinary fixture" })).id
        const missionID = mission?.id ?? "msn_fixture"
        const question = `Choose a module? ${decisionTag(missionID)}`
        // Drive just the real question tool. The independent Play/Resume path
        // does not participate in this Form/decision-proof check.
        await client.session.prompt({ sessionID: session, text: `WAYFINDER-FIXTURE: ${question}` })
        const form = await eventually("native question", async () =>
          (await client.form.list({ location })).data.find(f => f.sessionID === session))
        assert.equal(form.metadata?.kind, "question")
        const route = formPath(form), answer = { answer: { q0: "Module" } }, hint = { "x-codenomad-human-answer": "1" }
        await json(post(route, answer, { cookie: "invalid=invalid", ...hint }), 401)
        if (marked) {
          const outcome = await json(post(formPath({ ...form, id: form.id + "missing" }), answer, hint), 409)
          assert.match(outcome.error, /do not replay/)
        }
        await json(post(route, answer, mode !== "ordinary" ? hint : undefined), 204)
        const provenance = { kind: "coordinator-form-answer", contract: { missionID, taskKey, generation: 1 },
          sessionID: session, formID: form.id, messageID: form.metadata.tool.messageID, toolCallID: form.metadata.tool.id,
          fieldKey: "q0", projectID: (await client.session.get({ sessionID: session })).projectID,
          directory: location.directory, question, answer: "Module" }
        await eventually("completed native question", async () => {
          const message = await client.session.message.get({ sessionID: session, messageID: provenance.messageID })
          return message.content.some(p => p.type === "tool" && p.id === provenance.toolCallID && p.state.status === "completed")
        })
        const db = new DatabaseSync(env.OPENCODE_DB, { readOnly: true })
        try {
          const marks = db.prepare("SELECT value FROM kv WHERE key LIKE ?")
            .all(`%codenomad-missions/human-marks-v1/%/${form.sessionID}/${form.id}`)
            .map(row => JSON.parse(row.value))
          assert.deepEqual(marks.map(m => [m.state, m.via, m.answer]), marked ? [["confirmed", "ui", { q0: "Module" }]] : [])
          assert(!JSON.stringify(marks).includes(cookie.split("=")[1]), "Login cookie stays out of durable marks")
        } finally { db.close() }
        const verify = evidence => fetch(`${url}/api/rpc/codenomad.missions.human-answer/verify?${new URLSearchParams({ "location[directory]": location.directory })}`, {
          method: "POST", body: JSON.stringify({ input: evidence }), signal: AbortSignal.timeout(15_000),
          headers: { "content-type": "application/json", authorization: `Basic ${Buffer.from(`opencode:${nativePassword}`).toString("base64")}` },
        })
        const result = await verify(provenance)
        assert.equal(result.ok, marked, await result.text())
        if (marked) assert(!(await verify({ ...provenance, answer: "different" })).ok)
        console.log(`PASS native decision proof: ${mode}`)
      }
    } finally {
      if (!spawnError && child.exitCode === null && child.signalCode === null) child.stdin.end("codenomad:shutdown\n")
      await Promise.race([stopped, delay(10_000, undefined, { ref: false })])
      if (!spawnError && child.exitCode === null && child.signalCode === null) await stopFixtureChild(child, stopped)
    }
  }, { service: true, respond({ messages, tools }) {
    const question = JSON.stringify(messages).match(/Choose a module\? \[decision choose [0-9a-f]{8}\]/)?.[0]
    if (!question || !tools?.some(t => t.function.name === "question") || messages.some(m => m.tool_call_id === questionID))
      return { role: "assistant", content: "Fixture title" }
    const args = { questions: [{ question, header: "Module", options: [{ label: "Module", description: "Own the decision" }] }] }
    return { role: "assistant", tool_calls: [{ index: 0, id: questionID, type: "function",
      function: { name: "question", arguments: JSON.stringify(args) } }] }
  } })
} finally {
  await rm(cli, { force: true })
  await rmdir(owned)
}
