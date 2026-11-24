import assert from "node:assert/strict"
import test from "node:test"
import { splitDisplayPath } from "./unified-picker-path"

test("splits paths into file and directory context", () => {
  assert.deepEqual(splitDisplayPath("packages/ui/src/components/unified-picker.tsx"), {
    name: "unified-picker.tsx",
    parent: "components",
    directory: "packages/ui/src/components",
  })
  assert.deepEqual(splitDisplayPath("src/components/"), {
    name: "components/",
    parent: "src",
    directory: "src",
  })
  assert.deepEqual(splitDisplayPath("README.md"), {
    name: "README.md",
    parent: "",
    directory: "",
  })
})
