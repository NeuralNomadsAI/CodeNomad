// A disposable index in the same SQLite database as the source, maintained
// atomically by SQLite even for older storage clients and other connections.
// No event is copied, migrated or removed. One head per changed mission range.
const table = "codenomad_mission_head_v1"
const definitions = (root: string) => {
  const projectSeparator = root.length + 24 + 1
  const missionSeparator = (key: string) => `instr(substr(${key},${projectSeparator + 1}),'/')`
  const range = (key: string) => `substr(${key},1,${missionSeparator(key)}+${projectSeparator})`
  const accepts = (key: string) => `substr(${key},1,${root.length})='${root}' AND substr(${key},${projectSeparator},1)='/' AND ${missionSeparator(key)}>0`
  const track = (key: string, where = "") => `INSERT INTO ${table}(range,stamp,prior,tail)
    SELECT ${range(key)},randomblob(24),NULL,${key} ${where ? `WHERE ${where}` : ""}
    ON CONFLICT(range) DO UPDATE SET prior=${table}.stamp,stamp=excluded.stamp,tail=excluded.tail;`
  // Record BEFORE INSERT while the old key is still visible (REPLACE can
  // omit its DELETE trigger). An ignored insert can cause an extra miss.
  const invalidate = (key: string, where = "") => `INSERT INTO ${table}(range,stamp,prior,tail)
    SELECT ${range(key)},randomblob(24),NULL,NULL WHERE ${where || "1"}
    ON CONFLICT(range) DO UPDATE SET prior=NULL,stamp=excluded.stamp,tail=NULL;`
  return [
    `CREATE TABLE ${table}(range TEXT PRIMARY KEY,stamp BLOB NOT NULL,prior BLOB,tail TEXT,schema_cookie INTEGER) WITHOUT ROWID`,
    `CREATE TRIGGER ${table}_insert BEFORE INSERT ON kv WHEN ${accepts("NEW.key")} BEGIN
      ${track("NEW.key", "NOT EXISTS(SELECT 1 FROM kv WHERE key=NEW.key)")}
      ${invalidate("NEW.key", "EXISTS(SELECT 1 FROM kv WHERE key=NEW.key)")} END`,
    `CREATE TRIGGER ${table}_update AFTER UPDATE ON kv WHEN ${accepts("OLD.key")} OR ${accepts("NEW.key")} BEGIN
      ${invalidate("OLD.key", accepts("OLD.key"))}
      ${invalidate("NEW.key", `OLD.key<>NEW.key AND ${accepts("NEW.key")}`)} END`,
    `CREATE TRIGGER ${table}_delete AFTER DELETE ON kv WHEN ${accepts("OLD.key")} BEGIN ${invalidate("OLD.key")} END`,
  ]
}

export function journalHeadSQL(root: string) {
  const schema = definitions(root)
  // sqlite_schema stores the CREATE statement verbatim (apart from the initial
  // keyword normalizations, already canonical here).
  return {
    schema, names: [table, `${table}_insert`, `${table}_update`, `${table}_delete`],
    cookie: "PRAGMA main.schema_version",
    read: `SELECT hex(e.stamp) AS epoch,hex(h.stamp) AS stamp,hex(h.prior) AS prior,h.tail
      FROM main.${table} e CROSS JOIN main.pragma_schema_version AS v
      LEFT JOIN main.${table} h ON h.range=? WHERE e.range=? AND e.schema_cookie=v.schema_version AND v.schema_version=?`,
    epoch: `${root}index-incarnation`,
    displayRead: `SELECT CAST(stamp AS TEXT) AS checksum,tail AS value FROM main.${table}
      WHERE range=? AND CAST(prior AS TEXT)=? AND length(CAST(tail AS BLOB))<=?`,
    displayWrite: `INSERT INTO main.${table}(range,stamp,prior,tail) VALUES(?,CAST(? AS BLOB),CAST(? AS BLOB),?)
      ON CONFLICT(range) DO UPDATE SET stamp=excluded.stamp,prior=excluded.prior,tail=excluded.tail`,
    // Exact triggers may have been absent between schema cookies. Rotate the
    // singleton for every range, without scanning or trusting any old stamp.
    renew: `INSERT INTO main.${table}(range,stamp,schema_cookie) VALUES (?,randomblob(24),?)
      ON CONFLICT(range) DO UPDATE SET stamp=excluded.stamp,schema_cookie=excluded.schema_cookie`,
  }
}
