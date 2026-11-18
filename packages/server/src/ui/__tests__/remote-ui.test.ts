import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
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

  it("prefers bundled when bundled and downloaded versions are equal", async () => {
    const bundledDir = path.join(tempRoot, "bundled")
    const configDir = path.join(tempRoot, "config")
    const currentDir = path.join(configDir, "ui", "current")

    await mkdir(bundledDir, { recursive: true })
    await mkdir(currentDir, { recursive: true })

    writeFileSync(path.join(bundledDir, "index.html"), "<html>bundled</html>")
    writeFileSync(path.join(bundledDir, "ui-version.json"), JSON.stringify({ uiVersion: "0.8.1" }))

    writeFileSync(path.join(currentDir, "index.html"), "<html>current</html>")
    writeFileSync(path.join(currentDir, "ui-version.json"), JSON.stringify({ uiVersion: "0.8.1" }))

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

describe("resolveUi manifest request", () => {
  it("keeps 1.0.x servers on their local UI when the 1.1 Missions API is required", async t => {
    const release = JSON.parse(readFileSync(new URL("../../../../cloudflare/release-config.json", import.meta.url), "utf8"))
    const host = createServer((_request, response) => {
      response.setHeader("Content-Type", "application/json")
      response.end(JSON.stringify({ ...release, latestUIVersion: "1.1.0", sha256: "0".repeat(64),
        uiPackageURL: "https://unused.invalid/ui-1.1.0.zip" }))
    })
    await new Promise<void>(resolve => host.listen(0, "127.0.0.1", resolve))
    try {
      const manifestUrl = `http://127.0.0.1:${(host.address() as AddressInfo).port}/version.json`
      const originalFetch = globalThis.fetch
      t.mock.method(globalThis, "fetch", async (...args: Parameters<typeof fetch>) => {
        assert.equal(String(args[0]), manifestUrl, "an incompatible UI must never be downloaded")
        return originalFetch(...args)
      })
      for (const version of ["1.0.0", "1.0.1", "1.1.0", "2.0.0"]) {
        const bundledDir = path.join(tempRoot, version, "bundled")
        await mkdir(bundledDir, { recursive: true })
        writeFileSync(path.join(bundledDir, "index.html"), "<html>bundled</html>")
        writeFileSync(path.join(bundledDir, "ui-version.json"), JSON.stringify({ uiVersion: version }))
        const result = await resolveUi({ serverVersion: version, bundledUiDir: bundledDir, autoUpdate: true,
          manifestUrl, configDir: path.join(tempRoot, version, "config"), logger: noopLogger })
        assert.equal(result.supported, version === "1.1.0" || version === "2.0.0", version)
        assert.equal(result.minServerVersion, "1.1.0")
        assert.equal(result.source, "bundled")
        assert.equal(result.uiVersion, version)
      }
    } finally {
      await new Promise<void>(resolve => host.close(() => resolve()))
    }
  })

  it("identifies the server version in its User-Agent", async () => {
    const bundledDir = path.join(tempRoot, "bundled")
    await mkdir(bundledDir, { recursive: true })
    writeFileSync(path.join(bundledDir, "index.html"), "<html>bundled</html>")

    const userAgents: Array<string | undefined> = []
    const manifestHost = createServer((request, response) => {
      userAgents.push(request.headers["user-agent"])
      response.writeHead(404).end()
    })
    await new Promise<void>((resolve) => manifestHost.listen(0, "127.0.0.1", resolve))
    try {
      const { port } = manifestHost.address() as AddressInfo
      const result = await resolveUi({
        serverVersion: "1.0.0",
        bundledUiDir: bundledDir,
        autoUpdate: true,
        manifestUrl: `http://127.0.0.1:${port}/version.json`,
        configDir: path.join(tempRoot, "config"),
        logger: noopLogger,
      })

      assert.deepEqual(userAgents, ["CodeNomad-CLI/1.0.0"])
      assert.equal(result.source, "bundled")
    } finally {
      await new Promise((resolve) => manifestHost.close(resolve))
    }
  })
})
