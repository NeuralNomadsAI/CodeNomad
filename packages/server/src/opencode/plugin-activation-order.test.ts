import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { definedBefore, enabledThrough, type AppliedEntry, type AppliedSequence } from "./plugin-activation-order"

// Each document is a list of entries: "-x" removes, "pkg=id" is a source defining a verified ID, anything else adds.
function sequence(documents: string[][], startIds: string[] = []): AppliedSequence {
  const entries: AppliedEntry[] = documents.flatMap((entries, document) => entries.map((entry, entryIndex) => {
    const [target, pluginId] = entry.split("=")
    return entry.startsWith("-") ? { document, entryIndex, remove: true, target: entry.slice(1) }
      : { document, entryIndex, remove: false, target: target!, ...(pluginId ? { pluginId } : {}) }
  }))
  return { entries, startIds: new Set(startIds) }
}

describe("OpenCode applied plugin order", () => {
  it("applies a remove only to plugins defined before it, wildcards included", () => {
    assert.equal(enabledThrough(sequence([["-a.id", "pkg=a.id"]]), "a.id", 0), true, "a remove before the definition is inert")
    assert.equal(enabledThrough(sequence([["pkg=a.id", "-*"]]), "a.id", 0), false)
    assert.equal(enabledThrough(sequence([["pkg=a.id", "-a.*", "a.id"]]), "a.id", 0), true)
    assert.equal(enabledThrough(sequence([["pkg=a.id"], ["-a.id"]]), "a.id", 0), true, "later documents are outside the prefix")
    assert.equal(enabledThrough(sequence([["pkg=a.id"], ["-a.id"]]), "a.id", 1), false)
  })

  it("assumes an ID without a verified definition in the prefix is defined first", () => {
    assert.equal(enabledThrough(sequence([["unverified", "-*", "-a.id"]]), "a.id", 0), false)
    assert.equal(enabledThrough(sequence([["unverified"]]), "a.id", 0), true)
  })

  it("places verified definitions where they are declared, start IDs and opencode.* before everything", () => {
    const applied = sequence([["-a.id"], ["pkg=a.id", "a.id"]], ["dir.id"])
    assert.equal(definedBefore(applied, "a.id", 0, 1), false, "a bare ID in the first document would be a package spec")
    assert.equal(definedBefore(applied, "a.id", 1, 1), true)
    assert.equal(definedBefore(applied, "a.id", 1, 1, applied.entries[1]), false, "excluding the removed source")
    assert.equal(definedBefore(applied, "dir.id", 0, 0), true)
    assert.equal(definedBefore(applied, "opencode.x", 0, 0), true)
  })
})
