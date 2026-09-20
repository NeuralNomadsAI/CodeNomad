import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { PROMPT_INLINE_FILE_LIMITS } from "../../../../server/src/api-types"
import type { Attachment } from "../../types/attachment"
import { getInlineFileUsage, readDeviceFileSelection } from "./device-file-selection"

const file = (name: string, size: number) => ({ name, size }) as File
const inlineAttachment = (base64: string): Attachment => ({
  id: `attachment-${base64}`,
  type: "file",
  display: "@existing.bin",
  url: `data:application/octet-stream;base64,${base64}`,
  filename: "existing.bin",
  mediaType: "application/octet-stream",
  source: { type: "file", path: "existing.bin", mime: "application/octet-stream" },
})

describe("device file selection", () => {
  it("reads accepted files sequentially and preserves picker order", async () => {
    const calls: string[] = []
    let activeReads = 0
    let peakReads = 0
    const result = await readDeviceFileSelection(
      [file("first.txt", 2), file("second.txt", 3)],
      [],
      () => true,
      async (selected) => {
        calls.push(selected.name)
        activeReads += 1
        peakReads = Math.max(peakReads, activeReads)
        await Promise.resolve()
        activeReads -= 1
        return new Uint8Array(selected.size)
      },
    )
    assert.deepEqual(calls, ["first.txt", "second.txt"])
    assert.equal(peakReads, 1)
    assert.deepEqual(result.files.map(({ file }) => file.name), ["first.txt", "second.txt"])
    assert.deepEqual({ ...result, files: [] }, {
      files: [], tooLargeCount: 0, overBudgetCount: 0, unreadableCount: 0, stale: false,
    })
  })

  it("rejects per-file, aggregate, and count excess before reading", async () => {
    const reads: string[] = []
    const selected = [
      ...Array.from({ length: 4 }, (_, index) => file(`accepted-${index}.bin`, PROMPT_INLINE_FILE_LIMITS.maxFileBytes)),
      file("over-total.bin", 1),
      file("over-file.bin", PROMPT_INLINE_FILE_LIMITS.maxFileBytes + 1),
    ]
    const result = await readDeviceFileSelection(selected, [], () => true, async (item) => {
      reads.push(item.name)
      return new Uint8Array(item.size)
    })
    assert.deepEqual(reads, selected.slice(0, 4).map((item) => item.name))
    assert.equal(result.overBudgetCount, 1)
    assert.equal(result.tooLargeCount, 1)

    const countReads: string[] = []
    const countResult = await readDeviceFileSelection(
      Array.from({ length: PROMPT_INLINE_FILE_LIMITS.maxFiles + 1 }, (_, index) => file(`${index}.bin`, 1)),
      [],
      () => true,
      async (item) => {
        countReads.push(item.name)
        return new Uint8Array(1)
      },
    )
    assert.equal(countReads.length, PROMPT_INLINE_FILE_LIMITS.maxFiles)
    assert.equal(countResult.overBudgetCount, 1)
  })

  it("counts existing inline data and ignores path-backed files", () => {
    const pathAttachment = { ...inlineAttachment("AQ=="), url: "file:///repo/existing.bin" }
    assert.deepEqual(getInlineFileUsage([inlineAttachment("AQID"), pathAttachment]), { count: 1, bytes: 3 })
  })

  it("aggregates read failures and discards a stale batch", async () => {
    const unreadable = await readDeviceFileSelection(
      [file("bad.bin", 1), file("good.bin", 2)],
      [],
      () => true,
      async (selected) => {
        if (selected.name === "bad.bin") throw new Error("unreadable")
        return new Uint8Array(selected.size)
      },
    )
    assert.equal(unreadable.unreadableCount, 1)
    assert.deepEqual(unreadable.files.map(({ file }) => file.name), ["good.bin"])

    let current = true
    const stale = await readDeviceFileSelection(
      [file("late.bin", 1), file("never-read.bin", 1)],
      [],
      () => current,
      async () => {
        current = false
        return new Uint8Array(1)
      },
    )
    assert.equal(stale.stale, true)
    assert.deepEqual(stale.files, [])
  })
})
