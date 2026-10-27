import type { DatabaseSync } from "node:sqlite"
import { setImmediate as yieldTurn } from "node:timers/promises"
import type { HistoryScope } from "./history-store"
import { historyContent, historyScopeSQL, historyTexts, HISTORY_SLICE_MS, MAX_MESSAGE_BYTES, textProjection } from "./history-content"
import { compareRank, dateBounds, diverseHits, idfWeights, rankedExcerpt, searchTerms, termPrefilterSQL, termScore, textJudge, type Rank } from "./history-ranking"
import type { HistoryRankedInput, HistoryRankedPage } from "./history-ranked-contract"

export const RANKED_LIMITS = { chunk: 1000, candidates: 30_000, sessions: 600, judged: 600, scanMs: 1500, totalMs: 2000 } as const
interface Candidate { position: number; messageID: string; sessionID: string; createdAt: number; flags: boolean[]; score: number }
type Judged = Rank & { hit: HistoryRankedPage["hits"][number] }

export async function queryRankedHistory(db: DatabaseSync, scope: HistoryScope, input: HistoryRankedInput, signal: AbortSignal): Promise<HistoryRankedPage> {
  signal.throwIfAborted()
  const started = performance.now()
  let sliceStarted = started
  const terms = searchTerms(input.query)
  const result: HistoryRankedPage = { version: 1, status: "ranked", scanned: 0, candidates: 0, judged: 0, skipped: 0,
    matchedSessions: 0, capped: false, caps: [], hits: [], sessions: [] }
  if (!terms.length) return result
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
  const filters = terms.map(termPrefilterSQL)
  const flagsSQL = filters.map((filter, i) => `CASE WHEN length(CAST(m.data AS BLOB)) <= ${MAX_MESSAGE_BYTES} THEN ${filter.sql} ELSE 0 END AS t${i}`).join(",")
  const rows = db.prepare(`SELECT m.rowid AS position,m.id,m.session_id,m.time_created,s.directory,s.workspace_id,s.title,${flagsSQL},
    CASE WHEN length(CAST(m.data AS BLOB)) <= ${MAX_MESSAGE_BYTES} AND json_valid(m.data) THEN
      CASE WHEN json_type(m.data)='object' AND (m.type!='assistant' OR json_type(m.data,'$.content')='array') THEN 1 ELSE 0 END
    ELSE 0 END AS supported
    FROM session_message m JOIN session_v2 s ON s.id=m.session_id
    WHERE ${where}${dates} AND m.rowid > ? AND m.rowid <= ? ORDER BY m.rowid LIMIT ${RANKED_LIMITS.chunk}`)
  const candidates: Candidate[] = []
  const owners = new Map<string, HistoryRankedPage["sessions"][number]>()
  let after = 0
  scan: while (after < through) {
    signal.throwIfAborted()
    if (performance.now() - started >= RANKED_LIMITS.scanMs) { cap("scan_time"); break }
    let visited = false
    for (const row of rows.iterate(...filters.flatMap(filter => filter.params), ...scoped, after, through)) {
      signal.throwIfAborted()
      const sessionID = String(row.session_id)
      let owner = owners.get(sessionID)
      if (!owner) {
        if (owners.size === RANKED_LIMITS.sessions) { cap("session_limit"); break scan }
        owner = { sessionID, directory: String(row.directory), title: String(row.title ?? "").slice(0, 4096),
          ...(typeof row.workspace_id === "string" ? { workspaceID: row.workspace_id } : {}), scanned: 0, tools: 0, reasoning: 0, skipped: 0,
          candidates: 0, judged: 0, matchedMessages: 0 }
        owners.set(sessionID, owner)
        result.sessions.push(owner)
      }
      visited = true
      after = Number(row.position)
      result.scanned++
      owner.scanned++
      if (!row.supported) { result.skipped++; owner.skipped++ }
      else {
        const flags = terms.map((_, i) => Boolean(row[`t${i}`]))
        if (flags.some(Boolean)) {
          candidates.push({ position: after, messageID: String(row.id), sessionID: String(row.session_id), createdAt: Number(row.time_created), flags, score: 0 })
          owner.candidates++
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
  result.candidates = candidates.length
  const weights = idfWeights(candidates.map(candidate => candidate.flags), terms.length)
  for (const candidate of candidates) candidate.score = termScore(candidate.flags, weights)
  candidates.sort((a, b) => b.score - a.score || b.createdAt - a.createdAt || a.position - b.position)
  const judge = textJudge(terms, input.query, weights)
  const body = db.prepare(`SELECT m.type,m.time_created,s.directory,s.workspace_id,s.title,
    CASE WHEN length(CAST(m.data AS BLOB)) <= ${MAX_MESSAGE_BYTES} THEN ${input.includeTechnical ? "m.data" : textProjection} END AS data
    FROM session_message m JOIN session_v2 s ON s.id=m.session_id
    WHERE ${where}${dates} AND m.rowid=? AND m.id=? AND m.session_id=?`)
  const judged: Judged[] = []
  if (candidates.length > RANKED_LIMITS.judged) cap("judge_limit")
  for (const candidate of candidates.slice(0, RANKED_LIMITS.judged)) {
    signal.throwIfAborted()
    if (performance.now() - started >= RANKED_LIMITS.totalMs) { cap("total_time"); break }
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
          score: found.score, prose: source.kind === "text", rarity: found.rarity,
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
  result.matchedSessions = result.sessions.filter(owner => owner.matchedMessages > 0).length
  result.hits = diverseHits(judged, input.limit).map(entry => entry.hit)
  return result
}
