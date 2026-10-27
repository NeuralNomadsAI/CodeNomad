import assert from "node:assert/strict"
import test from "node:test"
import { parse } from "jsonc-parser"
import type { PluginControlDocument } from "./plugin-control-document"
import { removeEmptyNativeObject } from "./native-setting-document"

const bom = String.fromCharCode(0xfeff)
const document = (text: string, byteOrderMark = false) => ({ text, byteOrderMark }) as PluginControlDocument

test("an empty object is removed with its interior comments kept where the property was", () => {
  const text = [`{`, `  "experimental": {`, `    // Keep this policy note`, `    /* and this one */`, `  },`, `  "shell": "keep"`, `}`, ``].join("\r\n")
  const saved = removeEmptyNativeObject(document(text, true), ["experimental"])!
  assert.ok(saved.startsWith(bom) && !saved.slice(1).startsWith(bom), "exactly one byte order mark")
  assert.ok(saved.includes("\r\n") && !/[^\r]\n/.test(saved), "CRLF kept")
  assert.match(saved, /\/\/ Keep this policy note/)
  assert.match(saved, /\/\* and this one \*\//)
  assert.deepEqual(parse(saved.slice(1)), { shell: "keep" })
})

test("comments of a last empty property trail the previous value and stay valid JSONC", () => {
  const saved = removeEmptyNativeObject(document(`{\n  "shell": "keep",\n  "experimental": {\n    // note\n  }\n}\n`), ["experimental"])!
  assert.match(saved, /\/\/ note/)
  assert.deepEqual(parse(saved), { shell: "keep" })
  assert.equal(removeEmptyNativeObject(document(`{ "experimental": {} }`), ["experimental"])?.includes("experimental"), false)
})

test("only an object without properties is removed", () => {
  for (const text of [`{}`, `{ "experimental": { "subagent_depth": 2 } }`, `{ "experimental": [] }`])
    assert.equal(removeEmptyNativeObject(document(text), ["experimental"]), undefined, text)
  assert.throws(() => removeEmptyNativeObject(document(`{ "experimental": {}, "experimental": {} }`), ["experimental"]), /duplicate/)
})
