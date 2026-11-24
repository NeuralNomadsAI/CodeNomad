import assert from "node:assert/strict"
import test from "node:test"
import { Context, Effect } from "effect"
import { controlNativeRecurrence } from "./native-recurrence-control"

test("an unverified Play fails before native graph or schedule writes", async () => {
  const ctx = { get storage() { throw new Error("Unexpected native storage access") },
    get location() { throw new Error("Unexpected native Location access") } }
  await assert.rejects(Effect.runPromiseWith(Context.empty())(controlNativeRecurrence(ctx as never, {
    sessionID: "cookie", workspaceID: "workspace", requestID: "request_one", location: { directory: "/selected" },
    digest: "0".repeat(64),
    scheduleID: "daily_review", expectedRevision: 0, action: "play", issuedAt: Date.now(),
    profileSource: { profileID: "a".repeat(64), executionHost: "local", configYamlPath: "/selected/config.yaml" },
    proof: "0".repeat(64),
  })), (error: unknown) => (error as { cause?: Error }).cause?.message === "Recurrence transport authentication failed")
})
