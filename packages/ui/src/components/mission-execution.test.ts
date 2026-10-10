import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  describeMissionExecution,
  missionExecutionField,
  type MissionExecutionSession,
} from "./mission-execution-model.ts"

const task = (execution?: { agent?: string; model?: { providerID: string; id: string; variant?: string } }) => ({
  execution,
  actorSessionId: "ses-1",
})

const session = (value: MissionExecutionSession | undefined) => value

describe("describeMissionExecution", () => {
  for (const marker of [{ executionMode: { kind: "native" as const } }, { nativeBinding: { generation: 1 } }]) {
    it("keeps native invocation provenance unknown even when mutable session settings match", () => {
      const view = describeMissionExecution({ ...task({ agent: "build", model: { providerID: "native", id: "model", variant: "high" } }), ...marker },
        session({ agent: "build", model: { providerId: "native", modelId: "model" } }))
      assert.equal(view.pinned, true)
      for (const field of [view.agent, view.model, view.variant]) {
        assert.equal(field.current, undefined)
        assert.equal(field.observed, "unknown")
        assert.equal(field.match, "unverified")
      }
    })
  }

  it("retains independent root session selection comparisons", () => {
    const view = describeMissionExecution({ ...task({ agent: "build" }), executionMode: { kind: "independent" } }, session({ agent: "build" }))
    assert.equal(view.agent.match, "matches")
  })
  it("treats an omitted selection as the native default instead of a specific model", () => {
    const view = describeMissionExecution(task(undefined), session({ agent: "build", model: { providerId: "opencode", modelId: "native" } }))

    assert.equal(view.pinned, false)
    assert.equal(view.agent.request, "native-default")
    assert.equal(view.agent.requested, undefined)
    assert.equal(view.agent.observed, "known")
    // The runtime picked this default; the contract never named it, so agreement
    // cannot be asserted even though a value happens to be visible.
    assert.equal(view.agent.match, "unverified")
    assert.equal(view.model.match, "unverified")
  })

  it("keeps a partially pinned request honest per field", () => {
    const view = describeMissionExecution(
      task({ agent: "build" }),
      session({ agent: "build", model: { providerId: "opencode", modelId: "native" } }),
    )

    assert.equal(view.pinned, true)
    assert.equal(view.agent.request, "pinned")
    assert.equal(view.agent.current, "build")
    assert.equal(view.agent.match, "matches")
    // Agent was pinned, the model was not: it must not inherit the agent verdict.
    assert.equal(view.model.request, "native-default")
    assert.equal(view.model.requested, undefined)
    assert.equal(view.model.match, "unverified")
  })

  it("reports a request the live session does not satisfy without reconfiguring it", () => {
    const view = describeMissionExecution(
      task({ model: { providerID: "openai", id: "gpt-6-luna", variant: "high" } }),
      session({ agent: "build", model: { providerId: "openai", modelId: "gpt-6-astra" } }),
    )

    assert.equal(view.model.requested, "openai/gpt-6-luna")
    assert.equal(view.model.current, "openai/gpt-6-astra")
    assert.equal(view.model.match, "differs")
    assert.equal(view.variant.requested, "high")
  })

  it("marks a missing actor session unknown rather than inheriting the request", () => {
    const view = describeMissionExecution(
      task({ agent: "build", model: { providerID: "openai", id: "gpt-6-luna" } }),
      session(undefined),
    )

    assert.equal(view.agent.current, undefined)
    assert.equal(view.agent.observed, "unknown")
    assert.equal(view.agent.match, "unverified")
    assert.equal(view.model.observed, "unknown")
  })

  it("never confirms a requested variant, because the client session has no variant", () => {
    const view = describeMissionExecution(
      task({ model: { providerID: "openai", id: "gpt-6-luna", variant: "high" } }),
      session({ agent: "build", model: { providerId: "openai", modelId: "gpt-6-luna" } }),
    )

    assert.equal(view.model.match, "matches")
    assert.equal(view.variant.requested, "high")
    assert.equal(view.variant.current, undefined)
    assert.equal(view.variant.observed, "unknown")
    assert.equal(view.variant.match, "unverified")
  })

  it("treats blank session fields as unknown instead of empty selections", () => {
    const view = describeMissionExecution(
      task({ agent: "build" }),
      session({ agent: "   ", model: { providerId: "", modelId: "" } }),
    )

    assert.equal(view.agent.observed, "unknown")
    assert.equal(view.agent.current, undefined)
    assert.equal(view.model.observed, "unknown")
    assert.equal(view.model.requested, undefined)
  })
})

describe("missionExecutionField", () => {
  it("trims requested and current identifiers", () => {
    const field = missionExecutionField("  build  ", " build ")

    assert.equal(field.requested, "build")
    assert.equal(field.current, "build")
    assert.equal(field.match, "matches")
  })
})
