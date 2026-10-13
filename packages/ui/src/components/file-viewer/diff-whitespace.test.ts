import assert from "node:assert/strict"
import { test } from "node:test"
import { classifyHiddenDiffChange } from "./diff-whitespace"

test("re-indentation and trailing blanks are hidden whitespace changes", () => {
  assert.equal(classifyHiddenDiffChange("if (x) {\n  call()\n}\n", "if (x) {\n\tcall()   \n}\n"), "whitespace")
  assert.equal(classifyHiddenDiffChange("  a", "a  "), "whitespace")
  assert.equal(classifyHiddenDiffChange("a\r\n  b\r\n", "a\n    b\n"), "whitespace", "line endings beside a re-indent stay a whitespace change")
  assert.equal(classifyHiddenDiffChange("﻿a\n", "a \n"), "whitespace", "Monaco strips one leading byte-order mark")
})

test("same-length trailing-whitespace swaps Monaco never draws still get the whitespace notice", () => {
  assert.equal(classifyHiddenDiffChange("foo\t\n", "foo \n"), "whitespace")
  assert.equal(classifyHiddenDiffChange("foo  \n", "foo\t\t\n"), "whitespace")
  assert.equal(classifyHiddenDiffChange("a\n\t\n", "a\n \n"), "whitespace", "a whitespace-only line")
})

test("line endings and byte-order marks alone are invisible in both modes", () => {
  assert.equal(classifyHiddenDiffChange("a\nb\n", "a\r\nb\r\n"), "invisible")
  assert.equal(classifyHiddenDiffChange("a\nb", "a\rb"), "invisible", "a lone CR is a line terminator")
  assert.equal(classifyHiddenDiffChange("﻿a\n", "a\n"), "invisible")
  assert.equal(classifyHiddenDiffChange("﻿", ""), "invisible", "two empty models compare equal")
})

test("identical texts and drawn changes are not hidden", () => {
  assert.equal(classifyHiddenDiffChange("a\n", "a\n"), null)
  assert.equal(classifyHiddenDiffChange("call(1)\n", "call( 1)\n"), null, "inner whitespace stays visible, like Monaco")
  assert.equal(classifyHiddenDiffChange("a\n", "a\n\n"), null, "an added blank line is a change")
  assert.equal(classifyHiddenDiffChange("a\nb", "a\nc"), null)
  assert.equal(classifyHiddenDiffChange("a ", "a"), null, "only spaces and tabs are trimmed")
  assert.equal(classifyHiddenDiffChange("", "   "), null, "an empty side is a whole-file change in Monaco")
  assert.equal(classifyHiddenDiffChange("  ", ""), null)
})

test("long inner blank runs are classified in linear time", () => {
  const blanks = " ".repeat(100_000)
  const started = performance.now()
  assert.equal(classifyHiddenDiffChange(`a${blanks}b\n`, `\ta${blanks}b  \n`), "whitespace")
  assert.equal(classifyHiddenDiffChange(`a${blanks}b`, `a${blanks} b`), null)
  assert.ok(performance.now() - started < 100, "a 100k-space line must not stall the renderer")
})
