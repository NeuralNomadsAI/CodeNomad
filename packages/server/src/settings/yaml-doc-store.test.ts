import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, it } from "node:test"
import { YamlDocStore } from "./yaml-doc-store"

describe("YamlDocStore", () => {
  it("reports persistence failures without replacing the cached document", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-yaml-store-"))
    const parent = path.join(root, "settings")
    const file = path.join(parent, "config.yaml")
    const store = new YamlDocStore(file, { warn() {} } as any, { throwOnPersistError: true })

    try {
      store.replace({ version: 1 })
      fs.rmSync(parent, { recursive: true })
      fs.writeFileSync(parent, "blocks directory creation")

      assert.throws(() => store.replace({ version: 2 }))
      assert.deepEqual(store.get(), { version: 1 })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("keeps the live document intact when atomic replacement fails", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-yaml-store-"))
    const file = path.join(root, "config.yaml")
    const store = new YamlDocStore(file, { warn() {} } as any, { throwOnPersistError: true })
    const renameSync = fs.renameSync

    try {
      store.replace({ version: 1 })
      ;(fs as any).renameSync = () => { throw new Error("replacement failed") }

      assert.throws(() => store.replace({ version: 2 }))
      assert.match(fs.readFileSync(file, "utf8"), /version: 1/)
      assert.deepEqual(store.get(), { version: 1 })

      ;(fs as any).renameSync = renameSync
      store.replace({ version: 2 })
      assert.match(fs.readFileSync(file, "utf8"), /version: 2/)
    } finally {
      ;(fs as any).renameSync = renameSync
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("preserves private file permissions", { skip: process.platform === "win32" }, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-yaml-store-"))
    const file = path.join(root, "config.yaml")
    const store = new YamlDocStore(file, { warn() {} } as any, { throwOnPersistError: true })

    try {
      store.replace({ version: 1 })
      fs.chmodSync(file, 0o600)
      store.replace({ version: 2 })
      assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("updates a symlink target without replacing the link", { skip: process.platform === "win32" }, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codenomad-yaml-store-"))
    const target = path.join(root, "target.yaml")
    const link = path.join(root, "config.yaml")
    fs.writeFileSync(target, "version: 1\n")
    fs.symlinkSync(target, link)
    const store = new YamlDocStore(link, { warn() {} } as any, { throwOnPersistError: true })

    try {
      store.replace({ version: 2 })
      assert.equal(fs.lstatSync(link).isSymbolicLink(), true)
      assert.match(fs.readFileSync(target, "utf8"), /version: 2/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
