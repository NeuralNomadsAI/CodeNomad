// Opt-in measurement of timeline/transcript agreement on replayed native sessions:
// npm run qualify:browser:timeline-sync --workspace @codenomad/ui -- <db-index.json> <out.json> [options.json]
// The index lists `{ sessionID, path, count }` native-shaped stores (see
// `createSessionStore`); each is read by the real server outline, window and
// preview readers while the page mounts the real SessionView.
import { readFile, writeFile } from "node:fs/promises"
import type { Page } from "playwright"
import { collectTranscriptMarkers, openTimelineSession, settleTranscript as settle, startTimelineSyncServer } from "./timeline-sync-session"

const [indexPath, outPath, optionsJson] = process.argv.slice(2)
const options = { presets: ["everything", "balanced"], viewports: [[1280, 800]], clicks: 16, scrolls: 8, sessions: undefined as string[] | undefined,
  workers: 2, seed: 7, trace: false, ...(optionsJson ? JSON.parse(await readFile(optionsJson, "utf8")) : {}) }
const sessions: Array<{ sessionID: string; path: string; count: number }> = JSON.parse(await readFile(indexPath, "utf8"))
  .filter((entry: any) => !options.sessions || options.sessions.includes(entry.sessionID))
const server = await startTimelineSyncServer({ instrument: true })

function rng(seed: number) { return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32 } }

async function openSession(entry: { sessionID: string; path: string }, preset: string, viewport: number[]) {
  const page = await server.browser.newPage({ viewport: { width: viewport[0], height: viewport[1] } })
  const session = await openTimelineSession(page, server.url, entry.path, preset)
  return { page, db: session.db, errors: session.state.errors, state: session.state, close: async () => { await page.close(); session.close() } }
}
type Marker = { id: string; messageId: string; type: string; toolPartIds?: string[]; partIds?: string[]; toolName?: string }
const markers = (page: Page): Promise<Marker[]> => page.evaluate(() => (globalThis as any).__timeline.visible().map((s: any) => ({
  id: s.id, messageId: s.messageId, type: s.type, toolPartIds: s.toolPartIds, partIds: s.partIds, toolName: s.toolName })))

// The marker-worthy items a message shows under the current preset, from its native content.
function expectedFromNative(message: any, flags: { hidden: Record<string, boolean>; thinking: boolean; system: string }) {
  const items: Array<{ kind: string; partId?: string }> = []
  if (message.type === "user") return [{ kind: "user" }]
  if (message.type === "compaction") return [{ kind: "compaction" }]
  if (message.type === "system") return flags.system !== "hidden" ? [{ kind: "system" }] : []
  if (message.type !== "assistant") return []
  // Runs: consecutive visible text parts form one content row, consecutive
  // thinking one card or group; hidden parts do not interrupt a run.
  let run = ""
  ;(message.content ?? []).forEach((part: any, index: number) => {
    if (part.type === "text") {
      if (part.synthetic || part.ignored || !String(part.text ?? "").trim()) return
      if (run !== "T") items.push({ kind: "assistant", partId: `${message.id}-text-${index}` })
      run = "T"
    } else if (part.type === "reasoning") {
      if (!String(part.text ?? "").trim()) return
      if (run !== "R" && flags.thinking) items.push({ kind: "reasoning", partId: `${message.id}-reasoning-${index}` })
      run = "R"
    } else if (part.type === "tool") {
      if (flags.hidden[part.name]) return
      run = "X"
      items.push({ kind: "tool", partId: part.id })
    }
  })
  return items
}

function lcs(a: string[], b: string[]) {
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0))
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1])
  return dp[a.length][b.length]
}
function lisLength(values: number[]) {
  const tails: number[] = []
  for (const value of values) { let lo = 0, hi = tails.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (tails[mid] < value) lo = mid + 1; else hi = mid } tails[lo] = value }
  return tails.length
}

const CORE = new Set(["user", "assistant", "tool", "compaction"])
const FULL = new Set([...CORE, "reasoning", "system"])
function compare(expectedByMessage: Map<string, Array<{ kind: string; partId?: string }>>, seqOf: Map<string, number>, allMarkers: Marker[], resident: Set<string>, kinds: Set<string>) {
  const rail = allMarkers.filter(marker => kinds.has(marker.type))
  const railByMessage = new Map<string, Marker[]>()
  for (const marker of rail) { const list = railByMessage.get(marker.messageId) ?? []; list.push(marker); railByMessage.set(marker.messageId, list) }
  const result = { expected: 0, markers: rail.length, missing: 0, extra: 0, inverted: 0, messagesOutOfOrder: 0, unmarkedVisible: { reasoning: 0, system: 0 },
    causes: { aggregatedTools: 0, toolsBeforeText: 0, missingText: 0, extraText: 0, textRuns: 0, hiddenFilter: 0, appendedOutOfOrder: 0, missingMessage: 0,
      missingThinking: 0, missingSystem: 0, otherMissing: 0, otherExtra: 0 },
    residentMessages: 0, residentDesync: 0, outlineMessages: 0, outlineDesync: 0 }
  for (const [messageId, all] of expectedByMessage) {
    const expected = all.filter(item => kinds.has(item.kind))
    for (const item of all) if (item.kind === "reasoning") result.unmarkedVisible.reasoning++; else if (item.kind === "system") result.unmarkedVisible.system++
    const actual = railByMessage.get(messageId) ?? []
    if (!expected.length && !actual.length) continue
    result.expected += expected.length
    const counts = (kinds: string[]) => kinds.reduce((map, kind) => map.set(kind, (map.get(kind) ?? 0) + 1), new Map<string, number>())
    const e = counts(expected.map(item => item.kind)), a = counts(actual.map(item => item.type))
    let missing = 0, extra = 0
    for (const kind of kinds) {
      const de = e.get(kind) ?? 0, da = a.get(kind) ?? 0
      if (de > da) missing += de - da; else extra += da - de
      if (kind === "tool" && de > 1 && da === 1) result.causes.aggregatedTools += de - 1
      else if (kind === "tool" && de > da && da === 0 && actual.length === 0) result.causes.missingMessage += de
      else if (kind === "tool" && de > da) result.causes.hiddenFilter += de - da
      else if (kind === "tool" && da > de) result.causes.hiddenFilter += da - de
      else if (kind === "assistant" && de > da) { if (de > 1 && da >= 1) result.causes.textRuns += de - da; else if (actual.length === 0) result.causes.missingMessage += de - da; else result.causes.missingText += de - da }
      else if (kind === "assistant" && da > de) result.causes.extraText += da - de
      else if (kind === "reasoning" && de > da) result.causes.missingThinking += de - da
      else if (kind === "system" && de > da) result.causes.missingSystem += de - da
      else if (de > da) { if (actual.length === 0) result.causes.missingMessage += de - da; else result.causes.otherMissing += de - da }
      else if (da > de) result.causes.otherExtra += da - de
    }
    const ek = expected.map(item => item.kind), ak = actual.map(item => item.type)
    const inverted = Math.min(ek.length - missing, ak.length - extra) - lcs(ek, ak)
    if (inverted > 0) {
      result.inverted += inverted
      const firstTool = ak.indexOf("tool"), firstText = ak.indexOf("assistant")
      if (firstTool >= 0 && firstText > firstTool && ek.indexOf("assistant") >= 0 && ek.indexOf("assistant") < ek.indexOf("tool")) result.causes.toolsBeforeText += inverted
    }
    result.missing += missing; result.extra += extra
    const desync = missing + extra + Math.max(0, inverted) > 0
    if (resident.has(messageId)) { result.residentMessages++; if (desync) result.residentDesync++ } else { result.outlineMessages++; if (desync) result.outlineDesync++ }
  }
  for (const [messageId, list] of railByMessage) if (!expectedByMessage.has(messageId)) { result.extra += list.length; result.causes.otherExtra += list.length }
  // Message order: markers must follow native sequence.
  const firstIndex = new Map<string, number>()
  rail.forEach((marker, index) => { if (!firstIndex.has(marker.messageId)) firstIndex.set(marker.messageId, index) })
  const ordered = [...firstIndex.keys()].filter(id => seqOf.has(id))
  const seqs = ordered.map(id => seqOf.get(id)!)
  result.messagesOutOfOrder = seqs.length - lisLength(seqs)
  // Out-of-order messages at the rail's tail: appended resident messages.
  let maxSeq = -1
  for (const id of ordered) { const seq = seqOf.get(id)!; if (seq < maxSeq) result.causes.appendedOutOfOrder++; maxSeq = Math.max(maxSeq, seq) }
  return result
}

async function measureSession(entry: { sessionID: string; path: string; count: number }, preset: string, viewport: number[], seed: number) {
  const s = await openSession(entry, preset, viewport)
  const { page, db } = s
  const random = rng(seed)
  try {
    const seqOf = new Map<string, number>(), messageOf = new Map<string, any>()
    for (const r of db.prepare("SELECT id,type,seq,data FROM session_message ORDER BY seq").all() as any[]) {
      seqOf.set(r.id, Number(r.seq)); messageOf.set(r.id, { ...JSON.parse(r.data), id: r.id, type: r.type })
    }
    const toolNames = [...new Set([...messageOf.values()].flatMap(m => (m.content ?? []).filter((p: any) => p.type === "tool").map((p: any) => p.name)))]
    const flags = await page.evaluate(names => ({ hidden: Object.fromEntries(names.map(n => [n, (window as any).fixture.toolHidden(n)])),
      thinking: (window as any).fixture.showThinking(), system: (window as any).fixture.systemVisibility() }), toolNames)
    const rail0 = await markers(page)
    const resident = new Set<string>(await page.evaluate(() => (window as any).fixture.ids()))
    // Validate the native rule against the rendered transcript for resident messages.
    const { dom, byMessage: domByMessage, errorRows } = await collectTranscriptMarkers(page, messageOf)
    let ruleMismatch = 0
    for (const id of resident) {
      const message = messageOf.get(id)
      if (!message) continue
      const rule = expectedFromNative(message, flags).map(item => item.kind).join(",")
      const seen = (domByMessage.get(id) ?? []).map(item => item.kind).join(",")
      if (rule !== seen) ruleMismatch++
    }
    const expected = new Map<string, Array<{ kind: string; partId?: string }>>()
    for (const [id, message] of messageOf) {
      const items = resident.has(id) ? domByMessage.get(id) ?? [] : expectedFromNative(message, flags)
      if (items.length) expected.set(id, items)
    }
    const desync = compare(expected, seqOf, rail0, resident, CORE)
    const desyncFull = compare(expected, seqOf, rail0, resident, FULL)
    // Clicks: random visible markers, with real pointer events on the rail.
    const clicks: any[] = []
    for (let n = 0; n < options.clicks; n++) {
      const rail = await markers(page)
      if (!rail.length) break
      const index = Math.floor(random() * rail.length)
      const target = rail[index]
      const residentBefore = (await page.evaluate(() => (window as any).fixture.ids())).includes(target.messageId)
      await page.locator(".message-timeline").hover()
      await page.evaluate(({ index, count }) => {
        const rail = document.querySelector<HTMLElement>(".message-timeline")!
        rail.scrollTop = Math.max(0, rail.scrollHeight * (index + 0.5) / count - rail.clientHeight / 2)
      }, { index, count: rail.length })
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      const box = await page.locator(`.message-timeline-segment[data-segment-id="${CSS_escape(target.id)}"]`).boundingBox().catch(() => null)
      if (!box) { clicks.push({ skipped: true, type: target.type }); continue }
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
      const trace = options.trace ? await page.evaluate(messageId => new Promise<any[]>(resolve => {
        const samples: any[] = [], started = performance.now()
        let last: Element | null = null
        const tick = () => {
          const stream = document.querySelector<HTMLElement>(".message-stream")!
          const row = stream.querySelector(`[data-virtual-follow-key="${CSS.escape(messageId)}"]`)
          samples.push({ t: Math.round(performance.now() - started), top: stream.scrollTop, rowDelta: row ? Math.round(row.getBoundingClientRect().top - stream.getBoundingClientRect().top) : null,
            replaced: Boolean(row && last && row !== last), follow: stream.dataset.followMode, paging: Boolean(document.querySelector(".history-navigation-status")) })
          last = row ?? last
          if (performance.now() - started < 3000) requestAnimationFrame(tick); else resolve(samples)
        }
        requestAnimationFrame(tick)
      }), target.messageId) : undefined
      await settle(page, 400)
      const after = await markers(page)
      const active = await page.evaluate(() => (globalThis as any).__timeline.active())
      const logical = (m: Marker, list: Marker[]) => `${m.messageId}|${m.type}|${list.filter(o => o.messageId === m.messageId && o.type === m.type).indexOf(m)}`
      const clickedKey = logical(target, rail)
      const clickedNow = after.find(m => m.id === target.id) ?? after.find(m => logical(m, after) === clickedKey)
        ?? after.find(m => m.messageId === target.messageId && m.type === target.type)
      const activeIndex = after.findIndex(m => m.id === active)
      const clickedIndex = clickedNow ? after.indexOf(clickedNow) : -1
      const position = await page.evaluate(({ messageId, type, partIds, toolPartIds }) => {
        const stream = document.querySelector<HTMLElement>(".message-stream")!
        const view = stream.getBoundingClientRect()
        const row = stream.querySelector<HTMLElement>(`[data-virtual-follow-key="${CSS.escape(messageId)}"]`)
        if (!row) return { found: false, resident: (window as any).fixture.ids().includes(messageId), paging: Boolean(document.querySelector(".history-navigation-status")),
          shown: [...stream.querySelectorAll<HTMLElement>("[data-virtual-follow-key]")].map(row => row.dataset.virtualFollowKey).slice(0, 3) }
        const visible = (el: Element | null | undefined) => el && el.getBoundingClientRect().height > 0 ? el : null
        let el: Element | null = null
        if (type === "user") el = row.querySelector('.message-item-base[data-message-role="user"]')
        else if (type === "assistant") el = (partIds ?? []).map((id: string) => row.querySelector(`.message-item-base[data-message-content-start-part-id="${CSS.escape(id)}"]`)).find(Boolean)
          ?? row.querySelector('.message-item-base[data-message-role="assistant"]')
        else if (type === "compaction") el = row.querySelector(".message-compaction-card")
        else if (type === "system") el = row.querySelector('[data-message-kind="system"]')
        else if (type === "reasoning" || type === "tool") {
          const id = (type === "tool" ? toolPartIds : partIds)?.[0]
          el = visible(id ? row.querySelector(`${type === "tool" ? ".tool-call-message" : ".message-reasoning-card"}[data-part-id="${CSS.escape(id)}"]`) : null)
          if (!el && id) {
            // A collapsed technical group shows its parts as its header, in the
            // message where the group starts: this row or an earlier one.
            const root = row.querySelector(`[data-group-part-ids~="${CSS.escape(id)}"]`)
            el = visible(root?.querySelector(".message-technical-group-toggle"))
              ?? (root ? [...stream.querySelectorAll(".message-technical-group-toggle")]
                .filter(toggle => visible(toggle) && toggle.compareDocumentPosition(root) & Node.DOCUMENT_POSITION_FOLLOWING).at(-1) ?? null : null)
          }
        }
        el = visible(el) ?? el
        if (!el) return { found: false, rowDelta: row.getBoundingClientRect().top - view.top }
        const rect = el.getBoundingClientRect()
        const atBottom = stream.scrollTop + stream.clientHeight >= stream.scrollHeight - 2
        return { found: true, delta: rect.top - view.top, rowDelta: row.getBoundingClientRect().top - view.top, height: rect.height, atBottom,
          inView: rect.bottom > view.top && rect.top < view.bottom }
      }, { messageId: target.messageId, type: target.type, partIds: clickedNow?.partIds ?? target.partIds, toolPartIds: clickedNow?.toolPartIds ?? target.toolPartIds })
      clicks.push({ id: target.id, type: target.type, residentBefore, activeMatch: Boolean(clickedNow && active === clickedNow.id),
        offset: activeIndex >= 0 && clickedIndex >= 0 ? activeIndex - clickedIndex : null, activeMessageMatch: after[activeIndex]?.messageId === target.messageId,
        position, positionOk: Boolean(position.found && (Math.abs(position.delta!) <= 32 || (position.atBottom && position.inView))), ...(trace ? { trace } : {}) })
    }
    // Scroll-driven activity: wheel the transcript and compare with the item at the reading line.
    const scrolls: any[] = []
    for (let n = 0; n < options.scrolls; n++) {
      const stream = await page.locator(".message-stream").boundingBox()
      if (!stream) break
      await page.mouse.move(stream.x + stream.width / 2, stream.y + stream.height / 2)
      const transcriptTop = () => page.evaluate(() => document.querySelector<HTMLElement>(".message-stream")!.scrollTop)
      const [before, activeBefore] = [await transcriptTop(), await page.evaluate(() => (globalThis as any).__timeline.active())]
      await page.mouse.wheel(0, (random() < 0.5 ? -1 : 1) * (300 + Math.floor(random() * 2500)))
      await settle(page, 400)
      // A wheel over a nested scroller (tool output, thinking) scrolls only that block.
      const moved = Math.abs(await transcriptTop() - before) >= 1
      const rail = await markers(page)
      const active = await page.evaluate(() => (globalThis as any).__timeline.active())
      // The reading line: blocks reaching more than 4 px below the transcript top, in order.
      const blocks: any[] = await page.evaluate(() => {
        const stream = document.querySelector<HTMLElement>(".message-stream")!
        const line = stream.getBoundingClientRect().top + 4
        return [...stream.querySelectorAll<HTMLElement>('.message-item-base[data-message-content-start-part-id], .tool-call-message[data-part-id], .message-technical-group-toggle, .message-reasoning-card[data-part-id], .message-compaction-card, [data-message-kind="system"]')]
          .map(el => ({ el, rect: el.getBoundingClientRect(), row: el.closest<HTMLElement>("[data-virtual-follow-key]")?.dataset.virtualFollowKey }))
          .filter(({ rect, row }) => row && rect.height > 0 && rect.bottom > line).sort((a, b) => a.rect.top - b.rect.top).slice(0, 12)
          .map(({ el, row }) => ({ messageId: row, kind: el.classList.contains("message-item-base") ? "content" : el.classList.contains("tool-call-message") ? "tool"
            : el.classList.contains("message-technical-group-toggle") ? "group" : el.classList.contains("message-reasoning-card") ? "reasoning"
              : el.classList.contains("message-compaction-card") ? "compaction" : "system",
            start: el.dataset.messageContentStartPartId, owner: el.dataset.messageId, partId: el.dataset.partId,
            groupIds: el.closest<HTMLElement>("[data-group-part-ids]")?.dataset.groupPartIds?.split(" ") ?? [] }))
      })
      const markerFor = (block: any) => rail.find(m => m.messageId === block.messageId && (
        block.kind === "content" ? block.owner === block.messageId && (m.type === "user" || m.type === "assistant") && (!m.partIds?.length || m.partIds.includes(block.start))
          : block.kind === "tool" ? m.type === "tool" && (!m.toolPartIds?.length || m.toolPartIds.includes(block.partId))
            : block.kind === "group" ? block.groupIds.some((id: string) => (m.type === "tool" && m.toolPartIds?.includes(id)) || (m.type === "reasoning" && m.partIds?.includes(id)))
              : block.kind === "reasoning" ? m.type === "reasoning" && (!m.partIds?.length || m.partIds.includes(block.partId)) : m.type === block.kind))
      const reading = blocks[0]
      if (!reading) continue
      const expectedMarker = blocks.map(markerFor).find(Boolean)
      const activeIndex = rail.findIndex(m => m.id === active), expectedIndex = expectedMarker ? rail.indexOf(expectedMarker) : -1
      const match = Boolean(expectedMarker && expectedMarker.id === active)
      const detail = !match && options.trace ? { blocks: blocks.slice(0, 3), expected: expectedMarker?.id, active,
        state: await page.evaluate(() => ({ top: document.querySelector<HTMLElement>(".message-stream")!.scrollTop, paging: Boolean(document.querySelector(".history-navigation-status")),
          follow: document.querySelector<HTMLElement>(".message-stream")!.dataset.followMode })) } : undefined
      scrolls.push({ hasMarker: Boolean(markerFor(reading)), readingKind: reading.kind, match, moved, keptBeforeActive: !moved && active === activeBefore, ...(detail ? { detail } : {}),
        offset: activeIndex >= 0 && expectedIndex >= 0 ? activeIndex - expectedIndex : null, sameMessage: rail[activeIndex]?.messageId === expectedMarker?.messageId })
    }
    return { sessionID: entry.sessionID, count: entry.count, preset, viewport, resident: resident.size, domItems: dom.length, errorRows, ruleMismatch, desync, desyncFull, clicks, scrolls,
      windows: s.state.windows, errors: s.errors.slice(0, 5) }
  } finally { await s.close() }
}
function CSS_escape(value: string) { return value.replace(/["\\]/g, "\\$&") }

const jobs = sessions.flatMap((entry, i) => options.presets.flatMap((preset: string) => options.viewports.map((viewport: number[]) => ({ entry, preset, viewport, seed: options.seed + i }))))
const results: any[] = []
let next = 0
await Promise.all(Array.from({ length: options.workers }, async () => {
  while (next < jobs.length) {
    const job = jobs[next++]
    const started = Date.now()
    try {
      const result = await measureSession(job.entry, job.preset, job.viewport, job.seed)
      results.push(result)
      const c = result.clicks.filter((x: any) => !x.skipped)
      console.log(`${job.entry.sessionID} ${job.preset} ${job.viewport.join("x")} n=${job.entry.count} markers=${result.desync.markers}/${result.desync.expected} missing=${result.desync.missing} extra=${result.desync.extra} inverted=${result.desync.inverted} outOfOrder=${result.desync.messagesOutOfOrder} full=${result.desyncFull.markers}/${result.desyncFull.expected}-${result.desyncFull.missing}+${result.desyncFull.extra}~${result.desyncFull.inverted} ruleMismatch=${result.ruleMismatch} clicks ok=${c.filter((x: any) => x.activeMatch).length}/${c.length} pos=${c.filter((x: any) => x.positionOk).length}/${c.length} (${Math.round((Date.now() - started) / 1000)}s)`)
    } catch (error) {
      results.push({ sessionID: job.entry.sessionID, preset: job.preset, viewport: job.viewport, failed: String(error) })
      console.log(`${job.entry.sessionID} ${job.preset} FAILED ${String(error).slice(0, 300)}`)
    }
    await writeFile(outPath, JSON.stringify(results))
  }
}))
await server.close()
