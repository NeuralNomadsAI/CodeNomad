import assert from "node:assert/strict"
import { test } from "node:test"
import { watch } from "node:fs"
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { NativeMutationAdmission, NativeMutationUncertainError } from "./native-mutation-authority"
import { appendPluginControlRule, readPluginControlDocument, replacePluginControlDocument } from "./plugin-control-document"
import { createWslPluginControlDocumentFileSystem } from "./plugin-control-document-wsl"

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

test("admission observes only first dispatch, keeps asserting later admissions, and uncertainty is sticky", async () => {
  let calls = 0, revoked = false
  const refused = new Error("revoked")
  const admission = new NativeMutationAdmission({ async revalidate() {}, assertCurrent() { if (revoked) throw refused }, onSubmitted() { calls++ } })
  await admission.revalidate(); assert.equal(calls, 0)
  assert.equal(admission.failure(refused), refused)
  admission.admit(); admission.admit(); assert.equal(calls, 1)
  revoked = true
  assert.throws(() => admission.admit(), error => error === refused)
  assert.ok(admission.failure(refused) instanceof NativeMutationUncertainError)
  assert.ok(admission.failure(new Error("later")) instanceof NativeMutationUncertainError)
  assert.equal(calls, 1)
  const ordinary = new NativeMutationAdmission(); ordinary.admit(); assert.equal(ordinary.failure(refused), refused)
})

test("host writer revalidates after real interprocess lock wait and cleans preparation on refusal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-admission-")), file = path.join(root, "opencode.jsonc")
  const lock = `${file}.codenomad-plugin-controls.lock`
  let closeWatch = () => {}
  try {
    await writeFile(file, '{"plugins":[]}\n')
    const document = await readPluginControlDocument(file)
    await mkdir(lock); await writeFile(path.join(lock, "owner"), "other")
    const prepared = deferred()
    const watcher = watch(root, (_event, filename) => { if (filename?.toString().endsWith(".tmp")) prepared.resolve() })
    closeWatch = () => watcher.close()
    let revalidated = 0, dispatched = 0, revoked = false
    const work = replacePluginControlDocument(document, appendPluginControlRule(document, "-fixture"), {
      async revalidate() { revalidated++; await Promise.resolve(); if (revoked) throw new Error("revoked during lock wait") },
      assertCurrent() {}, onDispatch() { dispatched++ },
    })
    const rejected = assert.rejects(work)
    await Promise.race([prepared.promise, work.then(() => assert.fail("writer finished without preparation"), () => assert.fail("writer refused before preparation"))])
    // The real writer has prepared its temporary file; hold the foreign lock across a retry turn.
    await new Promise(resolve => setTimeout(resolve, 40))
    assert.equal(revalidated, 0); assert.equal(dispatched, 0)
    assert.equal(await readFile(path.join(lock, "owner"), "utf8"), "other")
    assert.equal(await readFile(file, "utf8"), '{"plugins":[]}\n')
    revoked = true
    await rm(lock, { recursive: true })
    await rejected
    assert.equal(revalidated, 1); assert.equal(dispatched, 0)
    assert.equal(await readFile(file, "utf8"), '{"plugins":[]}\n')
    assert.deepEqual(await readdir(root), ["opencode.jsonc"])
  } finally { closeWatch(); await rm(root, { recursive: true, force: true }) }
})

test("host writer final unchanged verification follows async revalidation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-admission-")), file = path.join(root, "opencode.jsonc")
  const entered = deferred(), release = deferred()
  try {
    await writeFile(file, '{}\n')
    const document = await readPluginControlDocument(file)
    let dispatched = 0
    const work = replacePluginControlDocument(document, appendPluginControlRule(document, "-fixture"), {
      async revalidate() { entered.resolve(); await release.promise },
      onDispatch() { dispatched++ },
    })
    const rejected = assert.rejects(work)
    await entered.promise
    assert.ok((await readdir(root)).some(name => name.endsWith(".tmp")))
    await writeFile(file, '{"external":true}\n')
    release.resolve(); await rejected
    assert.equal(dispatched, 0); assert.equal(await readFile(file, "utf8"), '{"external":true}\n')
    assert.deepEqual(await readdir(root), ["opencode.jsonc"])
  } finally { release.resolve(); await rm(root, { recursive: true, force: true }) }
})

test("WSL writer revalidates after prepare and before commit, preserving cleanup and synchronous assertions", async () => {
  const calls: string[] = []
  const prepared = deferred(), release = deferred()
  let revoked = false
  const fileSystem = createWslPluginControlDocumentFileSystem("fixture", async (_distro, script) => {
    calls.push(script.split("\n")[0]!)
    if (script.startsWith("# prepare-document")) { prepared.resolve(); await release.promise }
    return { status: 0, stderr: Buffer.alloc(0), stdout: Buffer.alloc(0) }
  })
  // The native executor boundary is simulated; the real WSL writer still owns prepare/commit ordering.
  const document = { requestedPath: "/config/opencode.jsonc", writePath: "/config/opencode.jsonc", exists: true,
    mode: 0o600, text: "{}\n", byteOrderMark: false, plugins: [] }
  let dispatched = 0, assertions = 0
  const work = replacePluginControlDocument(document, appendPluginControlRule(document, "-fixture"), {
    assertCurrent() { assertions++ },
    async revalidate() { calls.push("revalidate"); await Promise.resolve(); if (revoked) throw new Error("revoked after prepare") },
    onDispatch() { dispatched++ },
  }, fileSystem)
  const rejected = assert.rejects(work)
  await prepared.promise
  assert.deepEqual(calls, ["# prepare-document"]); assert.equal(dispatched, 0)
  revoked = true; release.resolve(); await rejected
  assert.deepEqual(calls, ["# prepare-document", "revalidate", "# cleanup-document"])
  assert.equal(dispatched, 0); assert.equal(assertions, 1)
})
