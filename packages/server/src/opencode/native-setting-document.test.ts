import assert from "node:assert/strict"
import test from "node:test"
import { parse as parseJsonc, type ParseError } from "jsonc-parser"
import type { PluginControlDocument } from "./plugin-control-document"
import { appendNativeSetting, removeEmptyNativeList, removeEmptyNativeObject, removeNativeListElement } from "./native-setting-document"

const bom = String.fromCharCode(0xfeff)
/** Parses strictly: any JSONC error fails the test. */
function parse(text: string) {
  const errors: ParseError[] = []
  const value = parseJsonc(text, errors, { allowTrailingComma: true })
  assert.deepEqual(errors, [], text)
  return value
}
const document = (text: string, byteOrderMark = false) => ({ text, byteOrderMark }) as PluginControlDocument

test("an empty object is removed with its interior comments kept where the property was", () => {
  const text = [`{`, `  "experimental": {`, `    // Keep this policy note`, `    /* and this one */`, `  },`, `  "shell": "keep"`, `}`, ``].join("\r\n")
  const saved = removeEmptyNativeObject(document(text, true), ["experimental"])!
  assert.ok(saved.startsWith(bom) && !saved.slice(1).startsWith(bom), "exactly one byte order mark")
  assert.ok(saved.includes("\r\n") && !/[^\r]\n/.test(saved), "CRLF kept")
  assert.match(saved, /\/\* Keep this policy note \*\//, "a line comment is kept as a block comment")
  assert.match(saved, /\/\* and this one \*\//)
  assert.deepEqual(parse(saved.slice(1)), { shell: "keep" })
})

test("comments of a last empty property trail the previous value and stay valid JSONC", () => {
  const saved = removeEmptyNativeObject(document(`{\n  "shell": "keep",\n  "experimental": {\n    // note\n  }\n}\n`), ["experimental"])!
  assert.match(saved, /\/\* note \*\//)
  assert.deepEqual(parse(saved), { shell: "keep" })
  assert.equal(removeEmptyNativeObject(document(`{ "experimental": {} }`), ["experimental"])?.includes("experimental"), false)
})

test("compact and brace-adjacent comments stay outside sibling values in every position", () => {
  const cases: [string, unknown][] = [
    [`{"experimental":{/* NOTE */}}`, {}],
    [`{"shell":"keep","experimental":{ /* NOTE */},"tail":1}`, { shell: "keep", tail: 1 }],
    [`{"shell":"keep","experimental":{ // NOTE\n},"tail":1}`, { shell: "keep", tail: 1 }],
    [`{"experimental":{// NOTE */ x\n},"shell":{"a":[1,],},}`, { shell: { a: [1] } }],
    [`{"shell":"k","experimental":{/*N*/}}`, { shell: "k" }],
  ]
  for (const [text, expected] of cases) {
    const saved = removeEmptyNativeObject(document(text), ["experimental"])!
    assert.deepEqual(parse(saved), expected, text)
    assert.match(saved, /NOTE|N\*\//, text)
  }
})

test("only an object without properties is removed", () => {
  for (const text of [`{}`, `{ "experimental": { "subagent_depth": 2 } }`, `{ "experimental": [] }`])
    assert.equal(removeEmptyNativeObject(document(text), ["experimental"]), undefined, text)
  assert.throws(() => removeEmptyNativeObject(document(`{ "experimental": {}, "experimental": {} }`), ["experimental"]), /duplicate/)
})

test("appending creates a missing list with its parents and keeps comments", () => {
  const created = appendNativeSetting(document(`{\r\n\t// note\r\n\t"shell": "keep"\r\n}\r\n`, true), ["a", "b"], 1)
  assert.ok(created.startsWith(bom) && created.includes("// note") && !/[^\r]\n/.test(created))
  assert.deepEqual(parse(created.slice(1)), { shell: "keep", a: { b: [1] } })
  assert.equal(appendNativeSetting(document(`{ "a": { "b": [0] } }`), ["a", "b"], 1), `{ "a": { "b": [0, 1] } }\n`)
  assert.throws(() => appendNativeSetting(document(`{ "a": { "b": {} } }`), ["a", "b"], 1), /list/)
})

test("an appended element leaves existing lines untouched and heads an object with its comment", () => {
  const lines = [`{`, `  "a": [`, `    { "kept": "inline" }, // note`, `  ]`, `}`, ``]
  const saved = appendNativeSetting(document(lines.join("\n")), ["a"], { x: 1 }, "why")
  assert.equal(saved, [...lines.slice(0, 3), `    {`, `      // why`, `      "x": 1`, `    },`, ...lines.slice(3)].join("\n"),
    "the element follows the trailing comma at the last element's indentation")
  const empty = appendNativeSetting(document(`{\n\t"a": [ /* empty */ ]\n}\n`), ["a"], { x: 1 }, "why")
  assert.match(empty, /"a": \[\n\t\t\{\n\t\t\t\/\/ why\n\t\t\t"x": 1\n\t\t\}\n\t \/\* empty \*\/ \]/)
  assert.deepEqual(parse(empty), { a: [{ x: 1 }] })
})

test("an empty list is removed like an empty object; a list with elements stays", () => {
  const saved = removeEmptyNativeList(document(`{\n  "a": [\n    // note\n  ],\n  "b": 1\n}\n`), ["a"])!
  assert.match(saved, /\/\* note \*\//)
  assert.deepEqual(parse(saved), { b: 1 })
  for (const text of [`{ "a": [1] }`, `{ "a": {} }`, `{}`]) assert.equal(removeEmptyNativeList(document(text), ["a"]), undefined, text)
})

test("a list element goes with one comma and its own line, keeping neighbours and comments", () => {
  const text = [`{`, `  "a": [`, `    1, // one`, `    // two follows`, `    {`, `      // inside`, `      "x": 2`, `    },`, `    3`, `  ]`, `}`, ``].join("\n")
  const middle = removeNativeListElement(document(text), ["a"], 1)!
  assert.deepEqual(parse(middle), { a: [1, 3] })
  assert.match(middle, /\/\/ one\n    \/\/ two follows\n    3\n/)
  assert.doesNotMatch(middle, /inside/)
  const last = removeNativeListElement(document(text), ["a"], 2)!
  assert.deepEqual(parse(last), { a: [1, { x: 2 }] })
  assert.match(last, /    }\n  ]/)
  assert.deepEqual(parse(removeNativeListElement(document(`{"a":[1,2,3]}`), ["a"], 0)!), { a: [2, 3] })
  assert.deepEqual(parse(removeNativeListElement(document(`{"a":[ {"x":1}]}`), ["a"], 0)!), { a: [] })
  // A bracket sharing the element's line keeps the line break that ends a previous line comment.
  assert.deepEqual(parse(removeNativeListElement(document(`{"a":[1, // c\n  2]}`), ["a"], 1)!), { a: [1] })
  for (const index of [-1, 3, 0.5]) assert.equal(removeNativeListElement(document(`{"a":[1,2,3]}`), ["a"], index), undefined)
  assert.equal(removeNativeListElement(document(`{"a":{}}`), ["a"], 0), undefined)
})
