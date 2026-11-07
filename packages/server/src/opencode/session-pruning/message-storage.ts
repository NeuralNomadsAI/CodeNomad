import type { DatabaseSync } from "node:sqlite"
import { nativeAssistantContentSQL } from "./native-assistant-content"

const LIMIT = 16 * 1024 * 1024
const PARTS = 100_001
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`
const cache = new WeakMap<DatabaseSync, { version: number; table: string; split: boolean }>()

/** A bounded native read relation. Split parts precede the inline tail, as in
 * OpenCode's history.withParts. No table, index, trigger or copy is created. */
export function messageStorage(db: DatabaseSync) {
  const version = Number(db.prepare("PRAGMA schema_version").get()!.schema_version)
  let known = cache.get(db)
  if (!known || known.version !== version) {
    const found = db.prepare("SELECT type FROM sqlite_schema WHERE name='session_part'").get()
    if (!found) known = { version, table: "session_message", split: false }
    else {
      const columns = db.prepare("PRAGMA table_info(session_part)").all()
      const required = ["message_id", "session_id", "ordinal", "type", "call_id", "time_created", "time_updated", "data"]
      if (found.type !== "table" || required.some(name => !columns.some(column => column.name === name))
        || columns.some(column => required.includes(String(column.name)) && (String(column.type).toUpperCase()
          !== (["ordinal", "time_created", "time_updated"].includes(String(column.name)) ? "INTEGER" : "TEXT")
          || (column.name !== "call_id" && column.notnull !== 1)))
        || !columns.some(column => column.name === "message_id" && column.pk === 1)
        || !columns.some(column => column.name === "ordinal" && column.pk === 2)) throw new Error("Unsupported native part storage")
      const owner = "p.message_id=raw.id"
      // The LIMIT bounds metadata examination even for malformed foreign writers.
      const parts = (fields: string) => `(SELECT ${fields} FROM session_part p WHERE ${owner} ORDER BY ordinal LIMIT ${PARTS + 1})`
      const count = `(SELECT count(*) FROM ${parts("1")})`
      // octet_length reads TEXT byte counts from SQLite metadata, before loading
      // potentially oversized part payloads for JSON validation/reconstruction.
      const bytes = `(octet_length(raw.data) + (SELECT coalesce(sum(bytes),0)+count(*) FROM ${parts("octet_length(data) AS bytes")}))`
      const has = `EXISTS(SELECT 1 FROM session_part p WHERE ${owner})`
      const invalid = `EXISTS(SELECT 1 FROM ${parts("session_id,ordinal,type,call_id,data")} WHERE session_id IS NOT raw.session_id
        OR typeof(ordinal)<>'integer' OR ordinal<0 OR ordinal>9007199254740991 OR typeof(data)<>'text' OR NOT json_valid(data)
        OR CASE WHEN json_valid(data) THEN json_type(data)<>'object' OR json_extract(data,'$.type') IS NOT type
          OR CASE WHEN type='tool' THEN json_type(data,'$.id') IS NOT 'text' OR call_id IS NOT json_extract(data,'$.id')
            ELSE call_id IS NOT NULL END ELSE 1 END)`
      const merged = `json_set(raw.data,'$.content',json(${nativeAssistantContentSQL("raw.id", "raw.data")}))`
      const data = `CASE WHEN ${has} THEN CASE WHEN raw.type='assistant' AND ${count}<=${PARTS}
        AND ${bytes}<=${LIMIT} THEN CASE WHEN json_valid(raw.data) THEN CASE
          WHEN json_type(raw.data,'$.content')='array' AND NOT ${invalid} THEN ${merged} END END END ELSE raw.data END`
      const names = db.prepare("PRAGMA table_info(session_message)").all().map(column => String(column.name))
      if (names.includes("codenomad_stored_bytes")) throw new Error("Unsupported native message columns")
      const fields = names.map(name => name === "data" ? `${data} AS data`
        : name === "time_updated" ? `max(raw.time_updated,coalesce((SELECT max(time_updated) FROM ${parts("time_updated")}),raw.time_updated)) AS time_updated`
          : `raw.${quote(name)}`)
      known = { version, split: true, table: `(SELECT raw.rowid AS rowid,${fields.join(",")},
        CASE WHEN ${has} THEN ${bytes} ELSE octet_length(raw.data) END AS codenomad_stored_bytes
        FROM session_message raw)` }
    }
    cache.set(db, known)
  }
  return { table: known.table, bytes: (alias = "") => known!.split
    ? `${alias ? `${alias}.` : ""}codenomad_stored_bytes` : `length(CAST(${alias ? `${alias}.` : ""}data AS BLOB))` }
}

/** Retained part ordinals stay unchanged. Native reads use ordinal order, not
 * contiguous numbering. Caller owns BEGIN IMMEDIATE and the completed-row fence. */
export function pruneSplitParts(db: DatabaseSync, sessionID: string, messageID: string, indexes: ReadonlySet<number>): number {
  if (!db.isTransaction) throw new Error("Part pruning requires a write transaction")
  messageStorage(db)
  if (!cache.get(db)!.split) return 0
  const rows = db.prepare("SELECT ordinal FROM session_part WHERE message_id=? AND session_id=? ORDER BY ordinal LIMIT ?")
    .all(messageID, sessionID, PARTS + 1)
  if (rows.length > PARTS) throw new Error("Native part count exceeds limit")
  const remove = db.prepare("DELETE FROM session_part WHERE message_id=? AND session_id=? AND ordinal=?")
  rows.forEach((row, index) => {
    if (indexes.has(index) && remove.run(messageID, sessionID, row.ordinal).changes !== 1) throw new Error("Native part changed")
  })
  return rows.length
}
