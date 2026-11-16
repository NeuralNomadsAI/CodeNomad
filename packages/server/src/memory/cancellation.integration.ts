import assert from "node:assert/strict"
import fs from "node:fs"
import { syncBuiltinESMExports } from "node:module"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { resolveConfigLocation } from "../config/location"
import { SettingsService } from "../settings/service"
import { MemoryGit } from "./git"
import { lockMemoryRepository } from "./lock"
import type { MemoryEntry } from "./model"
import { MemoryService } from "./service"
import { decodeMemoryEntry, MemoryStore } from "./store"

const global = { scope: "global" } as const
const entry: MemoryEntry = {
  id: "editor", title: "Editor", type: "preference", text: "Use Visual Studio Code.",
  sessionId: "ses_memory_test", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
}
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
const save = (store: MemoryStore) => store.mutate(global, () => ({ kind: "save", entry, result: true }))

async function temporary(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "memory-cancellation-"))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  return root
}

function service(root: string, store: MemoryStore) {
  const config = resolveConfigLocation(path.join(root, "config.yaml"))
  const logger = { child() { return this }, warn() {}, info() {}, debug() {}, error() {} }
  const settings = new SettingsService(config, undefined, logger as never)
  const memory = new MemoryService(store, settings, {} as never, { publish() {} } as never)
  return { memory, config }
}

async function candidate(t: test.TestContext, root: string) {
  await t.waitFor(async () => {
    assert.ok((await readdir(root)).some(name => /^memory\.lock\.[a-f0-9-]{36}$/.test(name)))
  }, { timeout: 5000, interval: 10 })
}

for (const operation of ["lock", "list", "cleanup", "mutate"] as const) {
  test(`cancellation abandons a waiting ${operation} candidate without touching its owner`, { timeout: 60_000 }, async t => {
    const root = await temporary(t), store = new MemoryStore(root)
    await save(store)
    const git = new MemoryGit(store.directory), head = await git.head()
    const release = await lockMemoryRepository(store.directory)
    const ownerFile = `${store.directory}.lock/owner`
    const owner = await readFile(ownerFile, "utf8")
    const caller = new AbortController()
    let decided = false, settled = false
    const pending = operation === "lock" ? lockMemoryRepository(store.directory, undefined, caller.signal)
      : operation === "list" ? store.listForUI(global, caller.signal)
      : operation === "cleanup" ? store.cleanupWritable(global, caller.signal)
      : store.mutate(global, () => {
        decided = true
        return { kind: "save", entry: { ...entry, text: "Must not be written." }, result: true }
      }, caller.signal)
    const outcome = pending.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }))
      .finally(() => { settled = true })
    try {
      await candidate(t, root)
      assert.equal(settled, false)
      caller.abort()
      await t.waitFor(() => assert.ok(settled), { timeout: 2000, interval: 10 })
      const result = await outcome
      if (operation === "cleanup") {
        assert.equal(result.error, undefined)
        assert.equal(result.value, false)
      } else assert.equal(result.error?.name, "AbortError")
      assert.equal(decided, false)
      assert.equal(await readFile(ownerFile, "utf8"), owner)
      assert.deepEqual((await readdir(root)).filter(name => name.startsWith("memory.lock")), ["memory.lock"])
      assert.equal(await git.head(), head)
    } finally {
      caller.abort()
      await release()
      const result = await outcome
      if (typeof result.value === "function") await result.value()
    }
    assert.deepEqual(await store.list(global), [entry])
    await (await lockMemoryRepository(store.directory))()
  })
}

test("cancellation during a real UI read refuses its result and preserves entry bytes and history", { timeout: 60_000 }, async t => {
  const root = await temporary(t), store = new MemoryStore(root)
  await save(store)
  const { memory } = service(root, store)
  const git = new MemoryGit(store.directory), head = await git.head()
  const file = path.join(store.directory, "global", `${entry.id}.md`), before = await readFile(file)
  const reached = deferred(), gate = deferred(), caller = new AbortController()
  const list = store.listForUI.bind(store)
  const mock = t.mock.method(store, "listForUI", async (...args: Parameters<MemoryStore["listForUI"]>) => {
    const entries = await list(...args)
    reached.resolve()
    await gate.promise
    return entries
  })
  const pending = memory.executeUI({ action: "read", scope: "global", query: entry.id }, undefined, caller.signal)
  const rejected = assert.rejects(pending, { name: "AbortError" })
  try {
    await reached.promise
    caller.abort()
  } finally { gate.resolve() }
  await rejected
  mock.mock.restore()
  assert.deepEqual(await readFile(file), before)
  assert.equal(await git.head(), head)
  assert.deepEqual(await store.list(global), [entry])
})

test("cancellation while a locked decision awaits prevents a new journal or write", { timeout: 60_000 }, async t => {
  const root = await temporary(t), store = new MemoryStore(root)
  await save(store)
  const git = new MemoryGit(store.directory), head = await git.head()
  const reached = deferred(), gate = deferred(), caller = new AbortController()
  const pending = store.mutate(global, async entries => {
    assert.deepEqual(entries, [entry])
    reached.resolve()
    await gate.promise
    return { kind: "save", entry: { ...entry, text: "Must not be written." }, result: true }
  }, caller.signal)
  const rejected = assert.rejects(pending, { name: "AbortError" })
  try {
    await reached.promise
    caller.abort()
  } finally { gate.resolve() }
  await rejected
  await assert.rejects(readFile(path.join(store.directory, ".transaction.json")), { code: "ENOENT" })
  assert.equal(await git.head(), head)
  assert.deepEqual(await store.list(global), [entry])
  await (await lockMemoryRepository(store.directory))()
})

test("cancellation during Git initialization prevents journal admission and leaves the lock reusable", { timeout: 60_000 }, async t => {
  const root = await temporary(t), reached = deferred(), gate = deferred(), caller = new AbortController()
  class InitializingGit extends MemoryGit {
    override async initialize() {
      await super.initialize()
      reached.resolve()
      await gate.promise
    }
  }
  const git = new InitializingGit(path.join(root, "memory")), store = new MemoryStore(root, git)
  const pending = store.mutate(global, () => ({ kind: "save", entry, result: true }), caller.signal)
  const rejected = assert.rejects(pending, { name: "AbortError" })
  try {
    await reached.promise
    caller.abort()
  } finally { gate.resolve() }
  await rejected
  for (const file of [".transaction.json", `global/${entry.id}.md`])
    await assert.rejects(readFile(path.join(store.directory, file)), { code: "ENOENT" })
  assert.equal(await git.head(), undefined)
  const fresh = new MemoryStore(root)
  await save(fresh)
  assert.deepEqual(await fresh.list(global), [entry])
  assert.equal((await git.run(["rev-list", "--count", "HEAD"])).trim(), "1")
})

for (const phase of ["journal", "commit"] as const) {
  test(`cancellation after accepted ${phase} preserves durability but refuses the service acknowledgement`, { timeout: 60_000 }, async t => {
    const root = await temporary(t), initial = new MemoryStore(root)
    await save(initial)
    const reached = deferred(), gate = deferred(), caller = new AbortController()
    class CommittingGit extends MemoryGit {
      override async commit(file: string, id: string) {
        const journal = JSON.parse(await readFile(path.join(this.directory, ".transaction.json"), "utf8"))
        assert.equal(journal.id, id)
        assert.equal(journal.file, file)
        if (phase === "commit") await super.commit(file, id)
        reached.resolve()
        await gate.promise
        if (phase === "journal") await super.commit(file, id)
      }
    }
    const git = new CommittingGit(initial.directory), store = new MemoryStore(root, git)
    const { memory } = service(root, store)
    await memory.setEnabled(true)
    const displayed = await memory.executeUI({ action: "read", scope: "global", query: entry.id })
    assert.ok("entry" in displayed && displayed.entry)
    const text = "Use the project editor configuration."
    const pending = memory.executeUI({ action: "save", scope: "global", id: entry.id,
      revision: displayed.entry.revision, content: { title: entry.title, type: entry.type, text } }, undefined, caller.signal)
    const rejected = assert.rejects(pending, { name: "AbortError" })
    try {
      await reached.promise
      caller.abort()
    } finally { gate.resolve() }
    await rejected
    await assert.rejects(readFile(path.join(store.directory, ".transaction.json")), { code: "ENOENT" })
    const fresh = new MemoryStore(root), saved = await fresh.read(global, entry.id)
    assert.equal(saved?.text, text)
    assert.deepEqual(decodeMemoryEntry(await git.run(["show", `HEAD:global/${entry.id}.md`])), saved)
    assert.equal((await git.run(["rev-list", "--count", "HEAD"])).trim(), "2")
    assert.equal(await git.run(["status", "--porcelain"]), "")
    await fresh.list(global)
    assert.equal((await git.run(["rev-list", "--count", "HEAD"])).trim(), "2")
    await (await lockMemoryRepository(store.directory))()
  })
}

test("setEnabled cancellation abandons its waiting lock without persisting the preference", { timeout: 60_000 }, async t => {
  const root = await temporary(t), store = new MemoryStore(root)
  const { memory, config } = service(root, store)
  await memory.setEnabled(false)
  const before = await readFile(config.configYamlPath)
  const release = await lockMemoryRepository(store.directory)
  const owner = await readFile(`${store.directory}.lock/owner`, "utf8")
  const caller = new AbortController()
  let settled = false
  const rejected = assert.rejects(memory.setEnabled(true, caller.signal), { name: "AbortError" })
    .finally(() => { settled = true })
  try {
    await candidate(t, root)
    caller.abort()
    await t.waitFor(() => assert.ok(settled), { timeout: 2000, interval: 10 })
    await rejected
    assert.equal(await readFile(`${store.directory}.lock/owner`, "utf8"), owner)
    assert.deepEqual(await readFile(config.configYamlPath), before)
    assert.deepEqual(memory.getSettings(), { enabled: false })
    assert.deepEqual((await readdir(root)).filter(name => name.startsWith("memory.lock")), ["memory.lock"])
  } finally {
    caller.abort()
    await release()
    await rejected
  }
  assert.deepEqual(await memory.setEnabled(true), { enabled: true })
})

test("revocation during journal fsync refuses the rename and preserves entry bytes and Git history", { timeout: 60_000 }, async t => {
  const root = await temporary(t), store = new MemoryStore(root)
  await save(store)
  const git = new MemoryGit(store.directory), head = await git.head()
  const file = path.join(store.directory, "global", `${entry.id}.md`), before = await readFile(file)
  const journal = path.join(store.directory, ".transaction.json")
  const reached = deferred(), gate = deferred(), caller = new AbortController()
  const open = fs.promises.open
  const mock = t.mock.method(fs.promises, "open", async (...args: Parameters<typeof open>) => {
    const handle = await open(...args)
    const target = String(args[0])
    if (path.dirname(target) === store.directory && path.basename(target).startsWith(".transaction.json.") && target.endsWith(".tmp")) {
      const sync = handle.sync.bind(handle)
      handle.sync = async () => { await sync(); reached.resolve(); await gate.promise }
    }
    return handle
  })
  syncBuiltinESMExports()
  const pending = store.mutate(global, () => ({
    kind: "save", entry: { ...entry, text: "Revoked edit must not commit." }, result: undefined,
  }), caller.signal)
  const rejected = assert.rejects(pending, { name: "AbortError" })
  try {
    await reached.promise
    caller.abort()
    await assert.rejects(readFile(journal), { code: "ENOENT" })
    assert.deepEqual(await readFile(file), before)
    assert.equal(await git.head(), head)
    gate.resolve()
    await rejected
  } finally {
    gate.resolve()
    await pending.catch(() => undefined)
    mock.mock.restore()
    syncBuiltinESMExports()
  }
  assert.deepEqual(await readFile(file), before)
  assert.equal(await git.head(), head)
  assert.equal((await git.run(["rev-list", "--count", "HEAD"])).trim(), "1")
  await assert.rejects(readFile(journal), { code: "ENOENT" })
  assert.ok((await readdir(store.directory)).every(name => !name.startsWith(".transaction.json.")))
  assert.deepEqual(await new MemoryStore(root).list(global), [entry])
})
