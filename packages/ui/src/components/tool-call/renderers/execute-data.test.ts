import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { executeOutputForRender } from "./execute-data"

describe("Code Mode output rendering", () => {
  it("indents a compact JSON object or array result", () => {
    assert.deepEqual(executeOutputForRender('{"a":1,"b":[true,null]}'), { text: '{\n  "a": 1,\n  "b": [\n    true,\n    null\n  ]\n}', language: "json" })
    assert.deepEqual(executeOutputForRender("[1,2]"), { text: "[\n  1,\n  2\n]", language: "json" })
  })

  it("keeps already indented results stable", () => {
    const pretty = '{\n  "a": 1\n}'
    assert.deepEqual(executeOutputForRender(pretty), { text: pretty, language: "json" })
  })

  it("keeps warning and log blocks after the indented result", () => {
    assert.deepEqual(executeOutputForRender('{"a":1}\n\nWarnings:\n- [unawaited] call\n\nLogs:\nhello'),
      { text: '{\n  "a": 1\n}\n\nWarnings:\n- [unawaited] call\n\nLogs:\nhello' })
  })

  it("leaves strings, scalars, errors and oversized output to the shared rendering", () => {
    for (const output of ["plain text", "42", "null", '"quoted"', "{not json", "Error: boom\n\nLogs:\nx", undefined, 7, `[${"1,".repeat(120_000)}1]`]) {
      assert.equal(executeOutputForRender(output), null, String(output).slice(0, 40))
    }
  })
})
