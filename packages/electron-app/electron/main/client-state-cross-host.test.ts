import assert from "node:assert/strict"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { once } from "node:events"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, posix, win32 } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import {
  CrossHostRegistration,
  CROSS_HOST_OWNER_FILENAME,
  resolveCrossHostElectionDirectory,
  type CrossHostLeaseDependencies,
} from "./client-state-cross-host"
import type { ProcessOwner } from "./client-state-process"

function temp(t: test.TestContext): string {
  const path = mkdtempSync(join(tmpdir(), "codenomad-cross-host-"))
  t.after(() => rmSync(path, { recursive: true, force: true }))
  return path
}

function owner(pid: number, host: string, identity = `${host}-start`): ProcessOwner {
  return { pid, runToken: `${host}-run`, processStartIdentity: identity }
}

function dependencies(alive: boolean, identity?: string): CrossHostLeaseDependencies {
  return { pidAlive: () => alive, processStartIdentity: () => identity }
}

test("both host orders elect only the first registration", (t) => {
  for (const order of [["electron", "tauri"], ["tauri", "electron"]] as const) {
    const directory = temp(t)
    const firstOwner = owner(101, order[0]), secondOwner = owner(102, order[1])
    const identities = new Map([[101, firstOwner.processStartIdentity!], [102, secondOwner.processStartIdentity!]])
    const deps = { pidAlive: () => true, processStartIdentity: (pid: number) => identities.get(pid) }
    const first = CrossHostRegistration.register(directory, firstOwner, true, deps)!
    const second = CrossHostRegistration.register(directory, secondOwner, true, deps)!
    assert.equal(first.isPrimary, true)
    assert.equal(second.isPrimary, false)
    second.release()
    assert.equal(first.release(), true)
  }
})

test("simultaneous acquisition across processes yields one owner", async (t) => {
  const directory = temp(t), start = join(directory, "start")
  const children = Array.from({ length: 4 }, () => spawn(process.execPath, [
    "--import", "tsx", fileURLToPath(new URL("./client-state-cross-host-child.ts", import.meta.url)), directory, start,
  ]) as ChildProcessWithoutNullStreams)
  try {
    const results = children.map((child) => new Promise<boolean>((resolve, reject) => {
      let output = "", errors = ""
      child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8")
      child.stdout.on("data", (chunk: string) => { output += chunk; if (output.includes("\n")) resolve(JSON.parse(output).acquired) })
      child.stderr.on("data", (chunk: string) => { errors += chunk })
      child.once("error", reject)
      child.once("exit", (code) => { if (!output) reject(new Error(`child ${code}: ${errors}`)) })
    }))
    writeFileSync(start, "")
    assert.equal((await Promise.all(results)).filter(Boolean).length, 1)
  } finally {
    const exits = children.map((child) => once(child, "exit"))
    children.forEach((child) => child.stdin.end())
    await Promise.all(exits)
  }
})

test("stale recovery is identity guarded and immutable claims protect successors", (t) => {
  for (const value of [
    { name: "dead PID", deps: dependencies(false), recover: true },
    { name: "PID reuse", deps: dependencies(true, "new-start"), recover: true },
    { name: "live owner", deps: dependencies(true, "old-start"), recover: false },
    { name: "uncertain identity", deps: dependencies(true), recover: false },
  ]) {
    const directory = temp(t), path = join(directory, CROSS_HOST_OWNER_FILENAME)
    writeFileSync(path, JSON.stringify(owner(201, "old", "old-start")))
    const registration = CrossHostRegistration.register(directory, owner(202, "new"), true, value.deps)!
    assert.equal(registration.isPrimary, value.recover, value.name)
    registration.release()
  }

  const directory = temp(t), path = join(directory, CROSS_HOST_OWNER_FILENAME)
  const stale = JSON.stringify(owner(301, "stale"))
  writeFileSync(path, stale)
  const first = CrossHostRegistration.register(directory, owner(302, "first"), true, dependencies(false))!
  assert.equal(first.isPrimary, true)
  writeFileSync(path, JSON.stringify(owner(303, "replacement")))
  assert.equal(first.release(), false)
  assert.equal(JSON.parse(readFileSync(path, "utf8")).runToken, "replacement-run")
})

test("a surviving opposite-host secondary preserves the cohort barrier", (t) => {
  const directory = temp(t)
  const identities = new Map([[401, "primary-start"], [402, "secondary-start"]])
  const deps = { pidAlive: () => true, processStartIdentity: (pid: number) => identities.get(pid) }
  const primary = CrossHostRegistration.register(directory, owner(401, "primary", "primary-start"), true, deps)!
  const secondary = CrossHostRegistration.register(directory, owner(402, "secondary", "secondary-start"), true, deps)!
  assert.equal(secondary.isPrimary, false)
  assert.equal(primary.release(), false)
  assert.equal(existsSync(join(directory, CROSS_HOST_OWNER_FILENAME)), true)
  const successor = CrossHostRegistration.register(directory, owner(403, "successor", "successor-start"), true, deps)!
  assert.equal(successor.isPrimary, false)
  successor.release(); secondary.release()
})

test("malformed owners fail closed and release never removes another owner", (t) => {
  const directory = temp(t), path = join(directory, CROSS_HOST_OWNER_FILENAME)
  writeFileSync(path, "incomplete")
  const blocked = CrossHostRegistration.register(directory, owner(501, "new"), true, dependencies(false))!
  assert.equal(blocked.isPrimary, false)
  assert.equal(readFileSync(path, "utf8"), "incomplete")
  blocked.release()
})

test("Windows home fallback exactly matches the Rust contract", () => {
  assert.equal(resolveCrossHostElectionDirectory({ HOME: "/Users/dev" }, "darwin", "/fallback"), posix.join("/Users/dev", ".codenomad", "client-state", "election"))
  assert.equal(resolveCrossHostElectionDirectory({ HOME: "/home/dev" }, "linux", "/fallback"), posix.join("/home/dev", ".codenomad", "client-state", "election"))
  assert.equal(resolveCrossHostElectionDirectory({ USERPROFILE: "", HOME: "D:\\Home" }, "win32", "C:\\Fallback"), win32.join("D:\\Home", ".codenomad", "client-state", "election"))
  assert.equal(resolveCrossHostElectionDirectory({ USERPROFILE: "\\Users\\Dev" }, "win32", "C:\\Fallback"), win32.join("C:\\Fallback", ".codenomad", "client-state", "election"))
})
