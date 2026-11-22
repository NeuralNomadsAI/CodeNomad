import assert from "node:assert/strict"
import { test } from "node:test"
import { browserTargetRefusal } from "./browser-target"

test("preview failures keep their stable code when a native adapter adds context", () => {
  assert.equal(browserTargetRefusal("Browser target is stale; probe again").code, "stale-preview")
  assert.equal(browserTargetRefusal("WebView2 dispatch: Multiple visible browser targets exist for this session").code, "ambiguous-target")
})
