import assert from "node:assert/strict"
import test from "node:test"
import { changeWorkspaceFileDrafts, MAX_FILE_DRAFT_BYTES, normalizeWorkspaceFileDrafts } from "./workspace-file-drafts-codec"

test("draft storage counts the exact encoded budget without evicting existing drafts", () => {
  const first = { key: "one", fingerprint: "0".repeat(64), text: "été" }
  const second = { ...first, key: "two", text: "" }
  const overhead = Buffer.byteLength(JSON.stringify([first, second]))
  second.text = "x".repeat(MAX_FILE_DRAFT_BYTES - overhead)
  assert.deepEqual(normalizeWorkspaceFileDrafts([first, second]), [first, second])
  assert.deepEqual(changeWorkspaceFileDrafts([first], second.key, second), [first, second])
  assert.equal(changeWorkspaceFileDrafts([first], second.key, { ...second, text: second.text + "x" }), null)
})
