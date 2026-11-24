import assert from "node:assert/strict"
import test from "node:test"
import { fixtureChildPid, fixturePaginationGuard, spawnFixtureChild, stopFixtureChild, clearFixtureGitEnvironment } from "./native-fixture-guards.mjs"
import { execFileSync, spawn } from "node:child_process"
import { once } from "node:events"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

test("fixture cleanup escalates a stuck owned child and returns a bounded failure", async () => {
  const signals = []
  let released = false
  const child = { pid: 123, kill: signal => signals.push(signal ?? "SIGTERM"), unref: () => { released = true } }
  await assert.rejects(stopFixtureChild(child, new Promise(() => {}), 5, 5), /forced termination/)
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"])
  assert.equal(released, true)
})

test("fixture cleanup accepts an owned child closing after forced termination", async () => {
  let closed
  const stopped = new Promise(resolve => { closed = resolve })
  const signals = []
  const child = { kill: signal => { signals.push(signal ?? "SIGTERM"); if (signal === "SIGKILL") closed() } }
  await stopFixtureChild(child, stopped, 5, 5)
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"])
})

test("Windows fixture cleanup refuses an unowned process instead of enumerating descendants", { skip: process.platform !== "win32" }, async () => {
  const child = { spawnfile: "not-owned", pid: 123, kill: () => assert.fail("unowned process") }
  await assert.rejects(stopFixtureChild(child, Promise.resolve()), /owned Job Object/)
})

const windows = { skip: process.platform !== "win32", timeout: 30_000 }
const isolated = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(path|systemroot|windir)$/i.test(key)))
const own = (source, ...args) => spawnFixtureChild(process.execPath, ["-e", source, ...args], {
  env: isolated, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
})
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }

test("Windows job still owns a grandchild after both ancestors exit", windows, async () => {
  const middleScript = `
    const {spawn} = require("node:child_process")
    const leaf = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {detached:true,windowsHide:true,stdio:"ignore"})
    leaf.once("spawn", () => process.stdout.write(JSON.stringify([process.pid,leaf.pid]), () => process.exit(0)))
  `
  const root = own(`
    const {spawn} = require("node:child_process")
    const middle = spawn(process.execPath, ["-e", ${JSON.stringify(middleScript)}], {windowsHide:true,stdio:["ignore","pipe","inherit"]})
    let result = ""
    middle.stdout.on("data", data => result += data)
    middle.once("close", code => {
      if (code !== 0) return process.exit(2)
      process.stdout.write(result)
      process.stdin.resume()
      process.stdin.once("end", () => process.exit(0))
    })
  `)
  const stopped = once(root, "close")
  try {
    const [data] = await once(root.stdout, "data")
    const [middle, leaf] = JSON.parse(data.toString())
    const inner = await fixtureChildPid(root)
    assert.equal(alive(middle), false)
    assert.equal(alive(leaf), true)
    root.stdin.end()
    await stopped
    assert.equal(root.exitCode, 0)
    assert.equal(alive(inner), false)
    assert.equal(alive(leaf), false)
  } finally { await stopFixtureChild(root, stopped) }
})

test("Windows job teardown leaves a foreign PID alone even when the fixture advertises it as a descendant", windows, async () => {
  const foreign = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    env: isolated, windowsHide: true, stdio: "ignore",
  })
  const foreignStopped = once(foreign, "close")
  try {
    const root = own(`console.log(process.argv[1]); setInterval(() => {}, 1000)`, String(foreign.pid))
    const stopped = once(root, "close")
    try {
      const [data] = await once(root.stdout, "data")
      assert.equal(Number(String(data).trim()), foreign.pid)
      await stopFixtureChild(root, stopped)
      assert.equal(alive(foreign.pid), true)
    } finally { await stopFixtureChild(root, stopped) }
  } finally {
    foreign.kill()
    await foreignStopped
  }
})

test("Windows job permits immediate graceful shutdown over stdin", windows, async () => {
  const root = own(`process.stdin.resume(); process.stdin.once("end", () => process.exit(0))`)
  const stopped = once(root, "close")
  await stopFixtureChild(root, stopped, 5000, 2000, { close: () => root.stdin.end() })
  assert.equal(root.exitCode, 0)
})

test("Windows enclosing bench job keeps its daemon across backend exits but kills it on close", windows, async () => {
  const root = own(`
    const {spawn} = require("node:child_process")
    const service = spawn(process.execPath, ["-e", "console.log('ready');setInterval(() => {}, 1000)"], {windowsHide:true,stdio:["ignore","pipe","ignore"]})
    service.stdout.once("data", () => {
      service.stdout.destroy()
      const backend = spawn(process.execPath, ["-e", ""], {windowsHide:true,stdio:"ignore"})
      backend.once("exit", code => {
        console.log(JSON.stringify([code,service.pid]))
        process.stdin.resume()
      })
    })
  `)
  const stopped = once(root, "close")
  try {
    const [data] = await once(root.stdout, "data")
    const [backendExit, daemon] = JSON.parse(String(data))
    assert.equal(backendExit, 0)
    assert.equal(alive(daemon), true)
    await stopFixtureChild(root, stopped)
    assert.equal(alive(daemon), false)
  } finally { await stopFixtureChild(root, stopped) }
})

test("Windows mobile enclosing job kills detached browser descendants when the IPC client times out", windows, async () => {
  const launcherSource = fs.readFileSync(new URL("../packages/rune-app/fixtures/launcher-fixture.mjs", import.meta.url), "utf8")
  assert.match(launcherSource, /--owned-mobile-worker/, "launcher-fixture wraps mobile IPC runs in an enclosing Windows job")
  assert.match(launcherSource, /spawnFixtureChild\(process\.execPath,\[\.\.\.process\.execArgv,\.\.\.process\.argv\.slice\(1\),'--owned-mobile-worker'\]/)
  const ipcClient = `
    const {spawn} = require("node:child_process")
    const browser = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {detached:true,windowsHide:true,stdio:"ignore"})
    browser.once("spawn", () => process.send({browserPid: browser.pid}))
    setInterval(() => {}, 1000)
  `
  const worker = own(`
    const {spawn} = require("node:child_process")
    const client = spawn(process.execPath, ["-e", ${JSON.stringify(ipcClient)}], {windowsHide:true,stdio:["ignore","ignore","ignore","ipc"]})
    client.once("message", ({browserPid}) => {
      console.log(JSON.stringify([client.pid, browserPid]))
      setTimeout(() => { client.kill(); process.exit(1) }, 50)
    })
  `)
  const stopped = once(worker, "close")
  try {
    const [data] = await once(worker.stdout, "data")
    const [clientPid, browserPid] = JSON.parse(String(data))
    const [code] = await stopped
    assert.equal(code, 1)
    assert.equal(alive(clientPid), false)
    assert.equal(alive(browserPid), false)
  } finally { await stopFixtureChild(worker, stopped) }
})

test("Missions native fixtures stop their owned serve with bounded escalation", () => {
  for (const script of ["test-missions-native.mjs", "test-missions-native-family-control.mjs"]) {
    const source = fs.readFileSync(new URL(script, import.meta.url), "utf8")
    assert.match(source, /await stopFixtureChild\(child, stopped\)/, script)
    assert.doesNotMatch(source, /child\?\.kill\(\)/, `${script} must not await an unbounded close`)
  }
})

test("recurring native fixture cleanup survives an early failure before the database exists", () => {
  const source = fs.readFileSync(new URL("test-recurring-simple-native.mjs", import.meta.url), "utf8")
  const cleanup = source.slice(source.indexOf("// Finish evidence even when settlement times out"))
  assert.match(cleanup, /if \(existsSync\(env\.OPENCODE_DB\)\)/)
  assert.ok(cleanup.indexOf("existsSync(env.OPENCODE_DB)") < cleanup.indexOf("new DatabaseSync"))
  assert.match(cleanup, /catch \(error\) \{ evidence\.nativePassagesError/)
  assert.match(cleanup, /await stopFixtureChild\(child, closed\)/)
  assert.match(cleanup, /writeFile\(path\.join\(root, "qualification\.json"\)/)
})

test("native pagination rejects cycles instead of looping indefinitely", () => {
  const accept = fixturePaginationGuard()
  accept("one"); accept("two")
  assert.throws(() => accept("one"), /repeated a nonterminal cursor/)
})

test("private Git setup cannot commit an inherited repository or index", t => {
  const base = process.platform === "win32" ? path.join(process.env.LOCALAPPDATA, "Temp", "opencode") : os.tmpdir()
  const root = fs.mkdtempSync(path.join(base, "fixture-git-isolation-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const caller = path.join(root, "caller"), project = path.join(root, "project"), hooks = path.join(root, "hooks")
  for (const directory of [caller, project, hooks]) fs.mkdirSync(directory)
  const environment = { ...process.env }
  clearFixtureGitEnvironment(environment)
  Object.assign(environment, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(root, "empty-config") })
  fs.writeFileSync(environment.GIT_CONFIG_GLOBAL, "")
  const git = (directory, args, env = environment) => execFileSync("git", ["-C", directory,
    "-c", "user.name=Private Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false",
    "-c", `core.hooksPath=${hooks}`, ...args], { env, encoding: "utf8", stdio: "pipe", windowsHide: true }).trim()
  git(caller, ["init"])
  git(caller, ["commit", "--allow-empty", "-m", "caller"])
  fs.writeFileSync(path.join(caller, "staged.txt"), "preserved")
  git(caller, ["add", "staged.txt"])
  const before = git(caller, ["rev-parse", "HEAD"]), index = fs.readFileSync(path.join(caller, ".git", "index"))
  const hostile = { ...environment, GIT_DIR: path.join(caller, ".git"), GIT_WORK_TREE: caller,
    GIT_INDEX_FILE: path.join(caller, ".git", "index"), GIT_COMMON_DIR: path.join(caller, ".git"),
    GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.bare", GIT_CONFIG_VALUE_0: "true", git_object_directory: "hostile" }
  clearFixtureGitEnvironment(hostile)
  assert.equal(Object.keys(hostile).some(key => /^GIT_/i.test(key)), false)
  assert.equal(hostile.PATH, environment.PATH)
  Object.assign(hostile, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: environment.GIT_CONFIG_GLOBAL })
  git(project, ["init"], hostile)
  git(project, ["commit", "--allow-empty", "-m", "private"], hostile)
  assert.equal(git(caller, ["rev-parse", "HEAD"]), before)
  assert.deepEqual(fs.readFileSync(path.join(caller, ".git", "index")), index)
  assert.equal(git(caller, ["diff", "--cached", "--name-only"]), "staged.txt")
})
