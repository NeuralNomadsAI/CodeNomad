import assert from "node:assert/strict"
import { test } from "node:test"
import { isTrimWhitespaceOnlyChange } from "./diff-whitespace"

test("re-indentation, trailing blanks and line endings are whitespace-only changes", () => {
  assert.equal(isTrimWhitespaceOnlyChange("if (x) {\n  call()\n}\n", "if (x) {\n\tcall()   \n}\n"), true)
  assert.equal(isTrimWhitespaceOnlyChange("a\nb\n", "a\r\nb\r\n"), true)
  assert.equal(isTrimWhitespaceOnlyChange("  a", "a  "), true)
})

test("identical texts and real content changes are not whitespace-only", () => {
  assert.equal(isTrimWhitespaceOnlyChange("a\n", "a\n"), false)
  assert.equal(isTrimWhitespaceOnlyChange("call(1)\n", "call( 1)\n"), false, "inner whitespace stays visible, like Monaco")
  assert.equal(isTrimWhitespaceOnlyChange("a\n", "a\n\n"), false, "an added blank line is a change")
  assert.equal(isTrimWhitespaceOnlyChange("a\nb", "a\nc"), false)
  assert.equal(isTrimWhitespaceOnlyChange("a ", "a"), false, "only spaces and tabs are trimmed")
})
