import assert from "node:assert/strict"
import test from "node:test"
import { splitDisplayPath } from "./unified-picker-path"

test("splits paths into file and abbreviated directory context", () => {
  assert.deepEqual(splitDisplayPath("packages/ui/src/components/unified-picker.tsx"), {
    name: "unified-picker.tsx",
    start: "packages",
    parent: "components",
    hasMiddle: true,
  })
  assert.deepEqual(splitDisplayPath("src/components/"), {
    name: "components/",
    start: "src",
    parent: "",
    hasMiddle: false,
  })
  assert.deepEqual(splitDisplayPath("README.md"), {
    name: "README.md",
    start: "",
    parent: "",
    hasMiddle: false,
  })
})
