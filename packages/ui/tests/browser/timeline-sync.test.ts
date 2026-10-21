import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Page } from "playwright"
import { collectTranscriptMarkers, createSessionStore, openTimelineSession, settleTranscript, startTimelineSyncServer } from "./timeline-sync-session"

// Real SessionView over 320 native records, the oldest 120 outside the resident
// window, with the step shapes found in real sessions: thinking, a reply, then
// tools; a reply after its tool; several tools per step (a collapsed group);
// compaction and system context.
const COUNT = 320
const id = (index: number) => `msg_${String(index).padStart(4, "0")}`
const model = { providerID: "fixture", id: "fixture" }
const prose = (label: string, lines: number) => `${label}\n\n${"A paragraph of transcript content for the navigation fixture. ".repeat(lines)}`
const tool = (messageId: string, name: string, lines = 6) => ({ type: "tool", id: `${messageId}-${name}`, name, time: { created: 1 },
  state: { status: "completed", input: { query: name }, content: [{ type: "text", text: `${name} output\n`.repeat(lines) }] } })
const assistant = (index: number, content: unknown[]) => ({ id: id(index), type: "assistant", agent: "build", model, time: { created: index + 1, completed: index + 2 }, content })
function message(index: number): any {
  const messageId = id(index)
  switch (index % 8) {
    case 0: return { id: messageId, type: "user", time: { created: index + 1 }, text: prose(`Question ${index}`, 3) }
    case 1: return assistant(index, [{ type: "reasoning", text: prose(`Plan ${index}`, 2) }, { type: "text", text: prose(`Reply ${index}`, 8) },
      tool(messageId, "fixture_alpha"), tool(messageId, "fixture_beta")])
    case 2: return assistant(index, [{ type: "reasoning", text: prose(`Check ${index}`, 2) }, tool(messageId, "bash", 12)])
    case 3: return assistant(index, [tool(messageId, "fixture_gamma"), { type: "text", text: prose(`After ${index}`, 4) }])
    case 4: return assistant(index, [{ type: "reasoning", text: prose(`Think ${index}`, 2) }, { type: "text", text: prose(`Answer ${index}`, 5) }])
    case 5: return index % 40 === 5
      ? { id: messageId, type: "compaction", reason: "auto", status: "completed", summary: prose(`Summary ${index}`, 2), time: { created: index + 1 } }
      : { id: messageId, type: "idle", outcome: "succeeded", time: { created: index + 1 } }
    case 6: return index % 40 === 6
      ? { id: messageId, type: "system", text: prose(`Context ${index}`, 2), description: `Context ${index}`, time: { created: index + 1 } }
      : assistant(index, [{ type: "text", text: prose(`Note ${index}`, 3) }])
    default: return assistant(index, [tool(messageId, "read"), tool(`${messageId}-2`, "read"), tool(messageId, "glob")])
  }
}
/** The transcript blocks of a record that carry a marker, as `messageId:type`. */
function expectedMarkers(index: number, everything: boolean): string[] {
  const kinds = [["user"], ["reasoning", "assistant", "tool", "tool"], ["reasoning", "tool"], ["tool", "assistant"], ["reasoning", "assistant"],
    index % 40 === 5 ? ["compaction"] : [], index % 40 === 6 ? ["system"] : ["assistant"], ["tool", "tool", "tool"]][index % 8]
  return kinds.filter(kind => everything || (kind !== "reasoning" && kind !== "system")).map(kind => `${id(index)}:${kind}`)
}

// Each transcript row boundary the visibility filters can move: text and
// thinking around tools of every visibility, grouped tools around a shell call,
// system context and compaction.
const step = (index: number, parts: Array<[string, string]>) => assistant(index, parts.map(([type, value], part) => type === "tool"
  ? { ...tool(id(index), value), id: `${id(index)}-${value}-${part}` } : { type, text: prose(value, 1) }))
const visibilityMessages = [
  { id: id(0), type: "user", time: { created: 1 }, text: prose("Question", 1) },
  step(1, [["text", "Before"], ["tool", "bash"], ["reasoning", "Midway"], ["tool", "read"], ["text", "After"]]),
  step(2, [["reasoning", "First"], ["tool", "fixture_alpha"], ["reasoning", "Second"], ["text", "Reply"]]),
  step(3, [["text", "Lead"], ["tool", "fixture_alpha"], ["text", "Tail"]]),
  step(4, [["reasoning", "Plan"], ["tool", "read"], ["tool", "bash"], ["tool", "read"], ["text", "Found"]]),
  { id: id(5), type: "system", text: prose("Context", 1), description: "Context", time: { created: 6 } },
  step(6, [["tool", "glob"], ["reasoning", "Look"], ["text", "Say"], ["reasoning", "More"], ["tool", "grep"]]),
  { id: id(7), type: "compaction", reason: "auto", status: "completed", summary: prose("Summary", 1), time: { created: 8 } },
  { id: id(8), type: "user", time: { created: 9 }, text: prose("Again", 1) },
  step(9, [["reasoning", "Think"], ["text", "Answer"], ["tool", "fixture_alpha"], ["text", "Then"], ["tool", "fixture_beta"]]),
]
// One indexed step whose 1,001 tools exceed the transcript's part display window.
const WIDE_TOOLS = 1001
const wideMessages = Array.from({ length: 260 }, (_, index) => index === 1
  ? assistant(1, [...Array.from({ length: WIDE_TOOLS }, (_, n) => ({ ...tool(id(1), "fixture_alpha", 1), id: `${id(1)}-t${n}` })),
    { type: "text", text: prose("Done", 1) }])
  : index % 2 ? assistant(index, [{ type: "text", text: prose(`Note ${index}`, 2) }]) : { id: id(index), type: "user", time: { created: index + 1 }, text: prose(`Ask ${index}`, 1) })

let server: Awaited<ReturnType<typeof startTimelineSyncServer>>, directory: string, store: string, visibilityStore: string, wideStore: string
before(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "codenomad-timeline-sync-"))
  store = path.join(directory, "session.sqlite")
  createSessionStore(store, Array.from({ length: COUNT }, (_, index) => message(index)))
  visibilityStore = path.join(directory, "visibility.sqlite")
  createSessionStore(visibilityStore, visibilityMessages)
  wideStore = path.join(directory, "wide.sqlite")
  createSessionStore(wideStore, wideMessages)
  server = await startTimelineSyncServer({ instrument: true })
})
after(async () => { await server?.close(); if (directory) await rm(directory, { recursive: true, force: true }) })

type Marker = { id: string; messageId: string; type: string; partIds?: string[]; toolPartIds?: string[] }
const markers = (page: Page): Promise<Marker[]> => page.evaluate(() => (globalThis as any).__timeline.visible()
  .map(({ id, messageId, type, partIds, toolPartIds }: Marker) => ({ id, messageId, type, partIds, toolPartIds })))
const active = (page: Page): Promise<string | null> => page.evaluate(() => (globalThis as any).__timeline.active())

async function withSession(preset: string, run: (page: Page) => Promise<void>, sessionStore = store) {
  const page = await server.browser.newPage({ viewport: { width: 1280, height: 800 } })
  const session = await openTimelineSession(page, server.url, sessionStore, preset)
  try {
    await run(page)
    assert.deepEqual(session.state.errors, [])
  } finally { await page.close(); session.close() }
}

/** Scrolls the rail to a marker like a reader, then clicks it with the pointer. */
async function clickMarker(page: Page, marker: Marker) {
  const rail = page.locator(".message-timeline")
  await rail.hover()
  const list = await markers(page)
  await rail.evaluate((element, { index, count }) => {
    element.scrollTop = Math.max(0, element.scrollHeight * (index + 0.5) / count - element.clientHeight / 2)
  }, { index: list.findIndex(candidate => candidate.id === marker.id), count: list.length })
  await page.locator(`.message-timeline-segment[data-segment-id="${marker.id}"]`).click()
  await settleTranscript(page, 400)
}

/** Distance from the transcript top to the block the marker stands for. */
function blockOffset(page: Page, marker: Marker) {
  return page.evaluate((marker) => {
    const stream = document.querySelector<HTMLElement>(".message-stream")!
    const row = stream.querySelector(`[data-virtual-follow-key="${CSS.escape(marker.messageId)}"]`)
    const part = marker.toolPartIds?.[0] ?? marker.partIds?.[0] ?? ""
    const shown = (element: Element | null | undefined) => element && element.getBoundingClientRect().height > 0 ? element : null
    const block = marker.type === "tool"
      ? shown(row?.querySelector(`.tool-call-message[data-part-id="${CSS.escape(part)}"]`)) ?? row?.querySelector(`[data-group-part-ids~="${CSS.escape(part)}"] .message-technical-group-toggle`)
      : row?.querySelector(`.message-item-base[data-message-content-start-part-id="${CSS.escape(part)}"]`)
    return block ? block.getBoundingClientRect().top - stream.getBoundingClientRect().top : null
  }, marker)
}

for (const preset of ["balanced", "everything"]) {
  test(`${preset}: the rail lists every marked transcript block in order, indexed and resident alike`, { timeout: 90_000 }, () => withSession(preset, async (page) => {
    const expected = Array.from({ length: COUNT }, (_, index) => expectedMarkers(index, preset === "everything")).flat()
    const resident = await page.evaluate(() => (window as any).fixture.ids())
    assert.equal(resident.length, 200, "the oldest 120 records are indexed only")
    assert.deepEqual((await markers(page)).map(marker => `${marker.messageId}:${marker.type}`), expected)
  }))
}

test("a clicked marker stays active and places its own block, resident or indexed", { timeout: 120_000 }, () => withSession("everything", async (page) => {
  const pick = async (index: number, type: string, ordinal = 0) => (await markers(page)).filter(marker => marker.messageId === id(index) && marker.type === type)[ordinal]
  // A step's second tool, a reply below its tool, a reply below its thinking,
  // a collapsed group's third tool, then indexed history and back.
  for (const [index, type, ordinal] of [[281, "tool", 1], [259, "assistant", 0], [292, "assistant", 0], [287, "tool", 2], [17, "tool", 1], [44, "assistant", 0], [8, "user", 0], [305, "tool", 0]] as const) {
    const marker = await pick(index, type, ordinal)
    assert.ok(marker, `${id(index)} has a ${type} marker`)
    await clickMarker(page, marker)
    assert.equal(await active(page), marker.id, `the clicked ${type} marker of ${id(index)} is the active one`)
    assert.equal(await page.locator('.message-timeline-segment[aria-current="true"]').getAttribute("data-segment-id"), marker.id)
    const placed = (await markers(page)).find(candidate => candidate.id === marker.id)!
    const offset = await blockOffset(page, placed)
    assert.ok(offset !== null && Math.abs(offset) <= 2, `${marker.id} is at the reading position (${offset})`)
  }
}))

test("scrolling activates the marker of the block at the reading line", { timeout: 90_000 }, () => withSession("everything", async (page) => {
  const stream = (await page.locator(".message-stream").boundingBox())!
  await page.mouse.move(stream.x + stream.width / 2, stream.y + stream.height / 2)
  for (const distance of [-900, -2600, 700, -1500, 333, -4100]) {
    await page.mouse.wheel(0, distance)
    await settleTranscript(page, 400)
    await assertReadingLineActive(page, `scrolled ${distance}px`)
  }
}))

/** The active marker stands for the block at the transcript's reading line. */
async function assertReadingLineActive(page: Page, context: string) {
  const reading = await page.evaluate(() => {
    const stream = document.querySelector<HTMLElement>(".message-stream")!
    const line = stream.getBoundingClientRect().top + 4
    const block = [...stream.querySelectorAll<HTMLElement>('.message-item-base[data-message-content-start-part-id], .tool-call-message[data-part-id], .message-technical-group-toggle, .message-reasoning-card[data-part-id], .message-compaction-card, [data-message-kind="system"]')]
      .filter(element => element.getBoundingClientRect().height > 0 && element.getBoundingClientRect().bottom > line)
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0]
    return { messageId: block.closest<HTMLElement>("[data-virtual-follow-key]")!.dataset.virtualFollowKey,
      part: block.dataset.messageContentStartPartId ?? block.dataset.partId ?? block.closest<HTMLElement>("[data-group-part-ids]")?.dataset.groupPartIds?.split(" ")[0] }
  })
  const current = await active(page)
  const marker = (await markers(page)).find(candidate => candidate.id === current)
  assert.ok(marker, `a marker is active (${context})`)
  assert.equal(marker.messageId, reading.messageId, context)
  if (reading.part) assert.ok([...marker.partIds ?? [], ...marker.toolPartIds ?? []].includes(reading.part), `${marker.id} stands for ${reading.part} (${context})`)
}

// Every preset, then each thinking, tool and system visibility over Everything.
const visibilityCombinations: Array<{ preset: string; rows?: Record<string, string> }> = [
  ...["nothing", "minimal", "balanced", "everything"].map(preset => ({ preset })),
  ...["hidden", "collapsed", "expanded"].flatMap(thinking => [{}, { bash: "hidden", other: "hidden" },
    { bash: "hidden", read: "hidden", glob: "hidden", grep: "hidden", other: "hidden" }].flatMap(tools => ["hidden", "expanded"].map(system => ({
    preset: "everything", rows: { thinking, system, ...tools } })))),
]
test("under every visibility, the rail has one marker per transcript row, in order", { timeout: 300_000 }, () => withSession("everything", async (page) => {
  const messageOf = new Map(visibilityMessages.map(message => [message.id, message]))
  for (const combination of visibilityCombinations) {
    await page.evaluate(async ({ preset, rows }) => {
      await (window as any).fixture.setPreset(preset)
      if (rows) await (window as any).fixture.setVisibility(rows)
    }, combination)
    await settleTranscript(page, 300)
    const { byMessage } = await collectTranscriptMarkers(page, messageOf)
    const rows = visibilityMessages.flatMap(message => (byMessage.get(message.id) ?? []).map(item => `${message.id}:${item.kind}`))
    assert.ok(rows.length > 0)
    assert.deepEqual((await markers(page)).map(marker => `${marker.messageId}:${marker.type}`), rows, JSON.stringify(combination))
  }
}, visibilityStore))

// The last tool is displayed after the omitted parts; tool 500 is among them.
for (const ordinal of [WIDE_TOOLS - 1, 500]) test(`a step beyond the part display window keeps tool ${ordinal}'s marker identity and target`, { timeout: 120_000 }, async () => {
  const wide = id(1)
  await withSession("balanced", async (page) => {
    const indexed = (await markers(page)).find(marker => marker.id === `${wide}:tool:${ordinal}`)
    assert.ok(indexed && !indexed.toolPartIds, `indexed tool ${ordinal} has a marker before its step loads`)
    await clickMarker(page, indexed)
    await settleTranscript(page, 600)
    assert.equal(await active(page), indexed.id, `tool ${ordinal} stays the active marker once its step loads`)
    assert.equal(await page.locator('.message-timeline-segment[aria-current="true"]').getAttribute("data-segment-id"), indexed.id)
    const placed = (await markers(page)).find(candidate => candidate.id === indexed.id)!
    assert.deepEqual(placed.toolPartIds, [`${wide}-t${ordinal}`], `the marker targets native tool ${ordinal}`)
    const offset = await blockOffset(page, placed)
    assert.ok(offset !== null && Math.abs(offset) <= 2, `native tool ${ordinal} is at the reading position (${offset})`)
  }, wideStore)
})

test("a send after a marker jump returns the active marker to the reading line", { timeout: 90_000 }, () => withSession("everything", async (page) => {
  const marker = (await markers(page)).find(candidate => candidate.messageId === id(259) && candidate.type === "assistant")!
  await clickMarker(page, marker)
  assert.equal(await active(page), marker.id)
  await page.locator(".prompt-input-container textarea").first().fill("Sent after a jump")
  await page.locator(".send-button").click()
  await page.waitForFunction(() => (window as any).fixture.prompts().length === 1)
  await settleTranscript(page, 600)
  assert.ok(await page.evaluate(() => {
    const stream = document.querySelector<HTMLElement>(".message-stream")!
    return stream.scrollTop + stream.clientHeight >= stream.scrollHeight - 2
  }), "the send pins the latest bottom")
  assert.notEqual(await active(page), marker.id, "the marker selected before the send is released")
  await assertReadingLineActive(page, "after the send")
}))
