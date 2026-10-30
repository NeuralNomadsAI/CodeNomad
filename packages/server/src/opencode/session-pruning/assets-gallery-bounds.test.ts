import assert from "node:assert/strict"
import fs from "node:fs"
import { syncBuiltinESMExports } from "node:module"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { listGalleryImages } from "./assets-gallery"
import { A2_CALL, A_CALL, A_NOTICE, A_READ, DIRECTORY, ROOT, galleryKey, has, image, openFixture, sha, signal, type Fixture } from "./assets-gallery-fixture"
import type { GalleryEntry } from "./assets-gallery-contract"
import { imagesResultSchema } from "./assets-gallery-contract"

function each(name: string, run: (fixture: Fixture) => Promise<void>) {
  for (const kind of ["plain", "blob"] as const) test(`${kind}: ${name}`, async () => {
    const fixture = openFixture(kind)
    try { await run(fixture) } finally { assert.equal(fixture.raw.isTransaction, false); fixture.close() }
  })
}
const images = (entries: GalleryEntry[]) => entries.filter((entry): entry is Extract<GalleryEntry, { kind: "image" }> => entry.kind === "image")

each("more than 64 entries in one message continue on the next page without loss or duplicates", async fixture => {
  const value = fixture.json(A_READ), base = value.content[fixture.readPart(value)], when = Date.now()
  const parts = Array.from({ length: 70 }, (_, n) => {
    const part = structuredClone(base); part.id = `call_zz_many_${n}`; part.time = { created: when, ran: when, completed: when + 1 }
    part.state.content[1].name = part.state.content[1].name.replace("icon-a.png", `many-${n}.png`); return part
  })
  fixture.insert("msg_zz_many", "assistant", 600, when, { ...value, content: parts })
  const first = await listGalleryImages(fixture.db, fixture.scope, undefined, false, signal())
  assert(first.status === "page" && first.cursor)
  assert.equal(first.entries.length, 64)
  const { all } = await fixture.walk()
  const labels = images(all).map(entry => entry.label).filter(label => label?.startsWith("many-"))
  assert.deepEqual(labels, Array.from({ length: 70 }, (_, n) => `many-${n}`))
  assert.equal(all.length, 11 + 70)
})

each("parents on another page and references written as absolute or relative give the same parent key", async fixture => {
  const row = fixture.row(A2_CALL), value = JSON.parse(row.data), call = value.content.find((part: any) => part.name === "image_generate")
  const parentKey = galleryKey(fixture.sessionID, fixture.call().state.metadata.jobID)
  call.state.input.images = [path.join(DIRECTORY, ".codenomad", "design", "icon", "icon-a.png"), ".codenomad/design/icon/icon-a.png", "https://example.test/x.png"]
  fixture.update(row.id, value)
  const a2 = images((await fixture.walk(false, 1)).all).find(entry => entry.label === "icon-a2")
  assert.deepEqual([a2?.parentKeys, a2?.otherRefs], [[parentKey, parentKey], 1])
})

each("a reused parent path and a parent outside the range count in otherRefs", async fixture => {
  const message = fixture.json(A_CALL), dup = structuredClone(fixture.call()), notice = fixture.row(A_NOTICE)
  dup.id = "call_zz_reuse"; dup.state.metadata.jobID = "image_zz_reuse"; dup.time = { created: notice.time_created + 1, ran: notice.time_created + 2, completed: notice.time_created + 3 }
  fixture.insert("msg_zz_reuse", "assistant", 20, notice.time_created + 1, { ...message, content: [dup] })
  assert(has(image(await fixture.lines(), "icon-a2")[0], "origin:proven", "parents:0 other:1"))
})

each("a parent generated more than 32 assistant messages before its child is not proven", async fixture => {
  fixture.raw.prepare("UPDATE session_message SET seq=seq+100 WHERE seq>=47").run()
  for (let n = 0; n < 40; n++) fixture.insert(`msg_zz_gap_${String(n).padStart(3, "0")}`, "assistant", 60 + n, Date.now(), { ...fixture.json(A_READ), content: [{ type: "text", text: `gap ${n}` }] })
  const lines = await fixture.lines()
  assert(has(image(lines, "icon-a2")[0], "origin:proven", "parents:0 other:1"))
})

each("private values never leave the whitelist; user prompts stay intact and appear only when granted for a marked root", async fixture => {
  const row = fixture.row(A_CALL), value = JSON.parse(row.data), call = value.content.find((part: any) => part.name === "image_generate")
  call.id = "call_SENTINEL_CALL"; call.state.metadata.notificationID = "SENTINEL_NOTIFY"; call.state.input.prompt = "Use D:\\art and image_ref literally"
  fixture.update(row.id, value)
  // After every read, so icon-a stays proven: an errored call may write any file.
  fixture.insert("msg_zz_error", "assistant", 400, Date.now(), { ...value, content: [{ type: "tool", id: "call_SENTINEL_ERR", name: "image_generate",
    time: { created: Date.now(), ran: Date.now() }, state: { status: "error", input: { prompt: "p" }, error: "SENTINEL_ERROR" } }] })
  const noticeRow = fixture.row(A_NOTICE), notice = JSON.parse(noticeRow.data); notice.text = notice.text.replace("Use the read tool", "SENTINEL_NOTICE"); fixture.update(noticeRow.id, notice)
  const notices = fixture.raw.prepare("SELECT data FROM session_message WHERE type='synthetic'").all().map(entry => JSON.parse(String(entry.data)).metadata)
  const temporary = notices.find(meta => meta?.path?.includes("opencode"))!.path as string
  const privateValues = ["SENTINEL", ROOT, DIRECTORY, fixture.sessionID, path.basename(temporary), ...notices.map(meta => meta?.jobID).filter(Boolean)]
  for (const prompts of [false, true]) {
    const serialized = JSON.stringify((await fixture.walk(prompts)).all)
    for (const secret of privateValues) assert(!serialized.includes(secret), `${secret} leaked (prompts: ${prompts})`)
    const a = images((await fixture.walk(prompts)).all).find(entry => entry.label === "icon-a")
    assert.equal(a?.prompt, prompts ? "Use D:\\art and image_ref literally" : undefined)
  }
})

each("prompts and models: granted, marked root, generation or proven image; 8 KiB truncation", async fixture => {
  const row = fixture.row(A_CALL), value = JSON.parse(row.data), call = value.content.find((part: any) => part.name === "image_generate")
  call.state.input.prompt = "é".repeat(5000); fixture.update(row.id, value)
  fixture.fillers(40); fixture.reread("msg_zz_late", 300)
  const { all } = await fixture.walk(true)
  const a = images(all).find(entry => entry.label === "icon-a" && entry.origin === "proven")!
  assert.equal(a.promptTruncated, true); assert.equal(Buffer.byteLength(a.prompt!), 8192); assert.equal(a.model, "fiximg/fixture-image")
  assert(images(all).filter(entry => entry.origin === "unverifiable").every(entry => entry.prompt === undefined && entry.model === undefined))
  assert(all.filter(entry => entry.kind === "generation").every(entry => typeof entry.model === "string"))
  for (const change of ["UPDATE session_v2 SET parent_id='ses_parent'", "UPDATE session_v2 SET metadata='{}'", "UPDATE session_v2 SET metadata='not json'"]) {
    fixture.raw.exec(change)
    assert(!JSON.stringify((await fixture.walk(true)).all).includes("\"prompt\""), change)
  }
})

for (const writer of [false, true]) {
  each(`an oversized row${writer ? " hiding a second writer" : ""} below the window stops the coverage: the cut range proves nothing; inside the window it blocks with limit; neither loads`, async fixture => {
    const content: any[] = [{ type: "text", text: "h".repeat(17 * 1024 * 1024) }]
    if (writer) {
      const dup = structuredClone(fixture.call()); dup.id = "call_zz_hidden"; dup.state.metadata.jobID = "image_zz_hidden"
      dup.time = { created: dup.time.ran - 10, ran: dup.time.ran - 9, completed: dup.time.ran - 8 }; content.unshift(dup)
    }
    fixture.insert("msg_zz_huge", "assistant", 3, 1, { content })
    fixture.loads.length = 0
    const seen: GalleryEntry[] = []
    let cursor: string | undefined, page
    do {
      page = await listGalleryImages(fixture.db, fixture.scope, cursor, false, signal(), 1)
      if (page.status === "page") { seen.push(...page.entries); cursor = page.cursor ?? undefined }
    } while (page.status === "page" && cursor)
    assert.deepEqual(page, { status: "blocked", reason: "limit" })
    assert.equal(images(seen).find(entry => entry.label === "icon-a")?.origin, "unverifiable")
    assert.deepEqual(await fixture.reference(fixture.readTarget()), { status: "refused", reason: "unverifiable" })
    assert(fixture.loads.length > 0 && fixture.loads.every(load => load.bytes < 16 * 1024 * 1024))
  })
}

// Only a completed `image_generate` with `metadata.path` names its file; any other call may write any file.
const generator = (id: string, ran: number, state: Record<string, unknown>, completed = true) => ({ type: "tool", name: "image_generate", id,
  time: { created: ran, ran, ...(completed ? { completed: ran + 1 } : {}) }, state })
const other = ".codenomad/design/icon/icon-zz.png"
const unknownWriters = [
  ["running, native shape (metadata {})", (ran: number) => generator("call_zz_w", ran, { status: "running", input: { prompt: "p", path: other }, metadata: {} }, false)],
  ["streaming, input unparsed", (ran: number) => generator("call_zz_w", ran, { status: "streaming", input: "{\"prompt\":\"p\",\"pa" }, false)],
  ["errored without metadata (interrupted after its job started)", (ran: number) => generator("call_zz_w", ran,
    { status: "error", input: { prompt: "p", path: other }, error: "Tool execution was interrupted" })],
  ["running, Windows alias of the file", (ran: number) => generator("call_zz_w", ran,
    { status: "running", input: { prompt: "p", path: "/c/cn-gallery-fixture/p/.codenomad/design/icon/icon-a.png" }, metadata: {} }, false)],
  ["completed without metadata.path", (ran: number) => generator("call_zz_w", ran, { status: "completed", input: { prompt: "p" }, metadata: { model: "m" } })],
] as const
for (const [name, make] of unknownWriters) {
  each(`a call that may write any file (${name}) in the range: icon-a unverifiable with pixels, references refused`, async fixture => {
    const message = fixture.json(A_CALL)
    fixture.insert("msg_zz_writer", "assistant", 8, 1, { ...message, content: [make(fixture.call().time.ran + 1)] })
    assert(has(image(await fixture.lines(), "icon-a")[0], "origin:unverifiable", "read:asset"))
    assert.deepEqual(await fixture.reference(fixture.readTarget()), { status: "refused", reason: "unverifiable" })
  })
  each(`a generation reference with a parallel call that may write any file (${name}) is refused`, async fixture => {
    const { row, value, own, target } = iconB(fixture)
    assert.equal((await fixture.reference(target)).status, "path")
    value.content.push(make(own.time.ran + 1)); fixture.update(String(row.id), value)
    assert.deepEqual(await fixture.reference(target), { status: "refused", reason: "unverifiable" })
  })
}
each("witness: a completed call naming another file leaves icon-a proven and both references accepted; a later unknown call refuses the reference only", async fixture => {
  const message = fixture.json(A_CALL), known = { status: "completed", input: { prompt: "p", path: other },
    metadata: { path: path.join(DIRECTORY, ".codenomad", "design", "icon", "icon-zz"), model: "m", jobID: "image_zz_known" } }
  fixture.insert("msg_zz_known", "assistant", 8, 1, { ...message, content: [generator("call_zz_known", fixture.call().time.ran + 1, known)] })
  const { row, value, own, target } = iconB(fixture)
  value.content.push(generator("call_zz_known_b", own.time.ran + 1, known)); fixture.update(String(row.id), value)
  assert(has(image(await fixture.lines(), "icon-a")[0], "origin:proven"))
  assert.equal((await fixture.reference(fixture.readTarget())).status, "path")
  assert.equal((await fixture.reference(target)).status, "path")
  fixture.insert("msg_zz_later", "assistant", 300, Date.now(), { ...message, content: [unknownWriters[0][1](Date.now())] })
  assert(has(image(await fixture.lines(), "icon-a")[0], "origin:proven"))
  assert.deepEqual(await fixture.reference(fixture.readTarget()), { status: "refused", reason: "unverifiable" })
})
function iconB(fixture: Fixture) {
  const rows = fixture.raw.prepare("SELECT id,data FROM session_message WHERE type='assistant'").all()
  const row = rows.find(entry => String(entry.data).includes("icon-b.png") && String(entry.data).includes("image_generate"))!
  const value = JSON.parse(String(row.data)), own = value.content.find((part: any) => part.name === "image_generate")
  return { row, value, own, target: { messageID: String(row.id), part: value.content.indexOf(own), digest: sha(`${own.id}\u0000${own.state.metadata.jobID}`) } }
}

each("the notice cap proves nothing and leaves outcomes unknown", async fixture => {
  const insert = fixture.raw.prepare("INSERT INTO session_message VALUES (?,?,?,?,?,?,?)")
  for (let n = 0; n < 4096; n++) insert.run(`msg_zz_note_${n}`, fixture.sessionID, "synthetic", 1000 + n, 1, 1, JSON.stringify({ metadata: { source: "other" }, text: "x" }))
  const lines = await fixture.lines()
  assert(lines.filter(line => line.startsWith("IMG ")).every(line => line.includes("origin:unverifiable")))
  assert(lines.filter(line => line.startsWith("GEN ")).every(line => line.includes("outcome:unknown")))
  assert.deepEqual(await fixture.reference(fixture.readTarget()), { status: "refused", reason: "unverifiable" })
})

each("cursors are bound to the session location and boundary; cancellation propagates; output fits its schema and 1 MiB", async fixture => {
  const first = await listGalleryImages(fixture.db, fixture.scope, undefined, true, signal(), 1)
  assert(first.status === "page" && first.cursor)
  assert(imagesResultSchema.safeParse(first).success)
  assert(Buffer.byteLength(JSON.stringify(first)) <= 1024 * 1024)
  fixture.raw.exec("UPDATE session_v2 SET project_id='other'")
  await assert.rejects(listGalleryImages(fixture.db, fixture.scope, first.cursor, false, signal()))
  assert.deepEqual(await listGalleryImages(fixture.db, { ...fixture.scope, projectID: "other" }, first.cursor, false, signal()), { status: "blocked", reason: "conflict" })
  const cancelled = new AbortController(); cancelled.abort()
  await assert.rejects(listGalleryImages(fixture.db, { ...fixture.scope, projectID: "other" }, undefined, false, cancelled.signal))
})

each("prompts larger than the response budget are paged under 1 MiB", async fixture => {
  const value = fixture.json(A_CALL), base = fixture.call(), when = Date.now()
  const parts = Array.from({ length: 64 }, (_, n) => ({ ...structuredClone(base), id: `call_zz_p_${n}`, state: { ...structuredClone(base.state), input: { prompt: "\u0001".repeat(8192) } } }))
  fixture.insert("msg_zz_prompts", "assistant", 700, when, { ...value, content: parts })
  const first = await listGalleryImages(fixture.db, fixture.scope, undefined, true, signal())
  assert(first.status === "page" && first.cursor && first.entries.length < 64)
  assert(Buffer.byteLength(JSON.stringify(first)) <= 1024 * 1024)
  assert.equal((await fixture.walk(true)).all.length, 11 + 64)
})

test("data URIs over 8 MiB read as unavailable, raw and through a media blob", async () => {
  const plain = openFixture("plain"), blob = openFixture("blob")
  try {
    const row = plain.row(A_READ), value = JSON.parse(row.data)
    plain.fileOf(value).uri = `data:image/png;base64,${"A".repeat(8 * 1024 * 1024)}`; plain.update(row.id, value)
    assert.deepEqual(await plain.read(plain.readTarget()), { status: "blocked", reason: "unavailable" })
    const hash = /^media:([0-9a-f]{64})$/.exec(blob.fileOf(blob.json(A_READ)).uri)![1]
    blob.raw.prepare("UPDATE blob SET data=? WHERE hash=?").run(Buffer.alloc(6.5 * 1024 * 1024), hash)
    assert.deepEqual(await blob.read(blob.readTarget()), { status: "blocked", reason: "unavailable" })
    blob.raw.prepare("UPDATE blob SET data=? WHERE hash=?").run(Buffer.alloc(5 * 1024 * 1024), hash)
    assert.equal((await blob.read(blob.readTarget())).status, "asset")
    blob.raw.prepare("DELETE FROM blob WHERE hash=?").run(hash)
    assert(!image(await blob.lines(), "icon-a").length)
    assert.deepEqual(await blob.reference(blob.readTarget()), { status: "refused", reason: "missing" })
  } finally { plain.close(); blob.close() }
})

each("references: generation targets, outside files, uncovered ranges and unknown fields", async fixture => {
  const generationTarget = async (label: string) => {
    const entry = (await fixture.walk()).all.find(item => item.kind === "generation" && item.key === galleryKey(fixture.sessionID, label))
    assert(entry?.kind === "generation"); return entry.target
  }
  const jobs = fixture.raw.prepare("SELECT data FROM session_message WHERE type='synthetic'").all().map(row => JSON.parse(String(row.data)).metadata)
  const job = (stem: string) => jobs.find(meta => meta.path.endsWith(stem))!.jobID
  assert.deepEqual(await fixture.reference(await generationTarget(job("icon-b"))), { status: "path", path: ".codenomad/design/icon/icon-b.png" })
  assert.deepEqual(await fixture.reference(await generationTarget(job("icon-err"))), { status: "refused", reason: "unverifiable" })
  assert.deepEqual(await fixture.reference(await generationTarget(job("outside"))), { status: "refused", reason: "outside" })
  const target = await generationTarget(job("icon-b"))
  assert.deepEqual(await fixture.reference({ ...target, digest: sha("other") }), { status: "refused", reason: "changed" })
  assert.deepEqual(await fixture.reference(fixture.readTarget()), { status: "path", path: ".codenomad/design/icon/icon-a.png" })
  fixture.fillers(40)
  assert.deepEqual(await fixture.reference(fixture.readTarget()), { status: "refused", reason: "unverifiable" })
  const { imageReferenceInputSchema } = await import("./assets-gallery-contract")
  assert(!imageReferenceInputSchema.safeParse({ sessionID: "s", target: { ...fixture.readTarget(), extra: 1 } }).success)
})

each("a generation reference with a parallel call to the same file still pending is refused", async fixture => {
  const rows = fixture.raw.prepare("SELECT id,seq,data FROM session_message WHERE type='assistant'").all()
  const row = rows.find(entry => String(entry.data).includes("icon-b.png") && String(entry.data).includes("image_generate"))!
  const value = JSON.parse(String(row.data)), own = value.content.find((part: any) => part.name === "image_generate")
  const job = own.state.metadata.jobID, notice = fixture.raw.prepare("SELECT time_created AS t FROM session_message WHERE data LIKE ?").get(`%${job}%`)!.t as number
  const target = { messageID: String(row.id), part: value.content.indexOf(own), digest: sha(`${own.id}\u0000${job}`) }
  assert.deepEqual(await fixture.reference(target), { status: "path", path: ".codenomad/design/icon/icon-b.png" })
  const parallel = (state: any, time: any) => {
    const copy = structuredClone(value), call = structuredClone(own)
    call.id = "call_zz_parallel"; call.state = { ...call.state, ...state, metadata: { ...call.state.metadata, jobID: "image_zz_parallel" } }; call.time = time
    copy.content.push(call); fixture.update(String(row.id), copy)
  }
  parallel({ status: "running" }, { created: own.time.ran + 1, ran: own.time.ran + 1 })
  assert.deepEqual(await fixture.reference(target), { status: "refused", reason: "unverifiable" }, "running, no completion time")
  parallel({ status: "completed" }, { created: own.time.ran + 1, ran: own.time.ran + 1, completed: own.time.ran + 2 })
  assert.deepEqual(await fixture.reference(target), { status: "refused", reason: "unverifiable" }, "completed, notice not delivered")
  fixture.noticeFor(Number(row.seq) + 1, "image_zz_parallel", notice - 1)
  assert.deepEqual(await fixture.reference(target), { status: "path", path: ".codenomad/design/icon/icon-b.png" }, "its notice came before ours")
})

each("no file under the location or OpenCode's temporary folder is opened while listing, reading or referencing", async fixture => {
  const touched: string[] = [], names = ["openSync", "readFileSync", "statSync", "lstatSync", "existsSync", "accessSync", "realpathSync", "readdirSync", "open", "readFile", "stat", "lstat", "access", "realpath", "readdir"] as const
  const saved = new Map<string, any>(), savedPromises = new Map<string, any>()
  const watched = (value: unknown) => typeof value === "string" || value instanceof URL ? [String(value)] : []
  for (const name of names) {
    saved.set(name, (fs as any)[name]); (fs as any)[name] = (...args: any[]) => { touched.push(...watched(args[0])); return saved.get(name)(...args) }
    if (name in fs.promises) { savedPromises.set(name, (fs.promises as any)[name]); (fs.promises as any)[name] = (...args: any[]) => { touched.push(...watched(args[0])); return savedPromises.get(name)(...args) } }
  }
  syncBuiltinESMExports()
  try {
    const { all } = await fixture.walk(true)
    for (const entry of all) entry.kind === "image" ? await fixture.read(entry.target) : undefined
    await fixture.reference(fixture.readTarget())
  } finally {
    for (const [name, value] of saved) (fs as any)[name] = value
    for (const [name, value] of savedPromises) (fs.promises as any)[name] = value
    syncBuiltinESMExports()
  }
  const temporary = path.join(os.tmpdir(), "opencode")
  assert.deepEqual(touched.filter(file => file.startsWith(ROOT) || file.startsWith(temporary)), [])
})
