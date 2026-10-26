import assert from "node:assert/strict"
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, before, test } from "node:test"
import { ensureInvocationDaemon } from "./orchestrate"

let discovery: string, sources: string
before(async () => {
  discovery = await mkdtemp(path.join(tmpdir(), "orchestrate-"))
  sources = await mkdtemp(path.join(tmpdir(), "orchestrate-sources-"))
})
after(async () => { await rm(discovery, { recursive: true, force: true }); await rm(sources, { recursive: true, force: true }) })

const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

test("two concurrent runners never both own the daemon between them", { timeout: 180_000 }, async () => {
  const options = { uiRoot: path.resolve(import.meta.dirname, "../.."), readyDirectory: discovery, warmup: false as const, freshnessRoots: [sources] }
  await writeFile(path.join(sources, "concurrent.tsx"), "export {}")
  await rm(path.join(discovery, "ready"), { force: true })
  await rm(path.join(discovery, "claim"), { force: true })

  // Both runners contend for a cold discovery directory: one starter wins
  // the claim and serves; the loser yields. Exactly the winner's runner may
  // stop the daemon — the loser adopting it must never gain stop rights, or
  // the first finisher kills the daemon out from under the second's slice.
  const [first, second] = await Promise.all([
    ensureInvocationDaemon(options),
    ensureInvocationDaemon(options),
  ])
  assert.equal(first.pid, second.pid, "both runners settle on the same daemon")
  const owners = [first, second].filter(handle => handle.owned)
  assert.equal(owners.length, 1, "exactly one runner owns the daemon, the other adopted it")

  const owner = owners[0], adopter = [first, second].find(handle => !handle.owned)!
  await adopter.stop() // a no-op by contract: adopters never stop what they did not start
  assert.ok(alive(owner.pid), "an adopter's stop() must leave the daemon serving")
  await owner.stop()
  assert.ok(!alive(owner.pid), "the owner's stop() ends the daemon")
})

test("a runner starts one daemon, adopts it while fresh, and replaces it once stale", { timeout: 180_000 }, async () => {
  const options = { uiRoot: path.resolve(import.meta.dirname, "../.."), readyDirectory: discovery, warmup: false as const, freshnessRoots: [sources] }
  await writeFile(path.join(sources, "fixture.tsx"), "export {}")

  const first = await ensureInvocationDaemon(options)
  assert.equal(first.owned, true, "with nothing serving, the runner owns the daemon it starts")
  assert.ok(alive(first.pid))

  const adopted = await ensureInvocationDaemon(options)
  assert.equal(adopted.owned, false, "a concurrent invocation adopts the healthy daemon instead of spawning")
  assert.equal(adopted.pid, first.pid)

  // Sources edited after the daemon started invalidate its graph: the next
  // invocation must retire it and start a fresh one, never borrow stale
  // transforms.
  const edited = new Date(Date.now() + 5_000)
  await utimes(path.join(sources, "fixture.tsx"), edited, edited)
  const replaced = await ensureInvocationDaemon(options)
  assert.equal(replaced.owned, true, "the replacing invocation owns the fresh daemon")
  assert.notEqual(replaced.pid, first.pid)
  const deadline = Date.now() + 15_000
  while (alive(first.pid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 250))
  assert.ok(!alive(first.pid), "the stale daemon was retired")

  await replaced.stop()
  assert.ok(!alive(replaced.pid), "stop() ends an owned daemon")
})
