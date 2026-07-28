import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  parseWorkflowDefinition,
  validateWorkflowDefinition,
  WORKFLOW_DEFINITION_REVISION_LIMIT,
  WORKFLOW_LIMITS,
} from "./definition-schema"
import { validateJsonSchemaValue } from "./json-schema"

describe("workflow definition schema", () => {
  it("parses canonical YAML without executable tags", () => {
    const parsed = parseWorkflowDefinition(`
version: 1
id: safe
name: Safe workflow
root:
  type: agent
  id: work
  instructions: Do the work
  tools: [read]
  outputSchema:
    type: object
    required: [result]
    properties:
      result: { type: string }
`)
    assert.equal(parsed.definition.root.type, "agent")
    assert.equal(parsed.canonical, parseWorkflowDefinition(parsed.canonical).canonical)
    assert.equal(validateWorkflowDefinition("value: !!js/function function() {}" ).valid, false)
  })

  it("rejects duplicate IDs and statically excessive dynamic expansion", () => {
    const duplicate = validateWorkflowDefinition({
      version: 1, id: "duplicate", name: "Duplicate",
      root: { type: "sequence", id: "root", steps: [
        { type: "agent", id: "same", instructions: "One" },
        { type: "agent", id: "same", instructions: "Two" },
      ] },
    })
    assert.equal(duplicate.valid, false)

    const expansion = validateWorkflowDefinition({
      version: 1, id: "large", name: "Large", maxExpandedNodes: WORKFLOW_LIMITS.expandedNodes,
      root: {
        type: "foreach", id: "outer", item: "outerItem", maxItems: 101, items: [],
        body: {
          type: "repeat", id: "inner", maxIterations: 100,
          body: { type: "agent", id: "work", instructions: "Work" },
        },
      },
    })
    assert.equal(expansion.valid, false)

    assert.equal(validateWorkflowDefinition({
      version: 1, id: "unsafe-retry", name: "Unsafe retry",
      root: { type: "shell", id: "deploy", agent: "build", command: "deploy", retry: { maxAttempts: 2 } },
    }).valid, false)
  })

  it("accepts saved workflow calls with bounded input values", () => {
    const result = validateWorkflowDefinition({
      version: 1, id: "caller", name: "Caller",
      root: {
        type: "workflow", id: "nested", definitionId: "saved", definitionRevision: 2,
        inputs: { environment: "test", payload: { $ref: "inputs.payload" } },
      },
    })
    assert.equal(result.valid, true)
    assert.equal(validateWorkflowDefinition({
      version: 1, id: "bad-caller", name: "Bad caller",
      root: { type: "workflow", id: "nested", definitionId: "../saved" },
    }).valid, false)
    assert.equal(validateWorkflowDefinition({
      version: 1, id: "future-caller", name: "Future caller",
      root: {
        type: "workflow", id: "nested", definitionId: "saved",
        definitionRevision: WORKFLOW_DEFINITION_REVISION_LIMIT + 1,
      },
    }).valid, false)
  })

  it("requires portable lowercase saved definition IDs", () => {
    assert.equal(validateWorkflowDefinition({
      version: 1, id: "CaseCollision", name: "Uppercase definition",
      root: { type: "agent", id: "work", instructions: "Work" },
    }).valid, false)
    assert.equal(validateWorkflowDefinition({
      version: 1, id: "lowercase-id", name: "Lowercase definition",
      root: { type: "workflow", id: "CallNode", definitionId: "UppercaseTarget" },
    }).valid, false)
    assert.equal(validateWorkflowDefinition({
      version: 1, id: "lowercase-id", name: "Lowercase definition",
      root: { type: "workflow", id: "CallNode", definitionId: "lowercase-target" },
    }).valid, true)
  })

  it("accepts only the JSON schema subset enforced at runtime", () => {
    const definition = (outputSchema: Record<string, unknown>) => ({
      version: 1, id: "schema", name: "Schema",
      root: { type: "agent", id: "work", instructions: "Work", outputSchema },
    })
    assert.equal(validateWorkflowDefinition(definition({
      type: "object",
      required: ["result"],
      properties: { result: { type: "string", minLength: 1 } },
      additionalProperties: false,
    })).valid, true)
    assert.equal(validateWorkflowDefinition(definition({ enum: [null, false, 0, "0", [], {}] })).valid, true)

    for (const outputSchema of [
      { type: "string", pattern: "^(a+)+$" },
      { type: "string", format: "email" },
      { type: "object", properties: { value: { $ref: "#/definitions/value" } } },
      { type: "mystery" },
      { items: true },
      { additionalProperties: { type: "string" } },
      { enum: [] },
      { enum: ["same", "same"] },
      { enum: [{ left: 1, right: 2 }, { right: 2, left: 1 }] },
    ]) assert.equal(validateWorkflowDefinition(definition(outputSchema)).valid, false)
  })

  it("enforces closed objects even when no properties are declared", () => {
    const closed = { type: "object", additionalProperties: false }
    assert.deepEqual(validateJsonSchemaValue({}, closed), [])
    assert.deepEqual(validateJsonSchemaValue({ unexpected: true }, closed), ["$.unexpected is not allowed"])
    assert.deepEqual(validateJsonSchemaValue({ value: 1 }, {
      type: "object", properties: { value: { type: "integer" } }, additionalProperties: false,
    }), [])
    assert.deepEqual(validateJsonSchemaValue({ ordered: { right: 2, left: 1 } }, {
      const: { ordered: { left: 1, right: 2 } },
    }), [])
    assert.deepEqual(validateJsonSchemaValue("😀", { minLength: 1, maxLength: 1 }), [])
  })
})
