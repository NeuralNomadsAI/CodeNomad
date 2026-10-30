import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import { DatabaseSync, type StatementSync } from "node:sqlite"
import { storageDirectory } from "./storage-path"
import { listGalleryImages, readGalleryImage, galleryImageReference } from "./assets-gallery"
import type { GalleryEntry } from "./assets-gallery-contract"
import type { AssetTarget } from "./assets-contract"

// Test copies of two OpenCode 2.2.1 Images transcripts, with and without `experimental.media_blob`.
// Paths are stored under `<ROOT>` with `/` separators and rewritten to the platform's daemon style.
const P = process.platform === "win32" ? path.win32 : path.posix
export const ROOT = process.platform === "win32" ? "C:\\cn-gallery-fixture" : "/cn-gallery-fixture"
export const DIRECTORY = P.join(ROOT, "p")
const source = JSON.parse(readFileSync(new URL("./assets-gallery-fixture.json", import.meta.url), "utf8"))
const native = (value: any): any => typeof value === "string" ? value.replace(/<ROOT>([^\s"()]*)/g, (_, rest: string) => P.join(ROOT, ...rest.split("/").filter(Boolean)))
  : Array.isArray(value) ? value.map(native) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, native(v)])) : value
export const sha = (value: string) => createHash("sha256").update(value).digest("hex")
export const galleryKey = (...values: string[]) => createHash("sha256").update(values.join("\u0000")).digest("base64url").slice(0, 22)
export const A_CALL = 5, A_NOTICE = 13, A_READ = 14, A2_CALL = 48
export const signal = () => new AbortController().signal

export type Fixture = ReturnType<typeof openFixture>
/** A writable in-memory copy, with an instrumented connection recording every message JSON it loads. */
export function openFixture(kind: "plain" | "blob") {
  const data = source[kind], session = native(data.session)
  const raw = new DatabaseSync(":memory:")
  raw.exec(`CREATE TABLE session_v2(id TEXT PRIMARY KEY,project_id TEXT,workspace_id TEXT,parent_id TEXT,directory TEXT,title TEXT,metadata TEXT,
      revert TEXT,agent TEXT,time_created INTEGER,time_updated INTEGER,time_archived INTEGER);
    CREATE TABLE session_message(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,type TEXT NOT NULL,seq INTEGER NOT NULL,time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,data TEXT NOT NULL);
    CREATE TABLE blob(hash TEXT PRIMARY KEY,mime TEXT,data BLOB);
    CREATE TABLE blob_ref(session_id TEXT,message_id TEXT,hash TEXT);`)
  raw.prepare("INSERT INTO session_v2 VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(session.id, session.project_id, session.workspace_id, session.parent_id,
    storageDirectory(session.directory), session.title, session.metadata, session.revert, session.agent, session.time_created, session.time_updated, session.time_archived)
  const add = raw.prepare("INSERT INTO session_message VALUES (?,?,?,?,?,?,?)")
  for (const [id, type, seq, created, updated, json] of data.messages) add.run(id, session.id, type, seq, created, updated, JSON.stringify(native(json)))
  for (const [hash, mime, base64] of data.blobs) raw.prepare("INSERT INTO blob VALUES (?,?,?)").run(hash, mime, Buffer.from(base64, "base64"))
  for (const [sessionID, messageID, hash] of data.refs) raw.prepare("INSERT INTO blob_ref VALUES (?,?,?)").run(sessionID, messageID, hash)
  const loads: Array<{ args: unknown[]; bytes: number }> = []
  const record = (args: unknown[], row: any) => { if (typeof row?.data === "string") loads.push({ args, bytes: row.data.length }) }
  const statement = (inner: StatementSync) => new Proxy(inner, { get(target, name) {
    const value = Reflect.get(target, name, target)
    if (name === "get") return (...args: any[]) => { const row = target.get(...args); record(args, row); return row }
    if (name === "all") return (...args: any[]) => { const rows = target.all(...args); for (const row of rows) record(args, row); return rows }
    return typeof value === "function" ? value.bind(target) : value
  } })
  const db = new Proxy(raw, { get(target, name) {
    if (name === "prepare") return (sql: string) => statement(target.prepare(sql))
    const value = Reflect.get(target, name, target)
    return typeof value === "function" ? value.bind(target) : value
  } }) as DatabaseSync
  const sessionID: string = session.id
  const scope = { sessionID, directory: DIRECTORY, projectID: session.project_id as string }
  const row = (seq: number) => raw.prepare("SELECT id,data,time_created FROM session_message WHERE session_id=? AND seq=?").get(sessionID, seq) as { id: string; data: string; time_created: number }
  const json = (seq: number) => JSON.parse(row(seq).data)
  const insert = (id: string, type: string, seq: number, time: number, value: unknown) =>
    raw.prepare("INSERT INTO session_message VALUES (?,?,?,?,?,?,?)").run(id, sessionID, type, seq, time, time, JSON.stringify(value))
  const update = (id: string, value: unknown) => raw.prepare("UPDATE session_message SET data=? WHERE id=?").run(JSON.stringify(value), id)
  const readPart = (value: any) => value.content.findIndex((part: any) => part.name === "read")
  const fileOf = (value: any) => value.content[readPart(value)].state.content[1]
  const readTarget = (seq = A_READ): AssetTarget => { const value = json(seq); return { messageID: row(seq).id, part: readPart(value), index: 1, digest: sha(fileOf(value).uri) } }
  const call = (seq = A_CALL) => json(seq).content.find((part: any) => part.name === "image_generate")
  /** A copy of icon-a's notice for another job, optionally padded past the 64 KiB decode limit. */
  const noticeFor = (seq: number, job: string, time: number, padding = 0) => {
    const notice = json(A_NOTICE); notice.metadata.jobID = job
    if (padding) notice.text += "x".repeat(padding)
    insert(`msg_zz_${job}`, "synthetic", seq, time, notice)
  }
  const fillers = (count: number, from = 200) => {
    for (let n = 0; n < count; n++) insert(`msg_zz_fill_${String(n).padStart(3, "0")}`, "assistant", from + n, Date.now(), { ...json(A_READ), content: [{ type: "text", text: `filler ${n}` }] })
  }
  /** A later message re-reading icon-a's file (optionally renamed). */
  const reread = (id: string, seq: number, rename?: string) => {
    const value = json(A_READ), part = structuredClone(value.content[readPart(value)]), when = Date.now()
    part.id = `call_${id}`; part.time = { created: when, ran: when, completed: when + 1 }
    if (rename) part.state.content[1].name = part.state.content[1].name.replace("icon-a.png", rename)
    insert(id, "assistant", seq, when, { ...value, content: [part] })
    return part
  }
  async function walk(prompts = false, window = 32) {
    const all: GalleryEntry[] = []
    let cursor: string | undefined, pages = 0
    do {
      const page = await listGalleryImages(db, scope, cursor, prompts, signal(), window)
      if (page.status !== "page") throw new Error(`gallery ${page.reason}`)
      all.push(...page.entries); cursor = page.cursor ?? undefined; pages++
    } while (cursor)
    return { all, pages }
  }
  const read = (target: AssetTarget) => readGalleryImage(db, scope, target, signal())
  const reference = (target: Parameters<typeof galleryImageReference>[2]) => galleryImageReference(db, scope, target, signal())
  /** One line per entry, as the prototype logs them. */
  async function lines(prompts = false, window = 32) {
    const { all } = await walk(prompts, window)
    return Promise.all(all.map(async entry => entry.kind === "image"
      ? `IMG ${entry.label ?? "∅"} origin:${entry.origin} parents:${entry.parentKeys?.length ?? 0} other:${entry.otherRefs ?? 0} read:${(await read(entry.target)).status}`
      : `GEN tool:${entry.tool} outcome:${entry.outcome}`))
  }
  return { db, raw, loads, sessionID, scope, row, json, insert, update, readPart, fileOf, readTarget, call, noticeFor, fillers, reread, walk, read, reference, lines,
    close: () => raw.close() }
}
export const image = (lines: string[], label: string) => lines.filter(line => line.startsWith(`IMG ${label} `))
export const has = (line: string | undefined, ...parts: string[]) => !!line && parts.every(part => line.includes(part))
/** A PNG whose IHDR claims `width` x `height`. */
export function pngUri(width: number, height: number) {
  const bytes = Buffer.alloc(64)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes, 0); bytes.writeUInt32BE(13, 8); bytes.write("IHDR", 12, "latin1")
  bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20)
  return `data:image/png;base64,${bytes.toString("base64")}`
}
