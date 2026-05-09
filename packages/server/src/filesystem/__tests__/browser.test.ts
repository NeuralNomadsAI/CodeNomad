import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, it } from "node:test"
import { FileSystemBrowser } from "../browser"
import { WINDOWS_DRIVES_ROOT } from "../../api-types"

const tempRoots: string[] = []

describe("FileSystemBrowser", () => {
  afterEach(() => {
    for (const directory of tempRoots.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it("starts unrestricted browsing from the configured root", () => {
    const rootDir = createTempRoot()
    fs.mkdirSync(path.join(rootDir, "project"))

    const browser = new FileSystemBrowser({ rootDir, unrestricted: true })
    const listing = browser.browse()

    assert.equal(listing.metadata.scope, "unrestricted")
    assert.equal(listing.metadata.currentPath, rootDir)
    assert.equal(listing.metadata.rootPath, rootDir)
    assert.equal(listing.metadata.displayPath, rootDir)
    assert.equal(listing.metadata.pathKind, "absolute")
    assert.ok(listing.entries.some((entry) => entry.name === "project" && entry.absolutePath === path.join(rootDir, "project")))
  })

  it("treats dot as the configured unrestricted root", () => {
    const rootDir = createTempRoot()
    const browser = new FileSystemBrowser({ rootDir, unrestricted: true })

    const listing = browser.browse(".")

    assert.equal(listing.metadata.currentPath, rootDir)
    assert.equal(listing.metadata.rootPath, rootDir)
  })

  it("allows unrestricted browsing outside the configured root", () => {
    const rootDir = createTempRoot()
    const parentDir = path.dirname(rootDir)
    const browser = new FileSystemBrowser({ rootDir, unrestricted: true })

    const listing = browser.browse(parentDir)

    assert.equal(listing.metadata.currentPath, parentDir)
    assert.equal(listing.metadata.rootPath, rootDir)
    assert.ok(listing.entries.some((entry) => entry.absolutePath === rootDir))
  })

  it("creates folders under the configured unrestricted root by default", () => {
    const rootDir = createTempRoot()
    const browser = new FileSystemBrowser({ rootDir, unrestricted: true })

    const created = browser.createFolder(undefined, "created-folder")

    assert.equal(created.path, path.join(rootDir, "created-folder"))
    assert.equal(created.absolutePath, path.join(rootDir, "created-folder"))
    assert.equal(fs.statSync(created.absolutePath).isDirectory(), true)
  })

  it("reports the configured root for the Windows drives pseudo-root", () => {
    const rootDir = createTempRoot()
    const browser = new FileSystemBrowser({ rootDir, unrestricted: true, platform: "win32" })

    const listing = browser.browse(WINDOWS_DRIVES_ROOT)

    assert.equal(listing.metadata.scope, "unrestricted")
    assert.equal(listing.metadata.currentPath, WINDOWS_DRIVES_ROOT)
    assert.equal(listing.metadata.rootPath, rootDir)
    assert.equal(listing.metadata.pathKind, "drives")
  })
})

function createTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-browser-"))
  tempRoots.push(root)
  return fs.realpathSync(root)
}
