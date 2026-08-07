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
})
