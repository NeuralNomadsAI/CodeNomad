import { spawnSync } from "child_process"

export interface SchemaColumn {
  cid: number
  name: string
  type: string
  notnull: boolean
  dflt_value: string | null
  pk: boolean
}

/**
 * Check if the OpenCode database needs migration for the `session_message.seq` column.
 *
 * Issue #31204: `NOT NULL constraint failed: session_message.seq` because the column
 * lacks `DEFAULT 0`. OpenCode v1.16.2+ creates the schema with `DEFAULT 0`, but
 * databases created by older versions may have the column with no default or be
 * missing the column entirely.
 *
 * The function is intentionally non-blocking — if anything fails (binary not found,
 * DB not accessible) it returns `false` gracefully.
 *
 * @param binaryPath  Path to the OpenCode binary (used to locate the database)
 * @returns `true` if a schema change was applied, `false` if nothing was needed
 *          or the migration could not be performed.
 */
export function checkAndFixOpencodeSchema(binaryPath: string): boolean {
  // ── Step 1: locate the database path ──────────────────────────────
  const pathResult = spawnSync(binaryPath, ["db", "path"], {
    encoding: "utf8",
    timeout: 10000,
  })
  if (pathResult.status !== 0 || !pathResult.stdout.trim()) {
    // Binary may not support `db path` or there is no database yet.
    return false
  }
  const dbPath = pathResult.stdout.trim()

  // ── Step 2: inspect session_message table schema ──────────────────
  const schemaResult = spawnSync(
    binaryPath,
    ["db", "PRAGMA table_info(session_message);", "--format", "json"],
    { encoding: "utf8", timeout: 10000 },
  )
  if (schemaResult.status !== 0) {
    return false // table may not exist yet
  }

  let columns: SchemaColumn[]
  try {
    columns = JSON.parse(schemaResult.stdout) as SchemaColumn[]
  } catch {
    return false // unparseable output – skip
  }

  const seqColumn = columns.find((c) => c.name === "seq")

  // ── Case A: column is missing entirely → simple ALTER TABLE ──────
  if (!seqColumn) {
    const addResult = spawnSync(
      binaryPath,
      ["db", "ALTER TABLE session_message ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;"],
      { encoding: "utf8", timeout: 10000 },
    )
    return addResult.status === 0
  }

  // ── Case B: column exists but has no default → recreate table ──
  // SQLite does not support ALTER COLUMN, so we must use the table
  // recreation pattern (CREATE … INSERT … DROP … RENAME).
  if (seqColumn.dflt_value !== "0") {
    return fixSeqColumnMissingDefault(binaryPath)
  }

  // ── Column already has DEFAULT 0 – nothing to do ────────────────
  return false
}

/**
 * Perform a full table recreation for `session_message` when the `seq`
 * column exists but lacks `DEFAULT 0`.
 *
 * Uses the `opencode db` command (instead of the `sqlite3` CLI directly)
 * so the migration works even when `sqlite3` is not in PATH.
 */
function fixSeqColumnMissingDefault(binaryPath: string): boolean {
  const sql = [
    "PRAGMA foreign_keys=off;",
    "BEGIN TRANSACTION;",
    "CREATE TABLE session_message_v2 (",
    "id TEXT NOT NULL,",
    "session_id TEXT NOT NULL,",
    "type TEXT NOT NULL,",
    "time_created INTEGER NOT NULL,",
    "time_updated INTEGER NOT NULL,",
    "data TEXT NOT NULL,",
    "seq INTEGER NOT NULL DEFAULT 0,",
    "PRIMARY KEY (id)",
    ");",
    "INSERT INTO session_message_v2",
    "(id, session_id, type, time_created, time_updated, data, seq)",
    "SELECT",
    "id, session_id, type, time_created, time_updated, data,",
    "COALESCE(seq, 0)",
    "FROM session_message;",
    "DROP TABLE session_message;",
    "ALTER TABLE session_message_v2 RENAME TO session_message;",
    "COMMIT;",
    "PRAGMA foreign_keys=on;",
  ].join(" ")

  const result = spawnSync(binaryPath, ["db", sql], {
    encoding: "utf8",
    timeout: 30000,
  })

  return result.status === 0
}
