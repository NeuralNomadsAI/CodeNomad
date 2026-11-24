import assert from "node:assert/strict"
import { test } from "node:test"
import { getOrCreateTextModel } from "./model-cache"

// Mirrors Monaco 0.52: getValue() omits a BOM and setValue() always bumps the version.
function fakeMonaco() {
  const writes: string[] = []
  const monaco = {
    Uri: { parse: (value: string) => value },
    editor: {
      createModel: (initial: string) => {
        let text = initial, version = 1
        return {
          getValue: () => text.replace(/^﻿/, ""),
          getVersionId: () => version,
          setValue: (value: string) => { writes.push(value); text = value; version++ },
          edit: (value: string) => { text = value; version++ },
          dispose: () => {},
        }
      },
    },
  }
  return { monaco, writes }
}

test("identical raw text is not rewritten, even when Monaco normalizes it", () => {
  const { monaco, writes } = fakeMonaco()
  const read = (value: string) => getOrCreateTextModel({ monaco, cacheKey: "bom", value, languageId: "plaintext" })
  const model = read("﻿same\n")
  assert.equal(read("﻿same\n"), model)
  assert.deepEqual(writes, [], "a reload of identical text keeps the model version")
  read("﻿changed\n")
  assert.deepEqual(writes, ["﻿changed\n"], "changed text is applied")
})

test("an edited model keeps comparing its current text", () => {
  const { monaco, writes } = fakeMonaco()
  const read = (value: string) => getOrCreateTextModel({ monaco, cacheKey: "edited", value, languageId: "plaintext" })
  const model = read("saved\n")
  model.edit("draft\n")
  read("draft\n")
  assert.deepEqual(writes, [], "content matching the edit (for example after saving) keeps the edit history")
  model.edit("another draft\n")
  read("draft\n")
  assert.deepEqual(writes, ["draft\n"], "external content replaces a diverged edit as before")
})
