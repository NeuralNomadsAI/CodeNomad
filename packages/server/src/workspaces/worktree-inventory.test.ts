import assert from "node:assert/strict"
import { it } from "node:test"
import type { WorktreeListResponse } from "../api-types"
import { WorktreeInventory } from "./worktree-inventory"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const snapshot = (branch: string): WorktreeListResponse => ({
  isGitRepo: true,
  worktrees: [{ slug: "root", directory: "/repo", kind: "root", branch }],
})

function fixture() {
  let now = 1
  const scans: ReturnType<typeof deferred<WorktreeListResponse>>[] = []
  const changes: string[] = []
  const failures: unknown[] = []
  const cache = new WorktreeInventory({
    now: () => now,
    load: async () => {
      const scan = deferred<WorktreeListResponse>()
      scans.push(scan)
      return scan.promise
    },
    changed: id => { changes.push(id) },
    failed: (_id, error) => { failures.push(error) },
  })
  return { cache, scans, changes, failures, advance: () => { now += 10_001 } }
}

const turn = () => new Promise<void>(resolve => setImmediate(resolve))

async function seed(f: ReturnType<typeof fixture>) {
  const read = f.cache.read("repo")
  await turn()
  f.scans[0].resolve(snapshot("main"))
  await read
}

it("shares cold reads and retains their result across sequential requests", async () => {
  const f = fixture()
  const reads = [f.cache.read("repo"), f.cache.read("repo", "validated")]
  await turn()
  assert.equal(f.scans.length, 1)
  f.scans[0].resolve(snapshot("main"))
  assert.deepEqual(await Promise.all(reads), [snapshot("main"), snapshot("main")])
  assert.deepEqual(await f.cache.read("repo"), snapshot("main"))
  assert.equal(f.scans.length, 1)
  assert.deepEqual(f.changes, [])
})

it("returns expired data immediately and runs one lazy refresh for all consumers", async () => {
  const f = fixture()
  await seed(f)
  f.advance()
  await turn()
  assert.equal(f.scans.length, 1, "expiry alone must not start Git")
  const reads = await Promise.all(Array.from({ length: 20 }, () => f.cache.read("repo")))
  assert.ok(reads.every(value => value.worktrees[0].branch === "main"))
  assert.equal(f.scans.length, 2)
  let authorized = false
  const validation = f.cache.read("repo", "validated").then(value => { authorized = true; return value })
  await turn()
  assert.equal(authorized, false, "authorization must not use expired display data")
  f.scans[1].resolve(snapshot("feature"))
  assert.deepEqual(await validation, snapshot("feature"))
  assert.deepEqual(await f.cache.read("repo"), snapshot("feature"))
  assert.deepEqual(f.changes, ["repo"])
  assert.equal(f.scans.length, 2)
})

it("invalidates lazily and forces fresh family reads even inside the TTL", async () => {
  const f = fixture()
  await seed(f)
  f.cache.invalidate()
  assert.equal(f.scans.length, 1)
  assert.deepEqual(await f.cache.read("repo"), snapshot("main"))
  const validated = f.cache.read("repo", "validated")
  f.scans[1].resolve(snapshot("feature"))
  await validated
  const fresh = f.cache.read("repo", "fresh")
  await turn()
  assert.equal(f.scans.length, 3)
  f.scans[2].resolve(snapshot("feature"))
  await fresh
  assert.deepEqual(f.changes, ["repo"], "unchanged scans must not cause an SSE reload loop")
})

it("fences a scan overtaken by a mutation and serializes a trailing validation", async () => {
  const f = fixture()
  await seed(f)
  const fresh = f.cache.read("repo", "fresh")
  await turn()
  f.cache.invalidate("repo")
  const afterMutation = f.cache.read("repo", "validated")
  assert.equal(f.scans.length, 2)
  f.scans[1].resolve(snapshot("obsolete"))
  await turn()
  assert.deepEqual(f.changes, [])
  assert.equal(f.scans.length, 3)
  assert.deepEqual(await f.cache.read("repo"), snapshot("main"))
  f.scans[2].resolve(snapshot("new"))
  assert.deepEqual(await Promise.all([fresh, afterMutation]), [snapshot("new"), snapshot("new")])
  assert.deepEqual(f.changes, ["repo"])
})

it("keeps the last good display snapshot on failure with demand-driven retry backoff", async () => {
  const f = fixture()
  await seed(f)
  f.advance()
  await f.cache.read("repo")
  await f.cache.read("repo")
  const validated = f.cache.read("repo", "validated")
  const rejected = assert.rejects(validated, /offline/)
  f.scans[1].reject(new Error("offline"))
  await rejected
  await turn()
  assert.deepEqual(await f.cache.read("repo"), snapshot("main"))
  assert.equal(f.failures.length, 1)
  assert.equal(f.scans.length, 2)
  f.advance()
  await f.cache.read("repo")
  const retry = f.cache.read("repo", "validated")
  f.scans[2].resolve(snapshot("recovered"))
  await retry
  assert.deepEqual(f.changes, ["repo"])
})

it("never republishes a scan after workspace disposal and isolates workspace keys", async () => {
  const f = fixture()
  await seed(f)
  const fresh = f.cache.read("repo", "fresh")
  const rejected = assert.rejects(fresh, /disposed/)
  await turn()
  f.cache.forget("repo")
  const other = f.cache.read("other")
  await turn()
  f.scans[1].resolve(snapshot("obsolete"))
  f.scans[2].resolve(snapshot("other"))
  await rejected
  assert.deepEqual(await other, snapshot("other"))
  assert.deepEqual(f.changes, [])
  const reopened = f.cache.read("repo")
  await turn()
  assert.equal(f.scans.length, 4)
  f.scans[3].resolve(snapshot("reopened"))
  assert.deepEqual(await reopened, snapshot("reopened"))
})

it("waits for the post-mutation inventory instead of returning a pre-create display snapshot", async () => {
  const f = fixture()
  await seed(f)
  f.cache.invalidate(undefined, "blocking")
  let settled = false
  const read = f.cache.read("repo").then(value => { settled = true; return value })
  await turn()
  assert.equal(settled, false)
  const created = snapshot("main")
  created.worktrees.push({ slug: "new", directory: "/repo/new", kind: "worktree" })
  f.scans[1].resolve(created)
  assert.deepEqual(await read, created)
  assert.deepEqual(f.changes, ["repo"])
})
