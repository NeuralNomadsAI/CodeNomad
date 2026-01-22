import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, it } from "node:test"

import type { Logger } from "../../logger"
import { resolveUi } from "../remote-ui"

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  trace: () => {},
  child: () => noopLogger,
  isLevelEnabled: () => false,
} as any

let tempRoot: string

beforeEach(() => {
  tempRoot = mkdtempSync(path.join(os.tmpdir(), "codenomad-ui-test-"))
})

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true })
})

describe("resolveUi local version preference", () => {
  it("prefers bundled when bundled version is higher", async () => {
    const bundledDir = path.join(tempRoot, "bundled")
    const configDir = path.join(tempRoot, "config")
    const currentDir = path.join(configDir, "ui", "current")

    await mkdir(bundledDir, { recursive: true })
    await mkdir(currentDir, { recursive: true })

    writeFileSync(path.join(bundledDir, "index.html"), "<html>bundled</html>")
    writeFileSync(path.join(bundledDir, "ui-version.json"), JSON.stringify({ uiVersion: "0.8.1" }))

    writeFileSync(path.join(currentDir, "index.html"), "<html>current</html>")
    writeFileSync(path.join(currentDir, "ui-version.json"), JSON.stringify({ uiVersion: "0.8.0" }))

    const result = await resolveUi({
      serverVersion: "0.8.1",
      bundledUiDir: bundledDir,
      autoUpdate: false,
      configDir,
      logger: noopLogger,
    })

    assert.equal(result.source, "bundled")
    assert.equal(result.uiStaticDir, bundledDir)
    assert.equal(result.uiVersion, "0.8.1")
  })
})
