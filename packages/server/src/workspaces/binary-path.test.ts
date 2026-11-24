import assert from "node:assert/strict"
import test from "node:test"
import { binaryPathsEqual } from "./manager"

test("matches regular Windows binary paths without case sensitivity", () => {
  assert.equal(binaryPathsEqual(String.raw`C:\Tools\OpenCode.cmd`, String.raw`c:\tools\opencode.CMD`, "win32"), true)
})

test("matches WSL distro names without changing Linux path casing", () => {
  assert.equal(
    binaryPathsEqual(
      String.raw`\\wsl.localhost\Ubuntu\home\dev\OpenCode`,
      String.raw`\\wsl$\ubuntu\home\dev\OpenCode`,
      "win32",
    ),
    true,
  )
  assert.equal(
    binaryPathsEqual(
      String.raw`\\wsl.localhost\Ubuntu\home\dev\OpenCode`,
      String.raw`\\wsl$\ubuntu\home\dev\opencode`,
      "win32",
    ),
    false,
  )
})
