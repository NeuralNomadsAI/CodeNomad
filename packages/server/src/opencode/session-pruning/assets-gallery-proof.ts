import { createHash } from "node:crypto"
import path from "node:path"
import type { DatabaseSync, SQLInputValue } from "node:sqlite"
import { MESSAGE_LIMIT } from "./assets-store"

// Generation annotations of the image gallery, proven from the transcript alone
// (dev-docs/SESSION_PRUNING_RPC.md#image-gallery): no file access, no `kv`, no cache.
export const LOOKBACK_MESSAGES = 32
export const LOOKBACK_BYTES = 32 * 1024 * 1024
export const NOTICE_CAP = 4096
export const NOTICE_ROW_LIMIT = 64 * 1024
const PROMPT_BYTES = 8192
const IMAGE_MIME = /^image\/(png|jpeg|gif|webp|avif)$/

export type Part = Record<string, any>
type Span = { start: number; end: number }
type Call = { seq: number; part: Part }
type Notice = { seq: number; time: number; job: string; state: unknown; file?: string }
export interface Coverage {
  floor: number
  floorFor(seq: number): number
  calls: Call[]
  notices: Notice[]
  undecoded: Array<{ seq: number; time: number }>
  capped: boolean
}

export const key = (...values: string[]) => createHash("sha256").update(values.join("\u0000")).digest("base64url").slice(0, 22)
/** Gallery membership: a `read` tool part and an image file. */
export const isGalleryFile = (tool: Part | undefined, file: Part | undefined) => tool?.type === "tool" && tool.name === "read"
  && file?.type === "file" && typeof file.uri === "string" && IMAGE_MIME.test(file.mime ?? "")
export const visible = (boundary: string | undefined) => boundary ? " AND id < ?" : ""
export const after = (boundary: string | undefined): SQLInputValue[] => boundary ? [boundary] : []

// Daemon path style: names resolve lexically, Windows paths compare without case.
const P = process.platform === "win32" ? path.win32 : path.posix
const norm = (value: string) => process.platform === "win32" ? P.normalize(value).toLowerCase() : P.normalize(value)
const stemOf = (file: string) => norm(file.slice(0, file.length - P.extname(file).length))
export function resolveName(directory: string, name: unknown) {
  if (typeof name !== "string" || !name) return undefined
  return P.isAbsolute(name) ? P.normalize(name) : P.resolve(directory, name)
}
export function relativeInside(directory: string, file: string | undefined) {
  if (!file) return undefined
  const relative = P.relative(directory, file)
  return relative && relative !== ".." && !relative.startsWith(`..${P.sep}`) && !P.isAbsolute(relative) ? relative : undefined
}
export const labelOf = (file: string) => P.basename(file, P.extname(file)).slice(0, 128)
/** A tool part's execution interval; missing or inconsistent times give none. */
export function interval(part: Part | undefined): Span | undefined {
  const start = part?.time?.ran, end = part?.time?.completed
  return Number.isFinite(start) && Number.isFinite(end) && start <= end ? { start, end } : undefined
}
/** The file stem a completed `image_generate` part names in `metadata.path`; any other call may write any file. */
const knownStem = (part: Part) => part.state?.status === "completed" && typeof part.state.metadata?.path === "string"
  ? norm(part.state.metadata.path) : undefined
/** Whether an `image_generate` part may write `file`. */
export const writes = (part: Part, file: string) => { const stem = knownStem(part); return stem === undefined || stem === stemOf(file) }
/** Whether an `image_generate` part may write a file other than the one its `metadata.path` names. */
export const writesAnyFile = (part: Part) => knownStem(part) === undefined
export const sameFile = (a: string | undefined, b: string) => a !== undefined && norm(a) === norm(b)

/** `input.prompt` up to 8 KiB of UTF-8 and `metadata.model`, for callers granted prompts. */
export function promptFields(part: Part) {
  const fields: { prompt?: string; promptTruncated?: true; model?: string } = {}
  const prompt = part.state?.input?.prompt, model = part.state?.metadata?.model
  if (typeof prompt === "string") {
    const bytes = Buffer.from(prompt)
    if (bytes.length <= PROMPT_BYTES) fields.prompt = prompt
    else {
      let end = PROMPT_BYTES
      while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--
      fields.prompt = bytes.subarray(0, end).toString()
      fields.promptTruncated = true
    }
  }
  if (typeof model === "string") fields.model = model.slice(0, 256)
  return fields
}

/**
 * Proof coverage below `top`: the window rows the caller already loaded, then up to
 * 32 older assistant rows within 32 MiB, each size-checked before its JSON loads; an
 * oversized row or the budget stops the scan. Then one notice scan from the lowest
 * covered `seq` to `through`, decoded by SQLite only for rows of at most 64 KiB.
 */
export function coverage(db: DatabaseSync, sessionID: string, boundary: string | undefined, top: number, through: number,
  preloaded: Map<string, any>, windowRows: number): Coverage {
  const rows = db.prepare(`SELECT id,seq,length(CAST(data AS BLOB)) AS bytes FROM session_message WHERE session_id=? AND type='assistant'
    AND seq<=?${visible(boundary)} ORDER BY seq DESC LIMIT ?`).all(sessionID, top, ...after(boundary), windowRows + LOOKBACK_MESSAGES)
  const read = db.prepare("SELECT data FROM session_message WHERE session_id=? AND id=?")
  const calls: Call[] = [], scanned: Array<{ seq: number; bytes: number }> = []
  let budget = 0, stopped = false
  for (const row of rows) {
    const seq = Number(row.seq), bytes = Number(row.bytes)
    let data = preloaded.get(String(row.id))
    if (data === undefined) {
      if (bytes > MESSAGE_LIMIT || budget + bytes > LOOKBACK_BYTES) { stopped = true; break }
      budget += bytes
      data = JSON.parse(String(read.get(sessionID, row.id)?.data))
    }
    scanned.push({ seq, bytes })
    for (const part of Array.isArray(data?.content) ? data.content : []) {
      if (part?.type === "tool" && part.name === "image_generate") calls.push({ seq, part })
    }
  }
  const reachedStart = !stopped && rows.length < windowRows + LOOKBACK_MESSAGES
  const floor = reachedStart ? 0 : scanned.at(-1)?.seq ?? Infinity
  // An item's range: its own message and the 31 assistant messages before it, within 32 MiB.
  // A range the stopped scan cut short gives no floor: nothing below the stop is known.
  const floorFor = (seq: number) => {
    const start = scanned.findIndex(row => row.seq === seq)
    if (start < 0) return Infinity
    let bytes = 0, last = seq
    for (let index = start; index < start + LOOKBACK_MESSAGES; index++) {
      if (index === scanned.length) return reachedStart ? 0 : Infinity
      if (bytes + scanned[index].bytes > LOOKBACK_BYTES) return last
      bytes += scanned[index].bytes; last = scanned[index].seq
    }
    return last
  }
  const decoded = (field: string) => `CASE WHEN ok THEN json_extract(data,'${field}') END`
  const synthetic = db.prepare(`SELECT seq,time_created AS time,ok,${decoded("$.metadata.source")} AS source,${decoded("$.metadata.jobID")} AS job,
      ${decoded("$.metadata.state")} AS state,${decoded("$.metadata.path")} AS stem,CASE WHEN ok THEN substr(json_extract(data,'$.text'),1,4096) END AS text
    FROM (SELECT seq,time_created,data,CASE WHEN length(CAST(data AS BLOB))<=? THEN json_valid(data) ELSE 0 END AS ok
      FROM session_message WHERE session_id=? AND type='synthetic' AND seq>=? AND seq<=?${visible(boundary)} ORDER BY seq ASC LIMIT ?)`)
    .all(NOTICE_ROW_LIMIT, sessionID, floor === Infinity ? Number.MAX_SAFE_INTEGER : floor, through, ...after(boundary), NOTICE_CAP + 1)
  const capped = synthetic.length > NOTICE_CAP, kept = synthetic.slice(0, NOTICE_CAP)
  const undecoded = kept.filter(row => !row.ok).map(row => ({ seq: Number(row.seq), time: Number(row.time) }))
  const notices = kept.filter(row => row.ok && row.source === "image_generate" && typeof row.job === "string").map(row => {
    const named = /Saved image: (.+) \(/.exec(typeof row.text === "string" ? row.text : "")?.[1]
    const file = row.state === "completed" && named && P.isAbsolute(named) && typeof row.stem === "string" && stemOf(named) === norm(row.stem)
      ? P.normalize(named) : undefined
    return { seq: Number(row.seq), time: Number(row.time), job: row.job as string, state: row.state, file }
  })
  return { floor, floorFor, calls, notices, undecoded, capped }
}

/** The single write of `file` provably finished before `span.start`, with no other possible write until `span.end`. */
function proveWriter(cov: Coverage, file: string, span: Span | undefined, uptoSeq: number, floor: number) {
  if (!span || !(floor <= uptoSeq) || cov.capped) return undefined
  // Any undecodable notice row of the coverage that may precede the end of the interval is relevant, whatever its seq.
  if (cov.undecoded.some(row => row.seq >= floor && !(row.time > span.end))) return undefined
  // Every call that may write this file started before the interval ended, or at an unknown time, is a possible writer.
  const writers = cov.calls.filter(call => call.seq >= floor && call.seq <= uptoSeq && writes(call.part, file)
    && !(Number(call.part.time?.ran) > span.end))
  if (writers.length !== 1) return undefined
  const writer = writers[0], job = writer.part.state?.metadata?.jobID, ran = writer.part.time?.ran
  if (writer.part.state?.status !== "completed" || typeof job !== "string" || !Number.isFinite(ran) || !(ran < span.start)) return undefined
  const own = cov.notices.filter(notice => notice.job === job)
  if (own.length !== 1 || own[0].state !== "completed" || !sameFile(own[0].file, file)) return undefined
  if (!(own[0].time < span.start) || !(ran < own[0].time)) return undefined
  // Another delivered write of the same file between ours and the end of the interval; ties count as overlap.
  if (cov.notices.some(notice => notice.job !== job && sameFile(notice.file, file) && !(notice.time < own[0].time) && !(notice.time > span.end))) return undefined
  return { ...writer, job }
}

export type Annotation = { origin: "unverifiable" }
  | { origin: "proven"; generationKey: string; parentKeys: string[]; otherRefs: number; call: Part }
/** §10.5: a read image's generation, its parents proven by the same rule over the generation's own interval. */
export function annotate(cov: Coverage, directory: string, sessionID: string, seq: number, tool: Part, file: string | undefined): Annotation {
  const floor = cov.floorFor(seq)
  const proof = file && proveWriter(cov, file, interval(tool), seq, floor)
  if (!proof) return { origin: "unverifiable" }
  const parentKeys: string[] = [], input = proof.part.state?.input
  let otherRefs = 0
  for (const ref of Array.isArray(input?.images) ? input.images : []) {
    const parent = typeof ref === "string" && !/^(https?|data):/i.test(ref) ? resolveName(directory, ref) : undefined
    const writer = parent && proveWriter(cov, parent, interval(proof.part), proof.seq, floor)
    if (writer) parentKeys.push(key(sessionID, writer.job)); else otherRefs++
  }
  return { origin: "proven", generationKey: key(sessionID, proof.job), parentKeys, otherRefs, call: proof.part }
}

/** §10.6: the native tool state, and the outcome of its unique decoded notice inside the coverage. */
export function generationState(cov: Coverage, part: Part) {
  const status = part.state?.status
  const tool = ["streaming", "running", "completed", "error"].includes(status) ? status as "streaming" | "running" | "completed" | "error" : "unknown"
  if (tool !== "completed") return { tool, outcome: "none" } as const
  const job = part.state?.metadata?.jobID
  if (typeof job !== "string") return { tool: "unknown", outcome: "none" } as const
  const own = cov.notices.filter(notice => notice.job === job), ran = part.time?.ran
  // An undecodable row created at or after the call started may be another notice of this job.
  const hidden = !Number.isFinite(ran) || cov.undecoded.some(row => !(row.time < ran))
  const outcome = !cov.capped && !hidden && own.length === 1 && ["completed", "error", "cancelled"].includes(own[0].state as string)
    ? own[0].state as "completed" | "error" | "cancelled" : "unknown"
  return { tool, outcome, job, notice: outcome === "unknown" ? undefined : own[0] } as const
}
