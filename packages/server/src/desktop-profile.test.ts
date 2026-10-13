import assert from "node:assert/strict"
import test from "node:test"
import { readDesktopProfile } from "./desktop-profile"

test("desktop profile is reported only when the host announces a printable non-default profile", () => {
  assert.equal(readDesktopProfile({}), undefined)
  assert.equal(readDesktopProfile({ CODENOMAD_DESKTOP_PROFILE: "  " }), undefined)
  assert.equal(readDesktopProfile({ CODENOMAD_DESKTOP_PROFILE: " dev-v2 " }), "dev-v2")
  assert.equal(readDesktopProfile({ CODENOMAD_DESKTOP_PROFILE: "dev\u0007" }), undefined)
  assert.equal(readDesktopProfile({ CODENOMAD_DESKTOP_PROFILE: "x".repeat(129) }), undefined)
  // The server never derives a profile from the deprecated channel alias.
  assert.equal(readDesktopProfile({ CODENOMAD_UPDATE_CHANNEL: "dev" }), undefined)
})
