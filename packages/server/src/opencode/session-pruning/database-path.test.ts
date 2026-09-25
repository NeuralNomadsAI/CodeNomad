import assert from "node:assert/strict"
import { test } from "node:test"
import path from "node:path"
import { pruningDatabasePath } from "./database-path"

test("local plugin resolves the daemon's normal database without per-project configuration", () => {
  const home = path.resolve("synthetic-home")
  const data = path.join(home, ".local", "share", "opencode")
  for (const channel of ["beta", "latest", "prod"]) {
    assert.equal(pruningDatabasePath(undefined, channel, {}, home), path.join(data, "opencode.db"))
  }
  assert.equal(pruningDatabasePath(undefined, "dev/feature", {}, home), path.join(data, "opencode-dev-feature.db"))
  assert.equal(pruningDatabasePath(undefined, "dev", { OPENCODE_DISABLE_CHANNEL_DB: "true" }, home), path.join(data, "opencode.db"))
  const xdg = path.join(home, "xdg")
  assert.equal(pruningDatabasePath(undefined, "beta", { XDG_DATA_HOME: xdg }, home), path.join(xdg, "opencode", "opencode.db"))
  assert.equal(pruningDatabasePath(undefined, "beta", { XDG_DATA_HOME: "relative" }, home), path.join(data, "opencode.db"))
  assert.equal(pruningDatabasePath(undefined, "beta", { OPENCODE_DB: "custom.db" }, home), path.join(data, "custom.db"))
  const explicit = path.join(home, "explicit.db")
  assert.equal(pruningDatabasePath(undefined, "beta", { OPENCODE_DB: explicit }, home), explicit)
  assert.equal(pruningDatabasePath(undefined, "beta", { OPENCODE_DB: ":memory:" }, home), ":memory:")
  assert.equal(pruningDatabasePath(explicit, "beta", { OPENCODE_DB: "ignored.db" }, home), explicit)
})
