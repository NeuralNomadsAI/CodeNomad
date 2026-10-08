import assert from "node:assert/strict"
import test from "node:test"
import { passageFixture } from "./native-passage-test-fixture"
import { passageStartInput, passageSourceCursors } from "../../missions/recurrence-input"

test("watched context is bounded untrusted data; cursor excludes oversized decision reference", async () => {
  const f = await passageFixture()
  try {
    const doc = (await f.calendar.read("schedule"))!
    doc.config.watchedConversationIDs = ["ses_watched"]
    const sources = [{ conversationID: "ses_watched", directory: f.root, afterMessageID: null,
      messages: [{ id: "msg_source", type: "user" as const, text: "untrusted source", nativeDigest: "a".repeat(64) },
        { id: "msg_large", type: "user" as const, text: "", nativeDigest: "b".repeat(64), needsDecision: "source-input-capacity" as const }] }]
    assert.match(passageStartInput(doc, f.passage, sources).text, /untrusted source data/)
    assert.equal(passageSourceCursors(sources)[0].messageID, "msg_source")
    assert.throws(() => passageStartInput(doc, f.passage, [{ ...sources[0], messages: [{ ...sources[0].messages[0], text: "x".repeat(100_000) }] }]))
  } finally { await f.dispose() }
})
