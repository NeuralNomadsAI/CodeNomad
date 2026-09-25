import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { PROMPT_INLINE_FILE_LIMITS } from "../api-types"
import { validatePromptAttachmentBudget } from "./prompt-attachment-budget"

const promptPath = "/api/session/session-1/prompt"
const dataUri = (bytes: number) =>
  `data:application/octet-stream;base64,${Buffer.alloc(bytes).toString("base64")}`

describe("prompt attachment budget", () => {
  it("accepts each documented boundary", () => {
    const maxFile = dataUri(PROMPT_INLINE_FILE_LIMITS.maxFileBytes)
    assert.deepEqual(validatePromptAttachmentBudget(promptPath, "POST", {
      files: Array.from({ length: 4 }, () => ({ uri: maxFile })),
    }), { ok: true })
    assert.deepEqual(validatePromptAttachmentBudget(promptPath, "POST", {
      files: Array.from({ length: PROMPT_INLINE_FILE_LIMITS.maxFiles }, () => ({ uri: dataUri(1) })),
    }), { ok: true })
  })

  it("rejects per-file, aggregate, and count overages", () => {
    assert.deepEqual(validatePromptAttachmentBudget(promptPath, "POST", {
      files: [{ uri: dataUri(PROMPT_INLINE_FILE_LIMITS.maxFileBytes + 1) }],
    }), { ok: false, reason: "limit" })

    const fourMegabytes = dataUri(4 * 1024 * 1024)
    assert.deepEqual(validatePromptAttachmentBudget(promptPath, "POST", {
      files: [
        ...Array.from({ length: 5 }, () => ({ uri: fourMegabytes })),
        { uri: dataUri(1) },
      ],
    }), { ok: false, reason: "limit" })
    assert.deepEqual(validatePromptAttachmentBudget(promptPath, "POST", {
      files: Array.from({ length: PROMPT_INLINE_FILE_LIMITS.maxFiles + 1 }, () => ({ uri: dataUri(1) })),
    }), { ok: false, reason: "limit" })
  })

  it("rejects malformed inline data without affecting path-backed files or unrelated routes", () => {
    assert.deepEqual(validatePromptAttachmentBudget(promptPath, "POST", {
      files: [{ uri: "data:text/plain;base64,%%%" }],
    }), { ok: false, reason: "invalid-data-uri" })
    assert.deepEqual(validatePromptAttachmentBudget(promptPath, "POST", {
      files: [{ uri: "file:///repo/readme.md" }, { uri: "https://example.com/file.txt" }],
    }), { ok: true })
    assert.deepEqual(validatePromptAttachmentBudget("/api/session/session-1/message", "POST", {
      files: [{ uri: "data:text/plain;base64,%%%" }],
    }), { ok: true })
  })
})
