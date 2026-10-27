import type { DatabaseSync } from "node:sqlite"
import { setImmediate as yieldTurn } from "node:timers/promises"
import type { HistoryScope } from "./history-store"
import { historyContent, historyScopeSQL, historyTexts, HISTORY_SLICE_MS, MAX_MESSAGE_BYTES, textProjection } from "./history-content"
import { compareRank, dateBounds, diverseHits, idfWeights, rankedExcerpt, termMask, searchTerms, termScore, textJudge, type Rank } from "./history-ranking"
import type { HistoryRankedInput, HistoryRankedPage } from "./history-ranked-contract"
import { rankedDirectoryOwnership, type CheckRankedDirectory } from "./history-ranked-ownership"

export const RANKED_LIMITS = { chunk: 1000, candidates: 30_000, sessions: 600, judged: 600, prefilterBytes: 64 * 1024, scanMs: 1500, totalMs: 2000 } as const
interface Candidate { position: number; messageID: string; sessionID: string; createdAt: number; flags?: boolean[]; score: number }
type Judged = Rank & { hit: HistoryRankedPage["hits"][number] }

export async function queryRankedHistory(db: DatabaseSync, scope: HistoryScope, input: HistoryRankedInput, signal: AbortSignal,
  checkDirectory?: CheckRankedDirectory): Promise<HistoryRankedPage> {
  signal.throwIfAborted()
  const started = performance.now()
  let sliceStarted = started
  const terms = searchTerms(input.query)
  const result: HistoryRankedPage = { version: 1, status: "ranked", scanned: 0, candidates: 0, judged: 0, skipped: 0,
    matchedSessions: 0, prefilterBypassed: 0, capped: false, caps: [], exclusions: [], hits: [], sessions: [] }
  if (!terms.length) return result
  const authorize = checkDirectory ?? await rankedDirectoryOwnership(scope.directory, signal)
  const exclude = (reason: "foreign_directory" | "unknown_directory") => {
    if (!result.exclusions.includes(reason)) result.exclusions.push(reason)
  }
  const cap = (reason: HistoryRankedPage["caps"][number]) => {
    result.capped = true
    if (!result.caps.includes(reason)) result.caps.push(reason)
  }
  const { where, params } = historyScopeSQL(scope)
  const { low, high } = dateBounds(input.since, input.until)
  const dates = `${low === undefined ? "" : " AND m.time_created >= ?"}${high === undefined ? "" : " AND m.time_created < ?"}`
  const scoped = [...params, ...(low === undefined ? [] : [low]), ...(high === undefined ? [] : [high])]
  const through = Number(db.prepare(`SELECT coalesce(max(m.rowid),0) AS maximum FROM session_message m
    JOIN session_v2 s ON s.id=m.session_id WHERE ${where}${dates}`).get(...scoped)?.maximum ?? 0)
  const mask = termMask(terms)
  // -1 is unknown projected text; -2 is unsupported/oversized stored content.
  // Decode JSON once using the same readable sources as the body judge. Only
  // genuine projected text, rather than tool metadata/attachments, spends the bound.
  db.function("codenomad_ranked_mask", { deterministic: true }, (data, role) => {
    try {
      if (typeof data !== "string") return -2
      let bytes = 0, present = 0
      for (const source of historyTexts(historyContent(JSON.parse(data), role), input.includeTechnical)) {
        bytes += Buffer.byteLength(source.text)
        if (bytes > RANKED_LIMITS.prefilterBytes) return -1
        present |= mask(source.text)
      }
      return present
    } catch { return -2 }
  })
  const rows = db.prepare(`SELECT m.rowid AS position,m.id,m.session_id,m.time_created,s.directory,s.workspace_id,s.title,
    CASE WHEN length(CAST(m.data AS BLOB)) <= ${MAX_MESSAGE_BYTES}
      THEN codenomad_ranked_mask(${input.includeTechnical ? "m.data" : textProjection},m.type) ELSE -2 END AS mask
    FROM session_message m JOIN session_v2 s ON s.id=m.session_id
    WHERE ${where}${dates} AND m.rowid > ? AND m.rowid <= ? ORDER BY m.rowid LIMIT ${RANKED_LIMITS.chunk}`)
  let candidates: Candidate[] = []
  const owners = new Map<string, HistoryRankedPage["sessions"][number]>()
  // Ownership has its own bounded work, independent of the body-judging deadline.
  // Run before judging, and again afterwards to fence changes during body IO.
  const validateDirectories = async () => {
    const allowed = new Set<string>()
    for (const directory of new Set(result.sessions.map(owner => owner.directory))) {
      await yieldTurn(undefined, { signal })
      const ownership = await authorize(directory, true)
      if (ownership === "owned") allowed.add(directory)
      else exclude(ownership === "limit" ? "unknown_directory" : ownership)
    }
    result.sessions = result.sessions.filter(owner => allowed.has(owner.directory))
  }
  let after = 0
  scan: while (after < through) {
    signal.throwIfAborted()
    if (performance.now() - started >= RANKED_LIMITS.scanMs) { cap("scan_time"); break }
    let visited = false
    for (const row of rows.iterate(...scoped, after, through)) {
      signal.throwIfAborted()
      visited = true
      after = Number(row.position)
      const ownership = await authorize(String(row.directory))
      if (ownership === "limit") { cap("session_limit"); break scan }
      if (ownership !== "owned") exclude(ownership)
      else {
        const sessionID = String(row.session_id)
        let owner = owners.get(sessionID)
        if (!owner) {
          if (owners.size === RANKED_LIMITS.sessions) { cap("session_limit"); break scan }
          owner = { sessionID, directory: String(row.directory), title: String(row.title ?? "").slice(0, 4096),
            ...(typeof row.workspace_id === "string" ? { workspaceID: row.workspace_id } : {}), scanned: 0, tools: 0, reasoning: 0, skipped: 0,
            candidates: 0, judged: 0, matchedMessages: 0, prefilterBypassed: 0 }
          owners.set(sessionID, owner)
          result.sessions.push(owner)
        }
        result.scanned++
        owner.scanned++
        if (Number(row.mask) === -2) { result.skipped++; owner.skipped++ }
        else {
          const unknown = Number(row.mask) === -1
          if (unknown) owner.prefilterBypassed++
          const flags = unknown ? undefined : terms.map((_, i) => Boolean(Number(row.mask) & (1 << i)))
          if (!flags || flags.some(Boolean)) {
            candidates.push({ position: after, messageID: String(row.id), sessionID: String(row.session_id), createdAt: Number(row.time_created), flags, score: 0 })
            owner.candidates++
          }
        }
      }
      if (candidates.length === RANKED_LIMITS.candidates && after < through) { cap("candidate_limit"); break scan }
      if (performance.now() - started >= RANKED_LIMITS.scanMs && after < through) { cap("scan_time"); break scan }
      if (performance.now() - sliceStarted >= HISTORY_SLICE_MS) {
        await yieldTurn(undefined, { signal }); sliceStarted = performance.now()
      }
    }
    await yieldTurn(undefined, { signal }); sliceStarted = performance.now()
    if (!visited) break
  }
  // Ownership reads have their own bound: the judge keeps the allowance left after scanning.
  const validationStarted = performance.now()
  await validateDirectories()
  const judgeStarted = started + performance.now() - validationStarted
  const beforeJudge = new Set(result.sessions.map(owner => owner.sessionID))
  candidates = candidates.filter(candidate => beforeJudge.has(candidate.sessionID))
  result.candidates = candidates.length
  const weights = idfWeights(candidates.map(candidate => candidate.flags), terms.length)
  for (const candidate of candidates) candidate.score = candidate.flags ? termScore(candidate.flags, weights) : 0
  candidates.sort((a, b) => Number(!a.flags) - Number(!b.flags) || b.score - a.score || b.createdAt - a.createdAt || a.position - b.position)
  const judge = textJudge(terms, input.query, weights)
  const body = db.prepare(`SELECT m.type,m.time_created,s.directory,s.workspace_id,s.title,
    CASE WHEN length(CAST(m.data AS BLOB)) <= ${MAX_MESSAGE_BYTES} THEN ${input.includeTechnical ? "m.data" : textProjection} END AS data
    FROM session_message m JOIN session_v2 s ON s.id=m.session_id
    WHERE ${where}${dates} AND m.rowid=? AND m.id=? AND m.session_id=?`)
  const judged: Judged[] = []
  if (candidates.length > RANKED_LIMITS.judged) cap("judge_limit")
  for (const candidate of candidates.slice(0, RANKED_LIMITS.judged)) {
    signal.throwIfAborted()
    if (performance.now() - judgeStarted >= RANKED_LIMITS.totalMs) { cap("total_time"); break }
    // Only one bounded message body is materialized; ownership is checked again
    // because other native requests may move/delete sessions between yields.
    const owner = owners.get(candidate.sessionID)!
    const row = body.get(...scoped, candidate.position, candidate.messageID, candidate.sessionID)
    result.judged++
    owner.judged++
    if (!row) continue
    if (row.directory !== owner.directory || (row.workspace_id ?? undefined) !== owner.workspaceID) continue
    try {
      if (typeof row.data !== "string") throw new Error("Oversized history message")
      const content = historyContent(JSON.parse(row.data), row.type)
      let best: (Judged & { rarity: number }) | undefined
      let matched = terms.map(() => false), phrase = false
      for (const source of historyTexts(content, input.includeTechnical)) {
        const found = judge(source.text)
        if (found.at < 0) continue
        const entry = { sessionID: candidate.sessionID, messageID: candidate.messageID, createdAt: Number(row.time_created),
          score: found.score, prose: source.kind === "text", rarity: found.rarity, unknown: !candidate.flags,
          hit: { sessionID: candidate.sessionID, messageID: candidate.messageID, role: String(row.type),
            createdAt: Number(row.time_created), partIndex: source.partIndex, kind: source.kind, excerpt: rankedExcerpt(source.text, found.at) } }
        if (best?.prose && !entry.prose) continue
        if (entry.prose && !best?.prose) { best = undefined; matched = terms.map(() => false); phrase = false }
        matched = matched.map((value, i) => value || found.matched[i])
        phrase ||= found.phrase
        if (!best || entry.rarity > best.rarity || (entry.rarity === best.rarity && compareRank(entry, best) < 0)) best = entry
      }
      if (best) {
        best.score = termScore(matched, weights) + (phrase ? weights.reduce((sum, weight) => sum + weight, 0) : 0)
        judged.push(best)
        owner.matchedMessages++
      }
    } catch { result.skipped++; owner.skipped++ }
    if (performance.now() - sliceStarted >= HISTORY_SLICE_MS) {
      await yieldTurn(undefined, { signal }); sliceStarted = performance.now()
    }
  }
  signal.throwIfAborted()
  await validateDirectories()
  // Uncached root + common-directory physical fence after the last asynchronous
  // directory check. A replacement invalidates every earlier successful check.
  if (await authorize(scope.directory, "root") !== "owned") {
    exclude("unknown_directory")
    result.sessions = []
  }
  signal.throwIfAborted()
  for (const key of ["scanned", "candidates", "judged", "skipped", "prefilterBypassed"] as const) result[key] = result.sessions.reduce((sum, owner) => sum + owner[key], 0)
  result.matchedSessions = result.sessions.filter(owner => owner.matchedMessages > 0).length
  const ownedIDs = new Set(result.sessions.map(owner => owner.sessionID))
  result.hits = diverseHits(judged.filter(entry => ownedIDs.has(entry.sessionID)), input.limit).map(entry => entry.hit)
  return result
}
