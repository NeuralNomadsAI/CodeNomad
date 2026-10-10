import assert from "node:assert/strict"
import test from "node:test"
import { fixturePaginationGuard, stopFixtureChild, clearFixtureGitEnvironment } from "./native-fixture-guards.mjs"
import { execFileSync } from "node:child_process"
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
