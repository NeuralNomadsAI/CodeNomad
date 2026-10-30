import assert from "node:assert/strict"
import { test } from "node:test"
import { A2_CALL, A_CALL, A_NOTICE, A_READ, galleryKey, has, image, openFixture, pngUri, sha, type Fixture } from "./assets-gallery-fixture"

// Product port of the gallery prototype's mutations: one throwaway copy of each OpenCode 2.2.1
// transcript (plain storage and `experimental.media_blob`) per case, no daemon, no file access.
const BASELINE = ["GEN tool:completed outcome:unknown", "GEN tool:completed outcome:completed", "GEN tool:completed outcome:completed",
  "GEN tool:completed outcome:completed", "GEN tool:completed outcome:completed", "GEN tool:completed outcome:error",
  "IMG icon-a2 origin:proven parents:1 other:0 read:asset", "GEN tool:completed outcome:completed", "GEN tool:completed outcome:completed",
  "IMG icon-a origin:proven parents:0 other:0 read:asset", "GEN tool:completed outcome:completed"]

function each(name: string, run: (fixture: Fixture) => Promise<void>) {
  for (const kind of ["plain", "blob"] as const) test(`${kind}: ${name}`, async () => {
    const fixture = openFixture(kind)
    try { await run(fixture) } finally { assert.equal(fixture.raw.isTransaction, false); fixture.close() }
  })
}
const generation = async (fixture: Fixture, job: string) => (await fixture.walk()).all.find(entry => entry.kind === "generation" && entry.key === galleryKey(fixture.sessionID, job))
const stretchRead = (fixture: Fixture, ms: number) => {
  const row = fixture.row(A_READ), value = JSON.parse(row.data), part = value.content[fixture.readPart(value)]
  part.time.completed = part.time.ran + ms; fixture.update(row.id, value); return part.time as { ran: number; completed: number }
}

each("baseline: identical for 32-message and 1-message pages; icon-a and icon-a2 proven, icon-a2 with icon-a as parent", async fixture => {
  assert.deepEqual(await fixture.lines(), BASELINE)
  assert.deepEqual(await fixture.lines(false, 1), BASELINE)
  const { all, pages } = await fixture.walk(false, 1)
  assert(pages > 10)
  const a = all.find(entry => entry.kind === "image" && entry.label === "icon-a"), a2 = all.find(entry => entry.kind === "image" && entry.label === "icon-a2")
  assert(a?.kind === "image" && a2?.kind === "image")
  assert.deepEqual(a2.parentKeys, [a.generationKey])
  assert.equal(a.generationKey, galleryKey(fixture.sessionID, fixture.call().state.metadata.jobID))
})

each("hidden duplicate notice over 64 KiB: icon-a unverifiable with pixels, its generation completed/unknown", async fixture => {
  const job = fixture.json(A_NOTICE).metadata.jobID
  fixture.noticeFor(10, job, fixture.row(A_NOTICE).time_created, 70 * 1024)
  assert(has(image(await fixture.lines(), "icon-a")[0], "origin:unverifiable", "read:asset"))
  const entry = await generation(fixture, job)
  assert.deepEqual(entry?.kind === "generation" && [entry.tool, entry.outcome], ["completed", "unknown"])
})

each("an undecodable row created before the call leaves its notice established", async fixture => {
  const job = fixture.json(A_NOTICE).metadata.jobID
  fixture.noticeFor(6, "image_zz_unrelated", fixture.call().time.ran - 1000, 70 * 1024)
  const entry = await generation(fixture, job)
  assert.deepEqual(entry?.kind === "generation" && [entry.tool, entry.outcome], ["completed", "completed"])
})

each("a second decodable call to the same path makes icon-a unverifiable", async fixture => {
  const message = fixture.json(A_CALL), call = fixture.call(), dup = structuredClone(call)
  dup.id = "call_zz_dup"; dup.state.metadata.jobID = "image_zz_dup"; dup.time = { created: call.time.ran + 1, ran: call.time.ran + 2, completed: call.time.ran + 3 }
  fixture.insert("msg_zz_dup_call", "assistant", 8, call.time.ran + 1, { ...message, content: [dup] })
  assert(has(image(await fixture.lines(), "icon-a")[0], "origin:unverifiable", "read:asset"))
})

each("a second call inside a message over 16 MiB: the window refuses with limit and the single-item proof stays unverifiable, never loading it", async fixture => {
  const message = fixture.json(A_CALL), call = fixture.call(), dup = structuredClone(call)
  dup.id = "call_zz_big"; dup.state.metadata.jobID = "image_zz_big"; dup.time = { created: call.time.ran + 1, ran: call.time.ran + 2, completed: call.time.ran + 3 }
  fixture.insert("msg_zz_big_call", "assistant", 8, call.time.ran + 1, { ...message, content: [dup, { type: "text", text: "y".repeat(17 * 1024 * 1024) }] })
  const { listGalleryImages } = await import("./assets-gallery")
  assert.deepEqual(await listGalleryImages(fixture.db, fixture.scope, undefined, false, new AbortController().signal), { status: "blocked", reason: "limit" })
  assert.deepEqual(await fixture.reference(fixture.readTarget()), { status: "refused", reason: "unverifiable" })
  assert(fixture.loads.every(load => load.bytes < 16 * 1024 * 1024))
})

each("first read pruned while a later read exists: the old target is refused, never substituted", async fixture => {
  const row = fixture.row(A_READ), value = JSON.parse(row.data), target = fixture.readTarget()
  fixture.reread("msg_zz_late", 300)
  value.content[fixture.readPart(value)].state.content.splice(1, 1, { type: "text", text: "[pruned]" }); fixture.update(row.id, value)
  assert.equal((await fixture.read(target)).status, "blocked")
  assert.deepEqual(await fixture.reference(target), { status: "refused", reason: "changed" })
  assert.equal(image(await fixture.lines(), "icon-a").length, 1)
})

each("content rewritten under the same ids is refused by the digest", async fixture => {
  const row = fixture.row(A_READ), value = JSON.parse(row.data), target = fixture.readTarget()
  const file = fixture.fileOf(value); file.uri = file.uri.slice(0, -8) + "AAAAAAAA"; fixture.update(row.id, value)
  assert.deepEqual(await fixture.read(target), { status: "blocked", reason: "unavailable" })
})

for (const [fillers, origin] of [[40, "origin:unverifiable"], [10, "origin:proven"]] as const) {
  each(`late re-read after ${fillers} messages keeps its pixels, ${origin}`, async fixture => {
    fixture.fillers(fillers); fixture.reread("msg_zz_reread_b", 300, "icon-b.png")
    assert(has(image(await fixture.lines(), "icon-b")[0], "read:asset", origin))
  })
}

each("another write between the notice and the read makes icon-a unverifiable", async fixture => {
  fixture.noticeFor(12, "image_zz_other", fixture.row(A_NOTICE).time_created + 10)
  assert(has(image(await fixture.lines(), "icon-a")[0], "origin:unverifiable"))
})

each("a source message grown past 16 MiB is refused with limit before it loads", async fixture => {
  const target = fixture.readTarget(), value = fixture.json(A_READ)
  value.content.push({ type: "text", text: "z".repeat(17 * 1024 * 1024) }); fixture.update(target.messageID, value)
  fixture.loads.length = 0
  assert.deepEqual(await fixture.read(target), { status: "blocked", reason: "limit" })
  assert.equal(fixture.loads.length, 0)
})

each("revert staged, cleared and committed", async fixture => {
  const old = fixture.readTarget(57), boundary = fixture.row(47).id
  const { listGalleryImages } = await import("./assets-gallery")
  const first = await listGalleryImages(fixture.db, fixture.scope, undefined, false, new AbortController().signal, 1)
  assert(first.status === "page" && first.cursor)
  fixture.raw.prepare("UPDATE session_v2 SET revert=?").run(JSON.stringify({ messageID: boundary }))
  let lines = await fixture.lines()
  assert.equal(image(lines, "icon-a2").length, 0); assert.equal(image(lines, "icon-a").length, 1)
  assert.deepEqual(await fixture.read(old), { status: "blocked", reason: "missing" })
  assert.deepEqual(await fixture.reference(old), { status: "refused", reason: "missing" })
  assert.deepEqual(await listGalleryImages(fixture.db, fixture.scope, first.cursor, false, new AbortController().signal), { status: "blocked", reason: "conflict" })
  fixture.raw.prepare("UPDATE session_v2 SET revert=NULL").run()
  assert.deepEqual(await fixture.lines(), BASELINE)
  assert.equal((await fixture.read(old)).status, "asset")
  fixture.raw.prepare("DELETE FROM session_message WHERE seq>=47").run()
  lines = await fixture.lines()
  assert.equal(image(lines, "icon-a2").length, 0); assert.equal(image(lines, "icon-a").length, 1)
  assert.deepEqual(await fixture.read(old), { status: "blocked", reason: "missing" })
})

each("native generation states", async fixture => {
  const message = fixture.json(A_CALL), call = fixture.call()
  const states = [{ status: "streaming", input: "" }, { status: "running", input: call.state.input, metadata: {} },
    { status: "error", input: call.state.input, error: "denied" }, { status: "mystery" }]
  fixture.insert("msg_zz_states", "assistant", 400, Date.now(), { ...message, content: states.map((state, n) => ({ ...structuredClone(call), id: `call_zz_${n}`, state })) })
  assert.deepEqual((await fixture.lines()).slice(0, 4), ["GEN tool:streaming outcome:none", "GEN tool:running outcome:none", "GEN tool:error outcome:none", "GEN tool:unknown outcome:none"])
})

each("cancelled notice, completed call without jobID", async fixture => {
  const message = fixture.json(A_CALL), call = structuredClone(fixture.call()), when = Date.now()
  call.id = "call_zz_cancel"; call.state.metadata.jobID = "image_zz_cancel"; call.time = { created: when, ran: when, completed: when + 1 }
  const bare = structuredClone(call); bare.id = "call_zz_bare"; delete bare.state.metadata.jobID
  fixture.insert("msg_zz_cancel", "assistant", 400, when, { ...message, content: [call, bare] })
  const notice = fixture.json(A_NOTICE); notice.metadata = { ...notice.metadata, jobID: "image_zz_cancel", state: "cancelled" }
  fixture.insert("msg_zz_cancel_notice", "synthetic", 401, when + 5, notice)
  assert.deepEqual((await fixture.lines()).slice(0, 2), ["GEN tool:completed outcome:cancelled", "GEN tool:unknown outcome:none"])
})

each("gallery membership: other tools and non-image files are not listed and refused; unverifiable and oversized reads are served", async fixture => {
  const value = fixture.json(A_READ), base = value.content[fixture.readPart(value)], when = Date.now()
  const other = structuredClone(base); other.id = "call_zz_mcp"; other.name = "mcp_fixture"; other.time = { created: when, ran: when, completed: when + 1 }
  const text = structuredClone(base); text.id = "call_zz_text"; text.time = { created: when, ran: when, completed: when + 1 }
  text.state.content[1] = { type: "file", mime: "text/plain", name: "notes.txt", uri: `data:text/plain;base64,${Buffer.from("hello").toString("base64")}` }
  const big = structuredClone(base); big.id = "call_zz_huge"; big.time = { created: when, ran: when, completed: when + 1 }
  big.state.content[1] = { ...big.state.content[1], name: big.state.content[1].name.replace("icon-a.png", "huge.png"), uri: pngUri(4096, 4096) }
  fixture.insert("msg_zz_members", "assistant", 310, when, { ...value, content: [other, text, big] })
  const id = fixture.row(310).id
  const listed = (await fixture.lines()).filter(line => line.startsWith("IMG ")).map(line => line.split(" ")[1])
  assert.equal(listed.filter(label => label === "icon-a").length, 1)
  assert(!listed.includes("notes")); assert(listed.includes("huge"))
  for (const [part, file] of [[0, other], [1, text]] as const) {
    const target = { messageID: id, part, index: 1, digest: sha(file.state.content[1].uri) }
    assert.deepEqual(await fixture.read(target), { status: "blocked", reason: "not-gallery" })
    assert.deepEqual(await fixture.reference(target), { status: "refused", reason: "not-gallery" })
  }
  // Decode bounds (4096² → not-previewable) belong to the API 4 channel; the plugin serves the read bytes.
  assert.equal((await fixture.read({ messageID: id, part: 2, index: 1, digest: sha(big.state.content[1].uri) })).status, "asset")
})

each("an unverifiable read image is still served", async fixture => {
  fixture.fillers(40); fixture.reread("msg_zz_late_a", 300)
  const item = (await fixture.walk()).all.find(entry => entry.kind === "image" && entry.origin === "unverifiable")
  assert(item?.kind === "image")
  assert.equal((await fixture.read(item.target)).status, "asset")
  assert.deepEqual(await fixture.reference(item.target), { status: "refused", reason: "unverifiable" })
})

each("a parallel write of the same file during the read interval", async fixture => {
  const time = stretchRead(fixture, 400), row = fixture.row(A_READ), value = JSON.parse(row.data)
  const call = structuredClone(fixture.call()); call.id = "call_zz_overlap"; call.state.metadata.jobID = "image_zz_overlap"
  call.time = { created: time.ran + 100, ran: time.ran + 100, completed: time.ran + 110 }; value.content.push(call); fixture.update(row.id, value)
  assert(has(image(await fixture.lines(), "icon-a")[0], "origin:unverifiable", "read:asset"), "a parallel call still running")
  fixture.noticeFor(15, "image_zz_overlap", time.ran + 200)
  assert(has(image(await fixture.lines(), "icon-a")[0], "origin:unverifiable", "read:asset"), "a parallel call delivered during the read")
})

each("an older job's notice delivered during the read", async fixture => {
  const time = stretchRead(fixture, 400); fixture.noticeFor(15, "image_zz_old_job", time.ran + 200)
  assert(has(image(await fixture.lines(), "icon-a")[0], "origin:unverifiable", "read:asset"))
})

for (const [name, offset, expected] of [["inside", 200, "origin:unverifiable"], ["after", 1000, "origin:proven"]] as const) {
  each(`an undecodable notice sequenced after the source row, dated ${name} the read`, async fixture => {
    const time = stretchRead(fixture, 400); fixture.noticeFor(15, `image_zz_hidden_${name}`, time.ran + offset, 70 * 1024)
    assert(has(image(await fixture.lines(), "icon-a")[0], expected, "read:asset"))
  })
}

for (const [name, offset, parents] of [["inside", 200, "parents:0 other:1"], ["after", 1000, "parents:1 other:0"]] as const) {
  each(`a parent overwritten ${name} the generation's interval`, async fixture => {
    const row = fixture.row(A2_CALL), value = JSON.parse(row.data), call = value.content.find((part: any) => part.name === "image_generate")
    call.time.completed = call.time.ran + 400; fixture.update(row.id, value); fixture.noticeFor(49, `image_zz_parent_${name}`, call.time.ran + offset)
    assert(has(image(await fixture.lines(), "icon-a2")[0], "origin:proven", parents))
  })
}

each("a read without completion time, and a read starting at the notice's instant", async fixture => {
  const row = fixture.row(A_READ), value = JSON.parse(row.data), part = value.content[fixture.readPart(value)]
  const completed = part.time.completed
  delete part.time.completed; fixture.update(row.id, value)
  assert(has(image(await fixture.lines(), "icon-a")[0], "origin:unverifiable"))
  part.time = { ...part.time, completed, ran: fixture.row(A_NOTICE).time_created }; fixture.update(row.id, value)
  assert(has(image(await fixture.lines(), "icon-a")[0], "origin:unverifiable"))
})

each("three ~12 MiB messages: two on page 1, the cursor on the refused row, the third on page 2", async fixture => {
  const value = fixture.json(A_READ), base = value.content[fixture.readPart(value)]
  for (const n of [1, 2, 3]) {
    const part = structuredClone(base), when = Date.now() + n
    part.id = `call_zz_big_${n}`; part.time = { created: when, ran: when, completed: when + 1 }
    part.state.content[1].name = part.state.content[1].name.replace("icon-a.png", `big-${n}.png`)
    fixture.insert(`msg_zz_big_${n}`, "assistant", 500 + n, when, { ...value, content: [part, { type: "text", text: "p".repeat(12 * 1024 * 1024) }] })
  }
  const { listGalleryImages } = await import("./assets-gallery")
  const first = await listGalleryImages(fixture.db, fixture.scope, undefined, false, new AbortController().signal)
  assert(first.status === "page" && first.cursor)
  assert.deepEqual(first.entries.filter(entry => entry.kind === "image").map(entry => entry.label), ["big-3", "big-2"])
  const next = JSON.parse(Buffer.from(first.cursor, "base64url").toString())
  assert.deepEqual([next.sequence, next.offset], [501, 0])
  const second = await listGalleryImages(fixture.db, fixture.scope, first.cursor, false, new AbortController().signal)
  assert(second.status === "page")
  assert.equal(second.entries.find(entry => entry.kind === "image")?.label, "big-1")
})

for (const name of ["relative", "absolute"] as const) {
  each(`${name} internal read name: proven, labelled, and referenced by its location-relative path`, async fixture => {
    const row = fixture.row(A_READ), value = JSON.parse(row.data)
    if (name === "relative") { fixture.fileOf(value).name = ".codenomad/design/icon/icon-a.png"; fixture.update(row.id, value) }
    assert(has(image(await fixture.lines(), "icon-a")[0], "origin:proven"))
    assert.deepEqual(await fixture.reference(fixture.readTarget()), { status: "path", path: ".codenomad/design/icon/icon-a.png" })
  })
}

each("a relative name escaping the location: no label, pixels kept, reference refused", async fixture => {
  const row = fixture.row(A_READ), value = JSON.parse(row.data)
  fixture.fileOf(value).name = "../outside.png"; fixture.update(row.id, value)
  const lines = await fixture.lines()
  assert(lines.some(line => line.startsWith("IMG ∅ ") && line.includes("read:asset")))
  assert.equal((await fixture.reference(fixture.readTarget())).status, "refused")
})

each("a reference after a later write of the same file is refused as changed", async fixture => {
  fixture.noticeFor(160, "image_zz_later", Date.now())
  assert.deepEqual(await fixture.reference(fixture.readTarget()), { status: "refused", reason: "changed" })
})
