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
})
