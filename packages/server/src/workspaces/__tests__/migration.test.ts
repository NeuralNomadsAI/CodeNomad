import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { execSync } from "child_process"

describe("checkAndFixOpencodeSchema", () => {
  const opencodeBinary = process.platform === "win32" ? "opencode.cmd" : "opencode"

  it("detects the OpenCode database path exists", () => {
    const dbPath = execSync(`"${opencodeBinary}" db path`, { encoding: "utf8" }).trim()
    assert.ok(dbPath.length > 0, "Database path should not be empty")
    assert.ok(dbPath.endsWith("opencode.db"), `Path should end with opencode.db, got: ${dbPath}`)
  })

  it("detects session_message table schema via PRAGMA", () => {
    const output = execSync(`"${opencodeBinary}" db "PRAGMA table_info(session_message);" --format json`, {
      encoding: "utf8",
    }).trim()
    const columns = JSON.parse(output)
    const seq = columns.find((c: any) => c.name === "seq")

    assert.ok(seq, "seq column should exist")
    assert.equal(seq.type, "INTEGER", "seq column type should be INTEGER")
    assert.equal(seq.notnull, 1, "seq column should be NOT NULL")
    assert.equal(seq.dflt_value, "0", "seq column should have DEFAULT 0")
  })

  it("correctly identifies that migration is NOT needed (returns false = no-op)", async () => {
    // The function returns false when schema is already correct (no migration needed)
    // true = migration was applied, false = nothing needed or failure
    const { checkAndFixOpencodeSchema } = await import("../migration.js")
    const result = checkAndFixOpencodeSchema(opencodeBinary)
    assert.equal(result, false, "Should return false when schema is already correct (nothing to migrate)")

    // Verify the database is unchanged by re-checking
    const output = execSync(`"${opencodeBinary}" db "PRAGMA table_info(session_message);" --format json`, {
      encoding: "utf8",
    }).trim()
    const columns = JSON.parse(output)
    const seq = columns.find((c: any) => c.name === "seq")
    assert.equal(seq.notnull, 1)
    assert.equal(seq.dflt_value, "0")
  })

  it("gracefully handles non-existent binary (returns false)", async () => {
    const { checkAndFixOpencodeSchema } = await import("../migration.js")
    const result = checkAndFixOpencodeSchema("nonexistent-binary-that-definitely-does-not-exist")
    assert.equal(result, false, "Should return false when binary doesn't exist")
  })
})
