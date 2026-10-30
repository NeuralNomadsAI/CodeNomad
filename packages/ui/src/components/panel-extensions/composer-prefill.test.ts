import assert from "node:assert/strict"
import { test } from "node:test"
import { composePrefill, prefillMarkers } from "./composer-prefill"

test("separators, quoted Unicode paths and CRLF normalization", () => {
  assert.deepEqual(composePrefill("", "Refine {{1}}.", ["a/b.png"]), { status: "added", draft: "Refine `a/b.png`." })
  assert.deepEqual(composePrefill("Hello", "World", []), { status: "added", draft: "Hello\n\nWorld" })
  assert.deepEqual(composePrefill("Hello\n", "World", []), { status: "added", draft: "Hello\n\nWorld" })
  assert.deepEqual(composePrefill("Hi\r\n", "A\r\nB {{2}} {{1}} {{1}}", ["é/ü.png", "图/片.png"]),
    { status: "added", draft: "Hi\n\nA\nB `图/片.png` `é/ü.png` `é/ü.png`" })
})

test("2,048 UTF-8 bytes after substitution; empty text refused", () => {
  assert.equal(composePrefill("", "x".repeat(2048), []).status, "added")
  assert.equal(composePrefill("", "x".repeat(2049), []).status, "too-long")
  assert.equal(composePrefill("", "é".repeat(1025), []).status, "too-long")
  assert.equal(composePrefill("", `${"x".repeat(2040)}{{1}}`, ["abcdefgh"]).status, "too-long")
  assert.equal(composePrefill("draft", "  \n", []).status, "invalid")
})

test("markers must match references exactly; paths with a backtick or a line break are refused", () => {
  assert.equal(prefillMarkers("{{1}} {{2}}", 2) !== "invalid", true)
  for (const [text, count] of [["{{1}}", 0], ["no marker", 1], ["{{1}}", 2], ["{{0}}", 1], ["{{17}}", 17], ["{{3}}", 2]] as const) {
    assert.equal(prefillMarkers(text, count), "invalid", `${text} / ${count}`)
  }
  for (const path of ["a`b.png", "a\nb.png", "a\rb.png", ""]) assert.equal(composePrefill("", "{{1}}", [path]).status, "invalid")
})

test("the resulting draft never becomes a command or ends in an open mention (the picker's own rule)", () => {
  for (const [draft, text] of [["/review the change", "Refine"], ["/btw what", "x"], ["", "/review"], ["  ", " /x"],
    ["", "Ask @x"], ["", "Copy (@file"], ["See @", "and @src"]]) {
    assert.equal(composePrefill(draft, text, []).status, "invalid", JSON.stringify([draft, text]))
  }
  for (const [draft, text] of [["", "mail me at a@b.c"], ["", "packages/@scope/x"], ["@x is done", "Next"], ["", "@x then text"]]) {
    assert.equal(composePrefill(draft, text, []).status, "added", JSON.stringify([draft, text]))
  }
})
