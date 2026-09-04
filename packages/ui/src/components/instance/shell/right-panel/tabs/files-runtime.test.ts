import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { adaptFileSystemEntries, decodeFileContent } from "./file-v2-adapters.ts"

describe("files runtime V2 adapters", () => {
  it("adds names to native file system entries", () => {
    assert.deepEqual(adaptFileSystemEntries([
      { path: "src/components", type: "directory" },
      { path: "src\\index.ts", type: "file" },
    ]), [
      { path: "src/components", name: "components", type: "directory" },
      { path: "src/index.ts", name: "index.ts", type: "file" },
    ])
  })

  it("decodes native byte output and rejects binary content", () => {
    assert.equal(decodeFileContent(new TextEncoder().encode("hello\n")), "hello\n")
    assert.throws(() => decodeFileContent(Uint8Array.of(0xff)))
    assert.throws(() => decodeFileContent(Uint8Array.of(0)))
  })
})
