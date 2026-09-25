import assert from "node:assert/strict"
import test from "node:test"
import { matchesDevReleaseChannel } from "./dev-release-monitor"

test("dev prereleases stay within their V1 or V2 channel", () => {
  const v1 = "v0.19.0-dev-20260825-12345678"
  const v2 = "v0.20.0-dev-v2-20260825-abcdef12"

  assert.equal(matchesDevReleaseChannel(v1, v1), true)
  assert.equal(matchesDevReleaseChannel(v2, v1), false)
  assert.equal(matchesDevReleaseChannel(v2, v2), true)
  assert.equal(matchesDevReleaseChannel(v1, v2), false)
})
