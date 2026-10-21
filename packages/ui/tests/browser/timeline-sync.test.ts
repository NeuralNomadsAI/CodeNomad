import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Page } from "playwright"
import { createSessionStore, openTimelineSession, settleTranscript, startTimelineSyncServer } from "./timeline-sync-session"

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

let server: Awaited<ReturnType<typeof startTimelineSyncServer>>, directory: string, store: string
before(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "codenomad-timeline-sync-"))
  store = path.join(directory, "session.sqlite")
  createSessionStore(store, Array.from({ length: COUNT }, (_, index) => message(index)))
  server = await startTimelineSyncServer({ instrument: true })
})
after(async () => { await server?.close(); if (directory) await rm(directory, { recursive: true, force: true }) })

type Marker = { id: string; messageId: string; type: string; partIds?: string[]; toolPartIds?: string[] }
const markers = (page: Page): Promise<Marker[]> => page.evaluate(() => (globalThis as any).__timeline.visible()
  .map(({ id, messageId, type, partIds, toolPartIds }: Marker) => ({ id, messageId, type, partIds, toolPartIds })))
const active = (page: Page): Promise<string | null> => page.evaluate(() => (globalThis as any).__timeline.active())

async function withSession(preset: string, run: (page: Page) => Promise<void>) {
  const page = await server.browser.newPage({ viewport: { width: 1280, height: 800 } })
  const session = await openTimelineSession(page, server.url, store, preset)
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
    assert.ok(marker, "a marker is active")
    assert.equal(marker.messageId, reading.messageId, `scrolled ${distance}px`)
    if (reading.part) assert.ok([...marker.partIds ?? [], ...marker.toolPartIds ?? []].includes(reading.part), `${marker.id} stands for ${reading.part}`)
  }
}))
