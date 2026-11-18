import assert from "node:assert/strict"
import test from "node:test"
import { validMissionContentSlice } from "./mission-content-slice"

test("shared slice validation requires exact selector, digest and contiguous finite progress", () => {
  const selector = { kind: "change", field: "objective", change: 3 } as const
  const slice = { ...selector, digest: "exact", offset: 0, characters: 4, text: "ab", next: 2 }
  assert.equal(validMissionContentSlice(selector, { offset: 0, digest: "exact" }, slice), slice)
  for (const change of [{ taskKey: "foreign" }, { reportId: "foreign" }, { change: 4 }, { digest: "other" },
    { offset: -1 }, { characters: NaN }, { characters: -1 }, { next: 0 }, { next: 1 }, { next: 4 }, { text: "", next: 0 }]) {
    assert.throws(() => validMissionContentSlice(selector, { offset: 0, digest: "exact" }, { ...slice, ...change }), /Invalid/)
  }
  assert.throws(() => validMissionContentSlice(selector, { offset: 0 }, undefined), /Invalid/)
  assert.equal(validMissionContentSlice(selector, { offset: 0 }, { ...slice, characters: 0, text: "", next: undefined }).text, "")
})
