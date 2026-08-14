import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, it } from "node:test"
import { parse as parseYaml } from "yaml"
import type { Logger } from "../logger"
import { resolveConfigLocation } from "../config/location"
import { migrateSettingsLayout } from "./migrate"

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

describe("settings migration", () => {
  it("drops OPENCODE_DB while preserving unrelated environment variables", () => {
    const root = mkdtempSync(path.join(tmpdir(), "codenomad-migrate-"))
    roots.push(root)
    const location = resolveConfigLocation(path.join(root, "config.json"))
    writeFileSync(location.legacyJsonPath, JSON.stringify({
      preferences: { environmentVariables: { OPENCODE_DB: "/legacy/opencode.db", KEEP_ME: "yes" } },
    }))

    const logger = { info() {}, warn() {} } as unknown as Logger
    migrateSettingsLayout(location, logger)

    const migrated = parseYaml(readFileSync(location.configYamlPath, "utf8"))
    assert.deepEqual(migrated.server.environmentVariables, { KEEP_ME: "yes" })
  })
})
