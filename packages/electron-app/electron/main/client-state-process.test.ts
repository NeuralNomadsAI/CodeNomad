import assert from "node:assert/strict"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { randomUUID } from "node:crypto"
import { once } from "node:events"
import fs, { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { syncBuiltinESMExports } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { cleanStaleRunningMarkers, createRunningMarker, electClientStateProcess, getRunningMarkerPath, hasLiveTauriClient, REGISTRATION_LOCK_WAIT_MS, removeProcessOwnerLockIfOwned, removeRunningMarkerIfOwned, type ProcessOwner } from "./client-state-process"
import { getProcessStartIdentity } from "./client-state-process-identity"

function temp(t: test.TestContext) { const directory = mkdtempSync(join(tmpdir(), "codenomad-election-")); t.after(() => rmSync(directory, { recursive: true, force: true })); return directory }

test("legacy Tauri markers block only while their PID may be live", (t) => {
  const directory = temp(t)
  writeFileSync(join(directory, "client-state.running.123.1.lock"), "")
  writeFileSync(join(directory, "client-state.running.456.2.lock"), "")
  assert.equal(hasLiveTauriClient(directory, (pid) => pid === 456), true)
  assert.equal(hasLiveTauriClient(directory, () => false), false)
  assert.equal(hasLiveTauriClient(directory, (pid) => pid === 456, () => "reused", () => false), false)
  assert.equal(hasLiveTauriClient(directory, (pid) => pid === 456, () => undefined, () => undefined), true)
  assert.equal(hasLiveTauriClient(directory, (pid) => pid === 456, () => "tauri-start", () => true), true)
  assert.equal(hasLiveTauriClient(directory, (pid) => pid === 456, () => "tauri-start", () => true, [
    { pid: 456, runToken: "upgraded", processStartIdentity: "tauri-start" },
  ]), false)
})

interface Child { process: ChildProcessWithoutNullStreams; result: Promise<{ isPrimary: boolean }> }
function child(directory: string, start: string, wait = "", paused = "", release = ""): Child {
  const process = spawn(globalThis.process.execPath, ["--import", "tsx", fileURLToPath(new URL("./client-state-election-child.ts", import.meta.url)), directory, randomUUID(), start, wait, paused, release])
  process.stdout.setEncoding("utf8"); process.stderr.setEncoding("utf8")
  const result = new Promise<{ isPrimary: boolean }>((resolve, reject) => {
    let output = "", errors = "", settled = false
    process.stdout.on("data", (chunk: string) => {
      output += chunk
      const end = output.indexOf("\n")
      if (end >= 0 && !settled) { settled = true; resolve(JSON.parse(output.slice(0, end))) }
    })
    process.stderr.on("data", (chunk: string) => { errors += chunk }); process.once("error", reject)
    process.once("exit", (code) => { if (!settled) reject(new Error(`child ${code}: ${errors}`)) })
  })
  return { process, result }
}
async function stop(children: Child[]) { const exits = children.map(({ process }) => once(process, "exit")); children.forEach(({ process }) => process.stdin.end()); await Promise.all(exits) }
async function contenders(directory: string, configure?: () => void, count = 2) {
  const start = join(directory, "start")
  configure?.()
  const children = Array.from({ length: count }, () => child(directory, start, "40"))
  try {
    writeFileSync(start, "")
    const roles = await Promise.all(children.map(({ result }) => result))
    assert.equal(roles.filter(({ isPrimary }) => isPrimary).length, 1, JSON.stringify(roles))
  } finally { await stop(children) }
}

test("current process start identity is stable", () => {
  const identity = getProcessStartIdentity(process.pid)
  assert.ok(identity, `identity unavailable on ${process.platform}`)
  assert.equal(getProcessStartIdentity(process.pid), identity)
})

test("marker cleanup preserves only election-relevant live cohorts", async (t) => {
  const cases: Array<{ name: string; marker: ProcessOwner; current: ProcessOwner; alive: boolean; identity?: string; primary?: ProcessOwner; blocking: boolean; remains: boolean }> = [
    { name: "live secondary", marker: { pid: 2, runToken: "live" }, current: { pid: 3, runToken: "new" }, alive: true, blocking: true, remains: true },
    { name: "same PID old run", marker: { pid: 4, runToken: "old" }, current: { pid: 4, runToken: "new" }, alive: true, blocking: false, remains: false },
    { name: "reused PID", marker: { pid: 5, runToken: "old", processStartIdentity: "old" }, current: { pid: 6, runToken: "new" }, alive: true, identity: "reused", blocking: false, remains: false },
    { name: "unknown identity", marker: { pid: 7, runToken: "unknown", processStartIdentity: "old" }, current: { pid: 8, runToken: "new" }, alive: true, blocking: true, remains: true },
    { name: "acknowledged primary", marker: { pid: 9, runToken: "secondary" }, current: { pid: 10, runToken: "primary" }, alive: true, primary: { pid: 10, runToken: "primary" }, blocking: false, remains: true },
  ]
  for (const value of cases) await t.test(value.name, (st) => {
    const directory = temp(st)
    const path = createRunningMarker(directory, value.marker, value.primary)
    const identity = () => value.identity
    assert.equal(cleanStaleRunningMarkers(directory, value.current, () => value.alive, identity), value.blocking)
    assert.equal(existsSync(path), value.remains)
  })
})

test("marker removal and mismatched contents never discard a possible live owner", (t) => {
  const directory = temp(t)
  const filenameOwner = { pid: 11, runToken: "filename" }
  const storedOwner = { pid: 12, runToken: "stored" }
  const current = { pid: 13, runToken: "current" }
  const path = createRunningMarker(directory, filenameOwner)
  writeFileSync(path, JSON.stringify(storedOwner))
  assert.equal(removeRunningMarkerIfOwned(path, filenameOwner), false)
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), storedOwner)
  assert.equal(cleanStaleRunningMarkers(directory, current, () => false), false)
  assert.equal(existsSync(path), false)
  createRunningMarker(directory, filenameOwner)
  writeFileSync(path, JSON.stringify(storedOwner))
  assert.equal(cleanStaleRunningMarkers(directory, current, (pid) => pid === filenameOwner.pid), true)
  assert.equal(existsSync(path), true)
})

test("process files tolerate only unsupported fsync and never clobber an owner", (t) => {
  const directory = temp(t)
  const first = { pid: 14, runToken: "first" }
  const path = createRunningMarker(directory, first)
  assert.throws(() => createRunningMarker(directory, { pid: 14, runToken: "first" }), { code: "EEXIST" })
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), first)
  const original = fs.fsyncSync
  t.after(() => { fs.fsyncSync = original; syncBuiltinESMExports() })
  for (const [code, retained] of [["EINVAL", true], ["ENOTSUP", true], ["ENOSYS", true], ["EIO", false]] as const) {
    fs.fsyncSync = () => { throw Object.assign(new Error(code), { code }) }; syncBuiltinESMExports()
    const owner = { pid: 15, runToken: code }, next = getRunningMarkerPath(directory, owner)
    if (retained) createRunningMarker(directory, owner)
    else assert.throws(() => createRunningMarker(directory, owner), { code })
    assert.equal(existsSync(next), retained)
  }
})

test("simultaneous registration and stale lock recovery elect exactly one primary", async (t) => {
  await t.test("clean", (st) => contenders(temp(st)))
  await t.test("unrelated live registration PID", (st) => {
    const directory = temp(st)
    return contenders(directory, () => writeFileSync(join(directory, "client-state.registration.lock"), JSON.stringify({ pid: process.pid, runToken: "old" })))
  })
  for (let round = 0; round < 10; round++) await t.test(`reused primary PID ${round}`, (st) => {
    const directory = temp(st)
    return contenders(directory, () => {
      const owner = { pid: process.pid, runToken: `old-${round}`, processStartIdentity: `old-start-${round}` }
      writeFileSync(join(directory, "client-state.primary.lock"), JSON.stringify(owner))
      createRunningMarker(directory, owner)
    })
  })
})

test("overlapping stale-registration recovery cannot leave all contenders secondary", async (t) => {
  const directory = temp(t), start = join(directory, "start"), paused = join(directory, "paused"), release = join(directory, "release")
  writeFileSync(join(directory, "client-state.registration.lock"), JSON.stringify({ pid: process.pid, runToken: "old" }))
  const children = [child(directory, start, "40", paused, release), child(directory, start, "40", paused, release)]
  try {
    writeFileSync(start, "")
    const deadline = Date.now() + 2_000
    while (!existsSync(paused) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal(existsSync(paused), true)
    await Promise.race(children.map(({ result }) => result))
    writeFileSync(release, "")
    const roles = await Promise.all(children.map(({ result }) => result))
    assert.equal(roles.filter(({ isPrimary }) => isPrimary).length, 1, JSON.stringify(roles))
  } finally { if (!existsSync(release)) writeFileSync(release, ""); await stop(children) }
})

test("a surviving older secondary keeps later processes secondary", async (t) => {
  const directory = temp(t)
  const launch = async (name: string) => {
    const start = join(directory, name), next = child(directory, start)
    writeFileSync(start, "")
    return { next, role: await next.result }
  }
  const first = await launch("first"); assert.equal(first.role.isPrimary, true)
  const second = await launch("second"); assert.equal(second.role.isPrimary, false)
  await stop([first.next])
  const third = await launch("third")
  await stop([second.next, third.next])
  assert.equal(third.role.isPrimary, false)
})

test("lock recovery handles PID reuse, malformed files, and verified live owners", async (t) => {
  const cases = [
    { name: "same PID old token", owner: { pid: process.pid, runToken: "new" }, file: { pid: process.pid, runToken: "old" }, lock: "primary", alive: () => true, expected: true },
    { name: "malformed registration", owner: { pid: 21, runToken: "new" }, file: "malformed", lock: "registration", alive: () => true, expected: false },
    { name: "live registration marker", owner: { pid: 22, runToken: "new" }, file: { pid: 23, runToken: "live" }, lock: "registration", alive: (pid: number) => pid === 23, marker: true, expected: false },
    { name: "identity-verified registration", owner: { pid: 24, runToken: "new" }, file: { pid: 25, runToken: "live", processStartIdentity: "start" }, lock: "registration", alive: (pid: number) => pid === 25, identity: () => "start", expected: false },
    { name: "live primary marker", owner: { pid: 26, runToken: "new" }, file: { pid: 27, runToken: "live" }, lock: "primary", alive: (pid: number) => pid === 27, marker: true, expected: false },
  ] as const
  for (const value of cases) await t.test(value.name, (st) => {
    const directory = temp(st), primary = join(directory, "client-state.primary.lock"), registration = join(directory, "client-state.registration.lock")
    const path = value.lock === "primary" ? primary : registration
    writeFileSync(path, typeof value.file === "string" ? value.file : JSON.stringify(value.file))
    if ("marker" in value && value.marker && typeof value.file !== "string") createRunningMarker(directory, value.file)
    const started = Date.now()
    const elected = electClientStateProcess(directory, value.owner, { primaryLockPath: primary, registrationLockPath: registration }, () => {}, value.alive, 30, () => {}, "identity" in value ? value.identity : undefined)
    assert.equal(elected, value.expected)
    assert.ok(Date.now() - started < 500)
    if (!value.expected) assert.deepEqual(readFileSync(path, "utf8"), typeof value.file === "string" ? value.file : JSON.stringify(value.file))
    removeRunningMarkerIfOwned(getRunningMarkerPath(directory, value.owner), value.owner)
    removeProcessOwnerLockIfOwned(primary, value.owner)
  })
  assert.equal(REGISTRATION_LOCK_WAIT_MS, 1_000)
})
