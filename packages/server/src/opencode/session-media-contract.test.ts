import assert from "node:assert/strict"
import { test } from "node:test"
import { isSessionMediaPath, parseSessionMediaPath } from "./session-media-contract"
import { sessionMediaPath } from "./session-media"

test("canonical references preserve exact raw workspace IDs and opaque native identities", () => {
  const ref = { workspaceId: "lab~same", sessionId: "s/工作", messageId: "msg%one", part: 0, index: 100000, digest: "a".repeat(64) }
  const path = sessionMediaPath(ref)
  assert.deepEqual(parseSessionMediaPath(path), ref)
  assert(isSessionMediaPath(path))
  for (const invalid of [path + "?x=1", path + "#a", path.replace("/0/", "/00/"), path.replace("/100000/", "/100001/"), path.replace("%2F", "%2f"), path.replace("lab~same", "%6Cab~same"), path.replace("lab~same", "%00"), path.replace("lab~same", "a".repeat(257)), path.replace("lab~same", "%")]) assert.equal(parseSessionMediaPath(invalid), undefined, invalid)
})
