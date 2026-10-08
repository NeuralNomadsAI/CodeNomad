import assert from "node:assert/strict"
import test from "node:test"
import { Context, Effect } from "effect"
import { controlNativeRecurrence } from "./native-recurrence-control"
import { recurrenceHumanRequestID } from "../../missions/recurrence-authority-contract"

test("Play with a missing native admission graph fails before signer or schedule writes", async () => {
  const ctx = { get storage() { throw new Error("Unexpected native storage access") },
    get location() { throw new Error("Unexpected native Location access") } }
  await assert.rejects(Effect.runPromiseWith(Context.empty())(controlNativeRecurrence(ctx as never, {
    sessionID: "cookie", workspaceID: "workspace", requestID: recurrenceHumanRequestID("daily_review", 1, "authorize"), location: { directory: "/selected" },
    digest: "0".repeat(64),
    scheduleID: "daily_review", expectedRevision: 0, expectedEpoch: 0, action: "play", issuedAt: Date.now(),
    profileSource: { profileID: "a".repeat(64), executionHost: "local", configYamlPath: "/selected/config.yaml" },
    proof: "0".repeat(64),
  })), /Native Missions service unavailable/)
})
