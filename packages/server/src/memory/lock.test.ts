import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import { hostname, tmpdir } from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import test from "node:test"
import { lockMemoryRepository } from "./lock"
import { lookupProcess } from "../host-lifetime/process-identity"

async function directory(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "memory-lock-"))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  return path.join(root, "memory")
}

test("Windows release retries sharing violations and never retires a successor", { skip: process.platform !== "win32" }, async t => {
  const target = await directory(t)
  const release = await lockMemoryRepository(target)
  const holder = spawn("pwsh", ["-NoProfile", "-Command", "$f=[IO.File]::Open($env:LOCK_OWNER,'Open','Read','Read'); [Console]::WriteLine('ready'); [Console]::Out.Flush(); [Console]::ReadLine() | Out-Null; $f.Dispose()"], {
    windowsHide: true, env: { ...process.env, LOCK_OWNER: `${target}.lock/owner` }, stdio: ["pipe", "pipe", "pipe"],
  })
  t.after(() => { if (holder.exitCode === null && holder.signalCode === null) holder.kill() })
  const ended = once(holder, "close")
  await once(holder.stdout, "data")
  let released = false
  const releasing = release().then(() => { released = true })
  await delay(100)
  assert.equal(released, false, "a Windows read handle denies the directory rename")
  holder.stdin.end("release\n")
  await ended
  await releasing
  const successor = await lockMemoryRepository(target)
  const owner = await readFile(`${target}.lock/owner`, "utf8")
  await release()
  assert.equal(await readFile(`${target}.lock/owner`, "utf8"), owner)
  await successor()
  await assert.rejects(readFile(`${target}.lock/owner`), { code: "ENOENT" })
})

test("PID reuse recovers the exited process generation rather than retaining a live unrelated PID", async t => {
  const target = await directory(t)
  const release = await lockMemoryRepository(target)
  const previous = JSON.parse(await readFile(`${target}.lock/owner`, "utf8"))
  await release()
  previous.startIdentity += ":previous-generation"
  await mkdir(`${target}.lock`)
  await writeFile(`${target}.lock/owner`, JSON.stringify(previous))
  const successor = await lockMemoryRepository(target)
  assert.notEqual(JSON.parse(await readFile(`${target}.lock/owner`, "utf8")).nonce, previous.nonce)
  await successor()
  assert.ok(!(await readdir(path.dirname(target))).includes(`memory.lock.dead-${previous.nonce}`))
  for (let i = 0; i < 3; i++) await (await lockMemoryRepository(target))()
})

test("unknown process evidence and another execution host retain the exact owner", async t => {
  const target = await directory(t)
  const previous = { pid: 123456789, nonce: randomUUID(), startIdentity: "original", host: hostname(), platform: process.platform }
  await mkdir(`${target}.lock`)
  const original = JSON.stringify(previous)
  await writeFile(`${target}.lock/owner`, original)
  const lookup = async (pid: number) => pid === process.pid
    ? { state: "live" as const, startIdentity: "self" } : { state: "unknown" as const }
  await assert.rejects(lockMemoryRepository(target, lookup), { code: "conflict" })
  assert.equal(await readFile(`${target}.lock/owner`, "utf8"), original)
  previous.host += ":another-host"
  const foreign = JSON.stringify(previous)
  await writeFile(`${target}.lock/owner`, foreign)
  await assert.rejects(lockMemoryRepository(target, lookup), { code: "conflict" })
  assert.equal(await readFile(`${target}.lock/owner`, "utf8"), foreign)
})

test("an unavailable own start identity publishes no lock", async t => {
  const target = await directory(t)
  await assert.rejects(lockMemoryRepository(target, async () => ({ state: "unknown" })), { code: "conflict" })
  assert.deepEqual(await readdir(path.dirname(target)), [])
})

test("an owner that releases and exits during the death probe cannot authorize retiring its live successor", async t => {
  const target = await directory(t)
  const original = { pid: 123456789, nonce: randomUUID(), startIdentity: "exiting", host: hostname(), platform: process.platform }
  await mkdir(`${target}.lock`)
  await writeFile(`${target}.lock/owner`, JSON.stringify(original))
  const current = await lookupProcess(process.pid)
  assert.equal(current.state, "live")
  let successor: (() => Promise<void>) | undefined
  let ready!: () => void
  const published = new Promise<void>(resolve => { ready = resolve })
  const lookup = async (pid: number) => {
    if (pid === process.pid) return current
    assert.equal(pid, original.pid)
    const retired = `${target}.normal-release`
    await rename(`${target}.lock`, retired)
    await rm(retired, { recursive: true })
    successor = await lockMemoryRepository(target)
    ready()
    return { state: "dead" as const }
  }
  let acquired = false
  const pending = lockMemoryRepository(target, lookup).then(release => { acquired = true; return release })
  await published
  await delay(100)
  assert.equal(acquired, false, "the old death probe must preserve the successor's critical section")
  await successor!()
  await (await pending)()
  assert.ok(!(await readdir(path.dirname(target))).some(name => name.startsWith("memory.lock.dead-")))
})

test("a forcibly killed native owner is recoverable and concurrent reapers preserve the successor", async t => {
  const target = await directory(t)
  const module = new URL("./lock.ts", import.meta.url).href
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { lockMemoryRepository } from ${JSON.stringify(module)};
    await lockMemoryRepository(${JSON.stringify(target)});
    console.log('ready'); process.stdin.resume();
  `], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] })
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill() })
  await once(child.stdout, "data")
  const exited = once(child, "exit")
  child.kill("SIGKILL")
  await exited
  let active = 0
  await Promise.all(Array.from({ length: 4 }, async () => {
    const release = await lockMemoryRepository(target)
    try { assert.equal(++active, 1); await delay(5); active-- }
    finally { await release() }
  }))
  await (await lockMemoryRepository(target))()
  assert.ok(!(await readdir(path.dirname(target))).some(name => name.startsWith("memory.lock.dead-")))
})

test("recovery markers remain while an old reaper is live and are pruned after it retires", async t => {
  const target = await directory(t)
  const dead = { pid: 123456789, nonce: randomUUID(), startIdentity: "dead-generation", host: hostname(), platform: process.platform }
  const current = await lookupProcess(process.pid)
  assert.equal(current.state, "live")
  if (current.state !== "live") return
  const reaper = { pid: process.pid, nonce: randomUUID(), startIdentity: current.startIdentity, host: hostname(), platform: process.platform }
  const candidate = `${target}.lock.${reaper.nonce}`
  const marker = `${target}.lock.dead-${dead.nonce}`
  await mkdir(candidate); await writeFile(`${candidate}/owner`, JSON.stringify(reaper))
  await mkdir(marker); await writeFile(`${marker}/owner`, JSON.stringify(dead))
  await (await lockMemoryRepository(target))()
  assert.equal(await readFile(`${marker}/owner`, "utf8"), JSON.stringify(dead))
  await rm(candidate, { recursive: true })
  await (await lockMemoryRepository(target))()
  await assert.rejects(readFile(`${marker}/owner`), { code: "ENOENT" })
})

test("repeated owner crashes leave no unbounded marker history after quiescent acquisition", async t => {
  const target = await directory(t)
  for (let index = 0; index < 12; index++) {
    const dead = { pid: process.pid, nonce: randomUUID(), startIdentity: `ended-${index}`, host: hostname(), platform: process.platform }
    await mkdir(`${target}.lock`); await writeFile(`${target}.lock/owner`, JSON.stringify(dead))
    await (await lockMemoryRepository(target))()
    assert.deepEqual(await readdir(path.dirname(target)), [])
  }
})

test("contended publication and retirement retain exclusion across repeated reader handoffs", async t => {
  const target = await directory(t)
  let active = 0, completed = 0
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (let i = 0; i < 20; i++) {
      const release = await lockMemoryRepository(target)
      try { assert.equal(++active, 1); await delay(1); completed++; active-- }
      finally { await release() }
    }
  }))
  assert.equal(completed, 80)
  await assert.rejects(readFile(`${target}.lock/owner`), { code: "ENOENT" })
})
