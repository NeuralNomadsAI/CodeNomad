import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { PANEL_EXTENSION_API4_PERMISSIONS } from "./contract"
import { fixtureArchive, fixtureManifest } from "./archive-fixture"
import { createPanelExtensionCatalog, PANEL_EXTENSION_CATALOG_URL } from "./catalog"
import { readPanelExtensionArchive } from "./archive"
import { PanelExtensionStore } from "./store"
import { extensionsRequestDesign } from "../opencode/design/demand"

const api4 = (permissions: unknown, extra = {}) => readPanelExtensionArchive(fixtureArchive("<p>x</p>", { apiVersion: 4, permissions, ...extra }))
const design = ["session.context", ...PANEL_EXTENSION_API4_PERMISSIONS]
/** The notes file of `id`'s current installation in `project` (notes live under the record's key). */
const notesFile = async (directory: string, id: string, project: string) => path.join(directory, "notes",
  JSON.parse(await readFile(path.join(directory, "installed.json"), "utf8")).records.find((record: any) => record.manifest.id === id).notes, `${project}.json`)

test("API 4 manifests: session.context plus a non-empty subset of the finite set, in any order", async () => {
  assert.deepEqual((await api4(design)).manifest.permissions, design)
  for (const permission of PANEL_EXTENSION_API4_PERMISSIONS.filter(value => value !== "session.images.prompts" && !value.startsWith("repository.worktrees."))) {
    assert.deepEqual((await api4(["session.context", permission])).manifest.permissions, ["session.context", permission])
  }
  assert.deepEqual((await api4(["composer.prefill", "session.images.prompts", "session.images.read", "session.context"])).manifest.apiVersion, 4)
  assert.equal((await api4(["repository.worktrees.write", "repository.worktrees.read", "repository.workItems.read", "session.context"])).manifest.apiVersion, 4)
  for (const permissions of [
    ["session.context"], // empty subset
    ["session.images.read"], // no session.context
    ["session.context", "session.images.read", "session.images.read"], // duplicate
    ["session.context", "session.context", "session.images.read"],
    ["session.context", "session.images.prompts"], // prompts without the gallery
    ["session.context", "session.images.prompts", "composer.prefill"],
    ["session.context", "filesystem.read"], // unknown
    ["session.context", "session.assets.read"], // another API's permission
    ["session.context", "repository.worktrees.read"], // worktrees without the items they belong to
    ["session.context", "repository.workItems.read", "repository.worktrees.write"], // write without read
    [...design, "panel.preferences"],
    "session.context",
  ]) await assert.rejects(api4(permissions), { code: "invalid" }, JSON.stringify(permissions))
  // APIs 1 to 3 keep their exact tuples: an API 4 permission never widens them.
  for (const [apiVersion, permissions] of [[1, ["session.context", "panel.preferences"]], [2, ["session.context", "session.images.read"]],
    [3, ["session.context", "composer.prefill"]]] as const) {
    await assert.rejects(readPanelExtensionArchive(fixtureArchive("<p>x</p>", { apiVersion, permissions })), { code: "invalid" })
  }
})

test("the catalogue marks API 4 entries compatible only with known permissions; incompatible ones never download or install", async () => {
  const valid = { ...fixtureManifest, id: "example.design", apiVersion: 4, permissions: design }
  const entries = [valid, { ...valid, id: "example.future", permissions: ["session.context", "session.images.write"] },
    { ...valid, id: "example.next", apiVersion: 5 }].map(manifest => ({ manifest, description: "Panel", digest: "a".repeat(64),
    release: { tag: "v1.0.0", asset: "panel-1.0.0.zip" } }))
  let downloads = 0
  const catalog = createPanelExtensionCatalog((async (url: string | URL | Request) => {
    if (String(url) === PANEL_EXTENSION_CATALOG_URL) return new Response(JSON.stringify({ schemaVersion: 1, extensions: entries }))
    downloads++
    return new Response("never")
  }) as typeof fetch)
  assert.deepEqual((await catalog.list()).entries.map(entry => entry.compatible), [true, false, false])
  for (const id of ["example.future", "example.next"]) await assert.rejects(catalog.inspect(id, "a".repeat(64)), { code: "invalid" })
  assert.equal(downloads, 0)
  // Manual installation reads only the manifest before refusing.
  await assert.rejects(api4(["session.context", "session.images.write"]), { code: "invalid" })
  await assert.rejects(readPanelExtensionArchive(fixtureArchive("<script>throw 1</script>", { apiVersion: 5, permissions: design })), { code: "invalid" })
})

test("an installed, enabled API 4 extension declaring opencode.designAgent requests Design; disabled or another one does not", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codenomad-api4-design-"))
  try {
    const store = new PanelExtensionStore(directory)
    const pkg = await api4(["session.context", "opencode.designAgent"])
    await store.install(pkg)
    assert.equal(extensionsRequestDesign(await store.list()), false)
    await store.activate(pkg.manifest.id, pkg.digest, true)
    assert.equal(extensionsRequestDesign(await store.list()), true)
    const other = await api4(["session.context", "panel.preferences"])
    await store.install(other, pkg.digest)
    await store.activate(other.manifest.id, other.digest, true)
    assert.equal(extensionsRequestDesign(await store.list()), false)
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 }) }
})

test("preferences: {} by default, 4 KiB whole objects, per extension, kept on disable, reset on replace and remove, durable", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codenomad-api4-preferences-"))
  try {
    let changes = 0
    const store = new PanelExtensionStore(directory, () => changes++)
    const first = await api4(["session.context", "panel.preferences"])
    const second = await api4(["session.context", "panel.preferences"], { id: "example.other" })
    for (const pkg of [first, second]) { await store.install(pkg); await store.activate(pkg.manifest.id, pkg.digest, true) }
    const id = first.manifest.id
    assert.deepEqual(await store.preferences(id, first.digest), {})
    const notified = changes
    assert.equal(await store.setPreferences(id, first.digest, { imagesPerTurn: 2 }), "saved")
    assert.equal(changes, notified, "a preference write is not a catalogue change")
    assert.deepEqual(await store.preferences(id, first.digest), { imagesPerTurn: 2 })
    assert.deepEqual(await store.preferences(second.manifest.id, second.digest), {}, "extensions are isolated")
    // Whole-object replacement within 4,096 serialized UTF-8 bytes (`{"v":"…"}` is 8 bytes of framing).
    assert.equal(await store.setPreferences(id, first.digest, { v: "é".repeat((4096 - 8) / 2) }), "saved")
    assert.equal(await store.setPreferences(id, first.digest, { v: "x".repeat(4096 - 8 + 1) }), "too-large")
    assert.equal(await store.setPreferences(id, first.digest, { theme: "dark" }), "saved")
    assert.deepEqual(await store.preferences(id, first.digest), { theme: "dark" })
    for (const value of [[], null, "text", 3, true]) assert.equal(await store.setPreferences(id, first.digest, value), "invalid")
    assert.deepEqual(await new PanelExtensionStore(directory).preferences(id, first.digest), { theme: "dark" }, "kept across restarts")

    await store.activate(id, first.digest, false)
    await assert.rejects(store.preferences(id, first.digest), { code: "unavailable" }, "a disabled package has no authority")
    await assert.rejects(store.setPreferences(id, first.digest, {}), { code: "unavailable" })
    await store.activate(id, first.digest, true)
    assert.deepEqual(await store.preferences(id, first.digest), { theme: "dark" }, "disabling keeps them")

    await assert.rejects(store.preferences(id, "f".repeat(64)), { code: "unavailable" }, "a digest that is not installed")
    await assert.rejects(store.preferences("example.absent", first.digest), { code: "unavailable" })
    const noGrant = await readPanelExtensionArchive(fixtureArchive("<p>y</p>", { id: "example.plain" }))
    await store.install(noGrant); await store.activate(noGrant.manifest.id, noGrant.digest, true)
    await assert.rejects(store.preferences(noGrant.manifest.id, noGrant.digest), { code: "unavailable" }, "the permission is required")

    const replacement = await api4(["session.context", "panel.preferences"], { version: "1.1.0" })
    await store.install(replacement, first.digest)
    await assert.rejects(store.preferences(id, first.digest), { code: "unavailable" })
    await store.activate(id, replacement.digest, true)
    assert.deepEqual(await store.preferences(id, replacement.digest), {}, "replacement resets")
    await store.setPreferences(id, replacement.digest, { theme: "light" })
    await store.remove(id, replacement.digest)
    await store.install(replacement); await store.activate(id, replacement.digest, true)
    assert.deepEqual(await store.preferences(id, replacement.digest), {}, "removal resets")
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 }) }
})

test("preferences: an invalid entry alone reads {}; a corrupt store is unavailable and stays byte-identical", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codenomad-api4-corrupt-"))
  try {
    const store = new PanelExtensionStore(directory)
    const pkg = await api4(["session.context", "panel.preferences"])
    await store.install(pkg); await store.activate(pkg.manifest.id, pkg.digest, true)
    const file = path.join(directory, "installed.json")
    const stored = JSON.parse(await readFile(file, "utf8"))
    for (const invalid of [[1, 2], "text", { big: "x".repeat(5000) }]) {
      stored.records[0].preferences = invalid
      await writeFile(file, JSON.stringify(stored))
      assert.deepEqual(await store.preferences(pkg.manifest.id, pkg.digest), {})
    }
    for (const corrupt of ["corrupt", JSON.stringify({ version: 2, records: [] })]) {
      await writeFile(file, corrupt)
      await assert.rejects(store.preferences(pkg.manifest.id, pkg.digest), { code: "unavailable" })
      await assert.rejects(store.setPreferences(pkg.manifest.id, pkg.digest, { a: 1 }), { code: "unavailable" })
      assert.equal(await readFile(file, "utf8"), corrupt)
    }
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 }) }
})

test("notes: one per session and project, revision-checked, empty deletes, capped, kept on disable and replace, removed with the package", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codenomad-api4-notes-"))
  try {
    const changed: string[] = []
    const store = new PanelExtensionStore(directory, () => {}, id => changed.push(id))
    const pkg = await api4(["session.context", "panel.notes"])
    await store.install(pkg); await store.activate(pkg.manifest.id, pkg.digest, true)
    const id = pkg.manifest.id, project = "a".repeat(64), other = "b".repeat(64)
    assert.deepEqual(await store.notes(id, pkg.digest, project), [])
    const saved = await store.setNote(id, pkg.digest, project, "ses_1", 0, { title: "One", text: "first" })
    assert.equal(saved.status, "saved")
    const revision = (saved as { revision: number }).revision
    assert.deepEqual(changed, [id])
    assert.deepEqual(await store.setNote(id, pkg.digest, project, "ses_1", 0, { title: "One", text: "stale" }),
      { status: "conflict", note: { text: "first", revision } }, "a stale writer never overwrites")
    assert.deepEqual(await store.notes(id, pkg.digest, other), [], "projects are isolated")
    assert.deepEqual(await store.setNote(id, pkg.digest, project, "ses_2", 0, { title: "Two", text: "x".repeat(32 * 1024 + 1) }), { status: "too-large" })
    assert.equal((await store.setNote(id, pkg.digest, project, "ses_2", 0, { title: "Two", text: "é".repeat(16 * 1024) })).status, "saved")
    assert.deepEqual((await new PanelExtensionStore(directory).notes(id, pkg.digest, project)).map(note => note.sessionID), ["ses_2", "ses_1"],
      "newest first, kept across restarts")
    assert.deepEqual(await store.setNote(id, pkg.digest, project, "ses_1", revision, { title: "", text: "" }), { status: "saved", revision: 0 })
    assert.deepEqual((await store.notes(id, pkg.digest, project)).map(note => note.sessionID), ["ses_2"], "empty text deletes")
    for (let index = 1; index < 256; index++) await store.setNote(id, pkg.digest, other, `ses_${index}`, 0, { title: "", text: "n" })
    assert.equal((await store.setNote(id, pkg.digest, other, "ses_last", 0, { title: "", text: "n" })).status, "saved")
    assert.deepEqual(await store.setNote(id, pkg.digest, other, "ses_full", 0, { title: "", text: "n" }), { status: "full" })
    await assert.rejects(store.notes(id, pkg.digest, "../x"), { code: "invalid" })

    await store.activate(id, pkg.digest, false)
    await assert.rejects(store.notes(id, pkg.digest, project), { code: "unavailable" }, "a disabled package has no authority")
    await assert.rejects(store.setNote(id, pkg.digest, project, "ses_3", 0, { title: "", text: "n" }), { code: "unavailable" })
    const replacement = await api4(["session.context", "panel.notes"], { version: "1.1.0" })
    await store.install(replacement, pkg.digest); await store.activate(id, replacement.digest, true)
    assert.equal((await store.notes(id, replacement.digest, project)).length, 1, "disabling and replacing keep notes")
    const file = await notesFile(directory, id, project)
    const bytes = await readFile(file, "utf8")
    await writeFile(file, "corrupt")
    await assert.rejects(store.setNote(id, replacement.digest, project, "ses_3", 0, { title: "", text: "n" }), { code: "unavailable" })
    assert.equal(await readFile(file, "utf8"), "corrupt", "a corrupt notes file is never replaced")
    await writeFile(file, bytes)
    await store.remove(id, replacement.digest)
    await store.install(replacement); await store.activate(id, replacement.digest, true)
    assert.deepEqual(await store.notes(id, replacement.digest, project), [], "removal deletes them")
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 }) }
})
test("notes: a recreated note gets a newer revision even at the same instant; a failed cleanup leaves removal retryable", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codenomad-api4-notes-retry-"))
  try {
    const store = new PanelExtensionStore(directory)
    const pkg = await api4(["session.context", "panel.notes"])
    await store.install(pkg); await store.activate(pkg.manifest.id, pkg.digest, true)
    const id = pkg.manifest.id, project = "a".repeat(64)
    const clock = t.mock.method(Date, "now", () => 1_800_000_000_000)
    const first = await store.setNote(id, pkg.digest, project, "ses_1", 0, { title: "", text: "first" }) as { revision: number }
    await store.setNote(id, pkg.digest, project, "ses_1", first.revision, { title: "", text: "" })
    const again = await new PanelExtensionStore(directory).setNote(id, pkg.digest, project, "ses_1", 0, { title: "", text: "second" }) as { revision: number }
    assert.ok(again.revision > first.revision, "a stale writer's revision is never issued again")
    clock.mock.restore()

    // The catalogue cannot be written: the package and its notes both stay, and removal can retry.
    const rename = fs.rename
    const busy = t.mock.method(fs, "rename", async (from: string, to: string) => {
      if (to === path.join(directory, "installed.json")) throw Object.assign(new Error("busy"), { code: "EBUSY" })
      return rename(from, to)
    })
    await assert.rejects(store.remove(id, pkg.digest), { code: "EBUSY" })
    busy.mock.restore()
    assert.equal((await store.list())[0]?.digest, pkg.digest)
    assert.equal((await store.notes(id, pkg.digest, project)).length, 1, "notes kept when the catalogue cannot be written")
    // The notes files cannot be deleted: removal still commits, and a reinstall starts empty.
    const notes = path.dirname(await notesFile(directory, id, project)), remove = fs.rm
    const stuck = t.mock.method(fs, "rm", async (target: any, options: any) => {
      if (target === notes) throw Object.assign(new Error("busy"), { code: "EBUSY" })
      return remove(target, options)
    })
    await store.remove(id, pkg.digest)
    stuck.mock.restore()
    await store.install(pkg); await store.activate(id, pkg.digest, true)
    assert.deepEqual(await store.notes(id, pkg.digest, project), [])
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 }) }
})
test("notes: same-instant writes list newest first, inconsistent files fail closed, titles keep whole characters, backends share one lock", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codenomad-api4-notes-file-"))
  try {
    const store = new PanelExtensionStore(directory)
    const pkg = await api4(["session.context", "panel.notes"])
    await store.install(pkg); await store.activate(pkg.manifest.id, pkg.digest, true)
    const id = pkg.manifest.id, project = "a".repeat(64)
    const clock = t.mock.method(Date, "now", () => 1_800_000_000_000)
    await store.setNote(id, pkg.digest, project, "ses_a", 0, { title: "x".repeat(255) + "😀", text: "first" })
    await store.setNote(id, pkg.digest, project, "ses_z", 0, { title: "", text: "second" })
    clock.mock.restore()
    const listed = await store.notes(id, pkg.digest, project), file = await notesFile(directory, id, project)
    assert.deepEqual(listed.map(note => note.text), ["second", "first"])
    assert.equal(listed[1]!.title, "x".repeat(255), "never half a surrogate pair")

    const good = await readFile(file, "utf8"), stored = JSON.parse(good)
    for (const corrupt of [{ ...stored, notes: [...stored.notes, { ...stored.notes[0], text: "twice" }] }, { ...stored, revision: 1 }]) {
      await writeFile(file, JSON.stringify(corrupt))
      await assert.rejects(store.setNote(id, pkg.digest, project, "ses_new", 0, { title: "", text: "n" }), { code: "unavailable" })
      assert.equal(await readFile(file, "utf8"), JSON.stringify(corrupt), "never rewritten")
    }
    await writeFile(file, good)

    // Two backends on one profile: one write wins, the other sees the conflict.
    const other = new PanelExtensionStore(directory)
    const results = await Promise.all([store, other].map((writer, index) =>
      writer.setNote(id, pkg.digest, project, "ses_race", 0, { title: "", text: `writer ${index}` })))
    assert.deepEqual(results.map(result => result.status).sort(), ["conflict", "saved"])
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 }) }
})
test("notes: a removal from another backend waits for a write in flight, then deletes it too", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codenomad-api4-notes-remove-"))
  try {
    const a = new PanelExtensionStore(directory), b = new PanelExtensionStore(directory)
    const pkg = await api4(["session.context", "panel.notes"])
    await a.install(pkg); await a.activate(pkg.manifest.id, pkg.digest, true)
    const id = pkg.manifest.id, project = "a".repeat(64)
    await a.setNote(id, pkg.digest, project, "ses_old", 0, { title: "", text: "old" })
    let entered!: () => void, resume!: () => void
    const checking = new Promise<void>(resolve => { entered = resolve }), held = new Promise<void>(resolve => { resume = resolve })
    const saving = a.setNote(id, pkg.digest, project, "ses_new", 0, { title: "", text: "in flight" },
      { check: async () => { entered(); await held }, final: () => {} })
    await checking
    const removing = b.remove(id, pkg.digest)
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal((await new PanelExtensionStore(directory).list()).length, 1, "the removal waits for the write's lock")
    resume()
    assert.equal((await saving).status, "saved")
    await removing
    await b.install(pkg); await b.activate(id, pkg.digest, true)
    assert.deepEqual(await b.notes(id, pkg.digest, project), [], "nothing comes back on reinstall")
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 }) }
})
test("notes: disabling from another backend waits for a write in flight; the next write is refused", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codenomad-api4-notes-disable-"))
  try {
    const a = new PanelExtensionStore(directory), b = new PanelExtensionStore(directory)
    const pkg = await api4(["session.context", "panel.notes"])
    await a.install(pkg); await a.activate(pkg.manifest.id, pkg.digest, true)
    const id = pkg.manifest.id, project = "a".repeat(64)
    let entered!: () => void, resume!: () => void
    const checking = new Promise<void>(resolve => { entered = resolve }), held = new Promise<void>(resolve => { resume = resolve })
    const saving = a.setNote(id, pkg.digest, project, "ses_1", 0, { title: "", text: "in flight" },
      { check: async () => { entered(); await held }, final: () => {} })
    await checking
    const disabling = b.activate(id, pkg.digest, false)
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal((await new PanelExtensionStore(directory).list())[0]!.enabled, true, "the grant change waits for the write's lock")
    resume()
    assert.equal((await saving).status, "saved")
    await disabling
    await assert.rejects(a.setNote(id, pkg.digest, project, "ses_2", 0, { title: "", text: "late" }), { code: "unavailable" })
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 }) }
})
test("notes: one profile lock — concurrent removals from two backends both hold; a read waits for a removal that then fails", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codenomad-api4-notes-profile-"))
  try {
    const a = new PanelExtensionStore(directory), b = new PanelExtensionStore(directory)
    const first = await api4(["session.context", "panel.notes"]), second = await api4(["session.context", "panel.notes"], { id: "example.second" })
    for (const pkg of [first, second]) { await a.install(pkg); await a.activate(pkg.manifest.id, pkg.digest, true) }
    const project = "a".repeat(64)
    await a.setNote(first.manifest.id, first.digest, project, "ses_1", 0, { title: "", text: "keep" })

    // The catalogue write of a removal stalls, then fails: a read from the other backend waits and sees the notes.
    const rename = fs.rename
    let stalled!: () => void, fail!: () => void
    const reached = new Promise<void>(resolve => { stalled = resolve }), failing = new Promise<void>(resolve => { fail = resolve })
    const busy = t.mock.method(fs, "rename", async (from: string, to: string) => {
      if (to === path.join(directory, "installed.json")) { stalled(); await failing; throw Object.assign(new Error("busy"), { code: "EBUSY" }) }
      return rename(from, to)
    })
    const removing = b.remove(first.manifest.id, first.digest).catch(error => error)
    await reached
    const reading = a.notes(first.manifest.id, first.digest, project)
    fail()
    assert.equal((await removing).code, "EBUSY")
    busy.mock.restore()
    assert.deepEqual((await reading).map(note => note.text), ["keep"])

    await Promise.all([a.remove(first.manifest.id, first.digest), b.remove(second.manifest.id, second.digest)])
    assert.deepEqual(await new PanelExtensionStore(directory).list(), [], "neither removal is lost")
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 }) }
})
