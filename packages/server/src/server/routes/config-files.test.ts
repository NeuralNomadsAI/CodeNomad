import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, it } from "node:test"
import Fastify from "fastify"

import { registerConfigFileRoutes } from "./config-files"

const tempDirs = new Set<string>()

afterEach(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  tempDirs.clear()
})

describe("config file routes", () => {
  it("lists only allowlisted config file descriptors", async () => {
    const tempDir = createTempDir()
    const app = createApp(path.join(tempDir, "opencode", "opencode.json"), "~/.config/opencode/opencode.json")

    const response = await app.inject({ method: "GET", url: "/api/config-files" })

    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), [
      {
        id: "test-config",
        label: "Test Config",
        path: "~/.config/opencode/opencode.json",
        language: "json",
      },
    ])
    await app.close()
  })

  it("returns empty content for an allowlisted missing file", async () => {
    const tempDir = createTempDir()
    const app = createApp(path.join(tempDir, "missing", "config.json"), "display/config.json")

    const response = await app.inject({ method: "GET", url: "/api/config-files/test-config/content" })

    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), {
      id: "test-config",
      path: "display/config.json",
      contents: "",
      exists: false,
    })
    await app.close()
  })

  it("creates parent directories when writing an allowlisted file", async () => {
    const tempDir = createTempDir()
    const targetPath = path.join(tempDir, "nested", "opencode.json")
    const app = createApp(targetPath, "display/opencode.json")

    const response = await app.inject({
      method: "PUT",
      url: "/api/config-files/test-config/content",
      payload: { contents: '{"model":"test"}' },
    })

    assert.equal(response.statusCode, 204)
    assert.equal(fs.readFileSync(targetPath, "utf-8"), '{"model":"test"}')
    await app.close()
  })

  it("rejects unknown config file ids", async () => {
    const tempDir = createTempDir()
    const app = createApp(path.join(tempDir, "opencode.json"), "display/opencode.json")

    const readResponse = await app.inject({ method: "GET", url: "/api/config-files/unknown/content" })
    const writeResponse = await app.inject({
      method: "PUT",
      url: "/api/config-files/unknown/content",
      payload: { contents: "{}" },
    })

    assert.equal(readResponse.statusCode, 404)
    assert.equal(writeResponse.statusCode, 404)
    await app.close()
  })

  it("returns a client error when writes fail", async () => {
    const tempDir = createTempDir()
    const blockedParent = path.join(tempDir, "not-a-directory")
    fs.writeFileSync(blockedParent, "occupied")
    const app = createApp(path.join(blockedParent, "opencode.json"), "display/opencode.json")

    const response = await app.inject({
      method: "PUT",
      url: "/api/config-files/test-config/content",
      payload: { contents: "{}" },
    })

    assert.equal(response.statusCode, 400)
    await app.close()
  })
})

function createTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-config-files-test-"))
  tempDirs.add(dir)
  return dir
}

function createApp(absolutePath: string, displayPath: string) {
  const app = Fastify({ logger: false })
  registerConfigFileRoutes(app, {
    files: [
      {
        id: "test-config",
        label: "Test Config",
        path: displayPath,
        absolutePath,
        language: "json",
      },
    ],
  })
  return app
}
