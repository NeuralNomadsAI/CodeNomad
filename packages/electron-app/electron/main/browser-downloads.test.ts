import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, basename } from "node:path"
import { test } from "node:test"
import { reserveBrowserDownload } from "./browser-downloads"

test("download reservations are confined, sanitized, unique and never replace files", () => {
  const directory = mkdtempSync(join(tmpdir(), "codenomad-download-"))
  try {
    for (const name of ["../../secret.txt", "..\\..\\secret.txt", "..", "a\n:b?.txt", "é".repeat(300)]) {
      const first = reserveBrowserDownload(directory, name)
      writeFileSync(first, "original")
      const second = reserveBrowserDownload(directory, name)
      assert.notEqual(first, second)
      assert.equal(dirname(first), directory)
      assert.equal(/[\x00-\x1f/\\:*?"<>|]/.test(basename(first)), false)
      assert.ok(Buffer.byteLength(basename(first)) <= 217)
      assert.equal(readFileSync(first, "utf8"), "original")
    }
    assert.throws(() => reserveBrowserDownload(join(directory, "missing"), "file"))
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
