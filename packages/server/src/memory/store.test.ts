import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile, utimes } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { MemoryError, type MemoryEntry } from "./model"
import { MemoryGit } from "./git"
import { atomicMemoryWrite, decodeMemoryEntry, encodeMemoryEntry, MemoryStore } from "./store"

const global = { scope: "global" } as const
const project = { scope: "project", projectId: "a".repeat(64) } as const
const entry = (id = "entry", text = "Remember this 🧠\n---\nExactly.\n"): MemoryEntry => ({
  id, title: `Title ${id}`, type: "fact", text, sessionId: "ses_memory_test",
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
})
const save = (store: MemoryStore, value = entry(), scope = global as typeof global | typeof project) =>
  store.mutate(scope, () => ({ kind: "save", entry: value, result: value }))

async function temporary(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-memory-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

const storeModule = new URL("./store.ts", import.meta.url).href
const gitModule = new URL("./git.ts", import.meta.url).href

test("cleanup writability probes leave entry bytes and Git history unchanged and refuse read-only entries", async t => {
  const store = new MemoryStore(await temporary(t))
  await save(store)
  const git = new MemoryGit(store.directory), before = await git.head()
  assert.equal(await store.cleanupWritable(global), true)
  assert.equal(await git.head(), before)
  assert.deepEqual(await readdir(path.join(store.directory, "global")), ["entry.md"])
  const file = path.join(store.directory, "global", "entry.md")
  await chmod(file, 0o444)
  try { assert.equal(await store.cleanupWritable(global), false) }
  finally { await chmod(file, 0o600) }
  assert.deepEqual(await store.read(global, "entry"), entry())
  assert.equal(await store.cleanupWritable(project), false)
})

function child(code: string, env: NodeJS.ProcessEnv = {}) {
  const process = spawn(globalThis.process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...globalThis.process.env, ...env },
    cwd: fileURLToPath(new URL("../../../../", import.meta.url)),
  })
  let stdout = "", stderr = ""
  process.stdout.on("data", data => { stdout += data })
  process.stderr.on("data", data => { stderr += data })
  const completed = once(process, "close").then(([code]) => ({ code, stdout, stderr }))
  return { process, completed }
}

test("strict Markdown round-trip preserves text and rejects malformed headers and encodings", () => {
  const value = entry("unicode", "\ntext with trailing whitespace  \r\n😀\n")
  value.title = "A colon: # and a quote \" with 😀"
  assert.deepEqual(decodeMemoryEntry(encodeMemoryEntry(value)), value)
  assert.throws(() => encodeMemoryEntry(entry("surrogate", "\ud800")), { code: "invalid" })
  const source = encodeMemoryEntry(value)
  for (const invalid of ["", "plain Markdown", source.replace("type: fact", "type: wrong"),
    source.replace("---\n", "---\nextra: value\n"), source.replace("---\n", "---\ntext: hidden\n"),
    source.replace("---\n", "---\nid: duplicate\n"), source.replace("---\n", "---\n&anchor [one, two]\n"),
    source.replace("type: fact", "type: !unknown fact")]) {
    assert.throws(() => decodeMemoryEntry(invalid), { code: "malformed" })
  }
})

test("empty reads are lazy, separate scopes and preserve nonempty error states", async t => {
  const root = await temporary(t)
  const config = path.join(root, "absent-config")
  const store = new MemoryStore(config)
  assert.deepEqual(await store.list(global), [])
  assert.deepEqual(await store.list(project), [])
  assert.deepEqual(await readdir(root), [])
  await mkdir(config)
  assert.deepEqual(await store.list(global), [])
  assert.deepEqual(await readdir(config), [])
  await mkdir(path.join(config, "memory", "global"), { recursive: true })
  const file = path.join(config, "memory", "global", "bad.md")
  await writeFile(file, "malformed")
  await assert.rejects(store.list(global), { code: "malformed" })
  await writeFile(file, Buffer.from([0xff, 0xfe]))
  await assert.rejects(store.list(global), { code: "malformed" })
  await writeFile(file, "x".repeat(16_385))
  await assert.rejects(store.list(global), { code: "malformed" })
  await writeFile(file, encodeMemoryEntry(entry()))
  await assert.rejects(store.list(global), { code: "malformed" })
  await rm(file)
  await mkdir(file)
  await assert.rejects(store.list(global), { code: "unreadable" })
  await assert.rejects(store.list({ scope: "project", projectId: "../escape" }), { code: "invalid" })
})

test("real Git records creation, atomic Windows-compatible replacement and deletion locally", async t => {
  const config = await temporary(t)
  const store = new MemoryStore(config)
  const git = new MemoryGit(store.directory)
  const original = entry()
  await save(store, original)
  assert.deepEqual(await store.read(global, original.id), original)
  assert.deepEqual(await store.read(global, original.title), original)
  assert.equal((await git.run(["log", "-1", "--format=%an <%ae>|%cn <%ce>"])).trim(),
    "CodeNomad Memory <memory@codenomad.local>|CodeNomad Memory <memory@codenomad.local>")
  await save(store, original)
  assert.equal((await git.run(["rev-list", "--count", "HEAD"])).trim(), "2", "each accepted write has its own commit")
  const changed = { ...original, text: "Replacement 😀", updatedAt: "2026-01-02T00:00:00Z" }
  await save(store, changed)
  assert.equal(await readFile(path.join(store.directory, "global", "entry.md"), "utf8"), encodeMemoryEntry(changed))
  assert.equal(decodeMemoryEntry(await git.run(["show", "HEAD~1:global/entry.md"])).text, original.text)
  await save(store, entry("project"), project)
  assert.equal((await store.list(global)).length, 1)
  assert.equal((await store.list(project)).length, 1)
  await store.mutate(global, values => ({ kind: "delete", id: values[0]!.id, result: true }))
  assert.deepEqual(await store.list(global), [])
  assert.equal((await git.run(["rev-list", "--count", "HEAD"])).trim(), "5")
  assert.equal(await git.run(["remote"]), "")
  assert.equal(await git.run(["status", "--porcelain"]), "")
  await assert.rejects(store.mutate(global, () => ({ kind: "delete", id: "missing", result: false })), { code: "invalid" })
})

test("atomic replacement failure keeps the previous file and removes its temporary", async t => {
  const root = await temporary(t)
  const file = path.join(root, "entry.md")
  await atomicMemoryWrite(file, "original")
  await atomicMemoryWrite(file, "replacement")
  assert.equal(await readFile(file, "utf8"), "replacement")
  await assert.rejects(atomicMemoryWrite(file, "x".repeat(16_385)), { code: "invalid" })
  // A nonexistent parent fails before publication, without disturbing a different entry.
  await assert.rejects(atomicMemoryWrite(path.join(root, "absent", "entry.md"), "wrong"))
  assert.equal(await readFile(file, "utf8"), "replacement")
  assert.deepEqual(await readdir(root), ["entry.md"])
})

test("real Windows sharing violation preserves the target and cleans the journal", { skip: process.platform !== "win32" }, async t => {
  const config = await temporary(t)
  const store = new MemoryStore(config)
  await save(store)
  const file = path.join(store.directory, "global", "entry.md")
  const holder = spawn("pwsh", ["-NoProfile", "-Command", "$f=[IO.File]::Open($env:MEMORY_FILE,'Open','Read','Read'); [Console]::WriteLine('ready'); [Console]::Out.Flush(); [Console]::ReadLine() | Out-Null; $f.Dispose()"], {
    windowsHide: true, env: { ...process.env, MEMORY_FILE: file }, stdio: ["pipe", "pipe", "pipe"],
  })
  const ended = once(holder, "close")
  t.after(() => { if (holder.exitCode === null) holder.kill() })
  await once(holder.stdout, "data")
  await assert.rejects(save(store, entry("entry", "must fail")), { code: "unreadable" })
  holder.stdin.end("release\n")
  await ended
  assert.deepEqual(await store.read(global, "entry"), entry())
  assert.deepEqual(await readdir(path.dirname(file)), ["entry.md"])
  await assert.rejects(readFile(path.join(store.directory, ".transaction.json")), { code: "ENOENT" })
})

test("failed commits stay unavailable until journal recovery commits the pending write", async t => {
  const config = await temporary(t)
  class FailingGit extends MemoryGit {
    override async commit(): Promise<void> { throw new Error("private Git failure") }
  }
  const failed = new MemoryStore(config, new FailingGit(path.join(config, "memory")))
  await assert.rejects(save(failed), error => error instanceof MemoryError && error.code === "unreadable" && !error.message.includes("private"))
  await assert.rejects(failed.list(global), { code: "unreadable" })
  const recovered = new MemoryStore(config)
  assert.deepEqual(await recovered.list(global), [entry()])
  const git = new MemoryGit(recovered.directory)
  assert.equal((await git.run(["rev-list", "--count", "HEAD"])).trim(), "1")
  assert.equal(await git.run(["status", "--porcelain"]), "")
})

test("recovery preserves the committed history across failed replacement and deletion", async t => {
  const config = await temporary(t)
  const store = new MemoryStore(config)
  await save(store)
  class FailingGit extends MemoryGit {
    override async commit(): Promise<void> { throw new Error("commit failed") }
  }
  const failed = new MemoryStore(config, new FailingGit(store.directory))
  const replacement = entry("entry", "changed after initial commit")
  await assert.rejects(save(failed, replacement), { code: "unreadable" })
  assert.deepEqual(await store.list(global), [replacement])
  const git = new MemoryGit(store.directory)
  assert.deepEqual(decodeMemoryEntry(await git.run(["show", "HEAD~1:global/entry.md"])), entry())
  await assert.rejects(failed.mutate(global, () => ({ kind: "delete", id: "entry", result: true })), { code: "unreadable" })
  assert.deepEqual(await store.list(global), [])
  assert.equal((await git.run(["rev-list", "--count", "HEAD"])).trim(), "3")
  assert.deepEqual(decodeMemoryEntry(await git.run(["show", "HEAD~1:global/entry.md"])), replacement)
})

test("durable journals recover before file publication and reject malformed recovery data", async t => {
  const config = await temporary(t)
  const store = new MemoryStore(config)
  // Simulate a crash immediately after the fsynced journal rename, before replacing the entry.
  await mkdir(path.join(store.directory, "global"), { recursive: true })
  const journal = path.join(store.directory, ".transaction.json")
  await writeFile(journal, JSON.stringify({ version: 1, id: randomUUID(), file: "global/entry.md", content: encodeMemoryEntry(entry()) }))
  assert.deepEqual(await store.list(global), [entry()])
  for (const file of ["../outside.md", "global/con.md", "projects/invalid/entry.md", "global/different.md"]) {
    await writeFile(journal, JSON.stringify({ version: 1, id: randomUUID(), file, content: encodeMemoryEntry(entry()) }))
    await assert.rejects(store.list(global), { code: "malformed" })
  }
  await writeFile(journal, "broken JSON")
  await assert.rejects(store.list(global), { code: "malformed" })
})

test("cross-process decisions are serialized and do not lose concurrent entries", async t => {
  const config = await temporary(t)
  const jobs = Array.from({ length: 5 }, (_, i) => child(`
    import { MemoryStore } from ${JSON.stringify(storeModule)};
    const store = new MemoryStore(${JSON.stringify(config)});
    // Busy is an explicit, retryable result when another real Git operation
    // exceeds the bounded lock wait on a heavily loaded Windows host.
    for(let attempt=0; ; attempt++) {
      try {
        await store.mutate({scope:'global'}, async entries => {
          await new Promise(resolve => setTimeout(resolve, 30));
          if(entries.some(e => e.id === ${JSON.stringify(`child${i}`)})) throw Error('duplicate');
          const entry=${JSON.stringify(entry(`child${i}`))}; entry.text=String(entries.length);
          return {kind:'save', entry, result:true};
        });
        break;
      } catch(error) { if(error.code !== 'conflict' || attempt >= 2) throw error; }
    }
  `))
  t.after(() => jobs.forEach(job => { if (job.process.exitCode === null) job.process.kill() }))
  const results = await Promise.all(jobs.map(job => job.completed))
  for (const result of results) assert.equal(result.code, 0, result.stderr)
  const store = new MemoryStore(config)
  assert.equal((await store.list(global)).length, jobs.length)
  assert.deepEqual((await store.list(global)).map(entry => entry.text).sort(), ["0", "1", "2", "3", "4"])
  assert.equal((await new MemoryGit(store.directory).run(["rev-list", "--count", "HEAD"])).trim(), "5")
})

test("old locks remain owned while the owner lives", async t => {
  const config = await temporary(t)
  const ready = path.join(config, "ready")
  const release = path.join(config, "release")
  const owner = child(`
    import { MemoryStore } from ${JSON.stringify(storeModule)};
    import { access, writeFile } from 'node:fs/promises';
    await new MemoryStore(${JSON.stringify(config)}).mutate({scope:'global'}, async () => {
      await writeFile(${JSON.stringify(ready)}, 'ready');
      while(!await access(${JSON.stringify(release)}).then(() => true, () => false)) await new Promise(r => setTimeout(r, 10));
      return {kind:'save', entry:${JSON.stringify(entry("owner"))}, result:true};
    });
  `)
  t.after(() => { if (owner.process.exitCode === null) owner.process.kill() })
  // A filesystem signal coordinates the actual subprocess rather than a timing guess.
  for (let i = 0; ; i++) {
    if (await readFile(ready).then(() => true, () => false)) break
    assert.ok(i < 1000, "owner did not acquire lock")
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  await utimes(path.join(config, "memory.lock"), 1, 1)
  let completed = false
  const pending = save(new MemoryStore(config), entry("waiter"), project).then(() => { completed = true })
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(completed, false)
  await writeFile(release, "go")
  assert.equal((await owner.completed).code, 0)
  await pending
  assert.equal((await new MemoryStore(config).list(global)).length, 1)
  assert.equal((await new MemoryStore(config).list(project)).length, 1)
})

for (const afterCommit of [false, true]) {
  test(`crashed writer recovers ${afterCommit ? "after" : "before"} Git commit without duplicate history`, async t => {
    const config = await temporary(t)
    const code = `
      import { MemoryStore } from ${JSON.stringify(storeModule)};
      import { MemoryGit } from ${JSON.stringify(gitModule)};
      class CrashingGit extends MemoryGit { async commit(file, id) { ${afterCommit ? "await super.commit(file, id);" : ""} process.exit(86); } }
      const root=${JSON.stringify(config)};
      await new MemoryStore(root, new CrashingGit(root+'/memory')).mutate({scope:'global'}, () => ({kind:'save',entry:${JSON.stringify(entry())},result:true}));
    `
    assert.equal((await child(code).completed).code, 86)
    const store = new MemoryStore(config)
    // Several simultaneous dead-owner reapers must preserve the next live owner.
    const readers = await Promise.all(Array.from({ length: 3 }, () => new MemoryStore(config).list(global)))
    for (const entries of readers) assert.deepEqual(entries, [entry()])
    assert.equal((await new MemoryGit(store.directory).run(["rev-list", "--count", "HEAD"])).trim(), "1")
    assert.ok((await readdir(config)).some(name => name.startsWith("memory.lock.dead-")))
  })
}

test("Git redirects, injected config, hooks, signing and clean filters cannot affect writes", async t => {
  const config = await temporary(t)
  const unrelated = path.join(config, "unrelated")
  await mkdir(unrelated)
  const store = new MemoryStore(config)
  await save(store)
  const git = new MemoryGit(store.directory)
  const marker = path.join(config, "hook-was-run")
  const hooks = path.join(store.directory, ".git", "hooks")
  await mkdir(hooks, { recursive: true })
  await writeFile(path.join(hooks, "pre-commit"), `#!/bin/sh\necho unsafe > '${marker.replaceAll("\\", "/")}'\nexit 1\n`, { mode: 0o755 })
  await writeFile(path.join(hooks, "reference-transaction"), `#!/bin/sh\necho unsafe > '${marker.replaceAll("\\", "/")}'\nexit 1\n`, { mode: 0o755 })
  await git.run(["config", "commit.gpgsign", "true"])
  await git.run(["config", "gpg.program", "codenomad-test-program-that-does-not-exist"])
  await git.run(["config", "filter.danger.clean", "codenomad-test-filter-that-does-not-exist"])
  await git.run(["config", "filter.danger.required", "true"])
  await writeFile(path.join(store.directory, ".gitattributes"), "*.md filter=danger\n")
  const result = await child(`
    import { MemoryStore } from ${JSON.stringify(storeModule)};
    await new MemoryStore(${JSON.stringify(config)}).mutate({scope:'global'}, () => ({kind:'save',entry:${JSON.stringify(entry("second"))},result:true}));
  `, { GIT_DIR: unrelated, GIT_WORK_TREE: unrelated, GIT_INDEX_FILE: path.join(unrelated, "index"),
    GIT_OBJECT_DIRECTORY: unrelated, GIT_COMMON_DIR: unrelated, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: hooks,
    GIT_AUTHOR_NAME: "Untrusted", GIT_COMMITTER_EMAIL: "untrusted@example.com" }).completed
  assert.equal(result.code, 0, result.stderr)
  assert.deepEqual(await readdir(unrelated), [])
  await assert.rejects(readFile(marker), { code: "ENOENT" })
  assert.deepEqual(decodeMemoryEntry(await git.run(["show", "HEAD:global/second.md"])), entry("second"))
  assert.equal((await git.run(["log", "-1", "--format=%an <%ce>"])).trim(), "CodeNomad Memory <memory@codenomad.local>")
})

test("missing Git uses git_required and leaves entries untouched", async t => {
  const config = await temporary(t)
  const result = await child(`
    import { MemoryStore } from ${JSON.stringify(storeModule)};
    const store = new MemoryStore(${JSON.stringify(config)});
    if((await store.list({scope:'global'})).length) throw Error('not empty');
    process.env.PATH=${JSON.stringify(config)};
    try { await store.mutate({scope:'global'}, () => ({kind:'save',entry:${JSON.stringify(entry())},result:true})); process.exitCode=2; }
    catch(error) { console.log(error.code); if(error.code !== 'git_required') throw error; }
  `).completed
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.stdout.trim(), "git_required")
  assert.deepEqual(await readdir(config), [])
})
