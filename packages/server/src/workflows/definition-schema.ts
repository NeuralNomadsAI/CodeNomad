import { parseDocument } from "yaml"
import { z } from "zod"
import type {
  WorkflowCondition,
  WorkflowDefinitionV1,
  WorkflowNode,
  WorkflowValue,
} from "../api-types"
import { inspectJsonSchema } from "./json-schema"

export const WORKFLOW_DEFINITION_REVISION_LIMIT = 100

export const WORKFLOW_LIMITS = {
  sourceBytes: 256_000,
  staticNodes: 256,
  expandedNodes: 10_000,
  depth: 24,
  branchWidth: 32,
  concurrency: 16,
  foreachItems: 1_000,
  repeatIterations: 1_000,
  retries: 5,
  nestingDepth: 8,
  timeoutMs: 24 * 60 * 60 * 1_000,
  schemaBytes: 32_000,
  valueDepth: 20,
} as const

const IdSchema = z.string().trim().min(1).max(100).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/)
const DefinitionIdSchema = z.string().trim().min(1).max(100).regex(
  /^[a-z0-9][a-z0-9_-]*$/,
  "Definition IDs must start with a lowercase letter or number and contain only lowercase letters, numbers, hyphens, or underscores",
)
const TitleSchema = z.string().trim().min(1).max(200)
const ModelSchema = z.object({
  providerID: z.string().trim().min(1).max(200),
  modelID: z.string().trim().min(1).max(200),
}).strict()
const RefSchema = z.object({
  $ref: z.string().regex(/^(inputs|nodes|vars)(?:\.[a-zA-Z0-9_-]+)+$/).max(500),
}).strict()

export const WorkflowValueSchema: z.ZodType<WorkflowValue> = z.lazy(() => z.union([
  z.null(),
  z.boolean(),
  z.number().finite(),
  z.string().max(50_000),
  RefSchema,
  z.array(WorkflowValueSchema).max(WORKFLOW_LIMITS.foreachItems),
  z.record(WorkflowValueSchema),
]))

export const WorkflowConditionSchema: z.ZodType<WorkflowCondition> = z.union([
  z.boolean(),
  z.object({
    value: WorkflowValueSchema,
    equals: WorkflowValueSchema.optional(),
    notEquals: WorkflowValueSchema.optional(),
    exists: z.boolean().optional(),
    truthy: z.boolean().optional(),
  }).strict().superRefine((condition, ctx) => {
    const operators = [condition.equals, condition.notEquals, condition.exists, condition.truthy]
      .filter((value) => value !== undefined)
    if (operators.length > 1) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Condition accepts one operator" })
  }),
])

const RetrySchema = z.object({
  maxAttempts: z.number().int().min(1).max(WORKFLOW_LIMITS.retries),
  delayMs: z.number().int().min(0).max(60_000).optional(),
  idempotent: z.boolean().optional(),
}).strict().superRefine((retry, ctx) => {
  if (retry.maxAttempts > 1 && retry.idempotent !== true) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Retries require idempotent: true" })
  }
})

const JsonSchema = z.record(z.unknown()).superRefine((value, ctx) => {
  try {
    const serialized = JSON.stringify(value)
    if (Buffer.byteLength(serialized, "utf8") > WORKFLOW_LIMITS.schemaBytes) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "JSON schema is too large" })
    }
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "JSON schema must be JSON serializable" })
  }
  for (const issue of inspectJsonSchema(value)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: issue.message, path: issue.path })
  }
})

const NodeBase = {
  id: IdSchema,
  title: TitleSchema.optional(),
  if: WorkflowConditionSchema.optional(),
}

export const WorkflowNodeSchema: z.ZodType<WorkflowNode> = z.lazy(() => z.union([
  z.object({ ...NodeBase, type: z.literal("sequence"), steps: z.array(WorkflowNodeSchema).min(1).max(WORKFLOW_LIMITS.branchWidth) }).strict(),
  z.object({
    ...NodeBase,
    type: z.literal("parallel"),
    branches: z.array(WorkflowNodeSchema).min(1).max(WORKFLOW_LIMITS.branchWidth),
    maxConcurrency: z.number().int().min(1).max(WORKFLOW_LIMITS.concurrency).optional(),
  }).strict(),
  z.object({
    ...NodeBase,
    type: z.literal("foreach"),
    items: WorkflowValueSchema,
    item: IdSchema,
    body: WorkflowNodeSchema,
    maxItems: z.number().int().min(1).max(WORKFLOW_LIMITS.foreachItems),
    maxConcurrency: z.number().int().min(1).max(WORKFLOW_LIMITS.concurrency).optional(),
  }).strict(),
  z.object({
    ...NodeBase,
    type: z.literal("repeat"),
    body: WorkflowNodeSchema,
    maxIterations: z.number().int().min(1).max(WORKFLOW_LIMITS.repeatIterations),
    while: WorkflowConditionSchema.optional(),
    onExhausted: z.enum(["complete", "fail"]).optional(),
  }).strict(),
  z.object({
    ...NodeBase,
    type: z.literal("agent"),
    instructions: z.string().trim().min(1).max(50_000),
    context: WorkflowValueSchema.optional(),
    sessionKey: IdSchema.optional(),
    agent: z.string().trim().min(1).max(200).optional(),
    model: ModelSchema.optional(),
    tools: z.array(z.string().trim().min(1).max(200)).max(128).refine((tools) => new Set(tools).size === tools.length, "Tool IDs must be unique").optional(),
    outputSchema: JsonSchema.optional(),
    retry: RetrySchema.optional(),
    timeoutMs: z.number().int().min(1).max(WORKFLOW_LIMITS.timeoutMs).optional(),
  }).strict(),
  z.object({
    ...NodeBase,
    type: z.literal("shell"),
    command: z.string().trim().min(1).max(50_000),
    agent: z.string().trim().min(1).max(200),
    model: ModelSchema.optional(),
    retry: RetrySchema.optional(),
    timeoutMs: z.number().int().min(1).max(WORKFLOW_LIMITS.timeoutMs).optional(),
  }).strict(),
  z.object({
    ...NodeBase,
    type: z.literal("gate"),
    gate: z.enum(["approval", "input"]),
    prompt: z.string().trim().min(1).max(20_000),
    inputSchema: JsonSchema.optional(),
  }).strict().superRefine((gate, ctx) => {
    if (gate.gate === "approval" && gate.inputSchema) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Approval gates do not accept inputSchema", path: ["inputSchema"] })
    }
  }),
  z.object({
    ...NodeBase,
    type: z.literal("workflow"),
    definitionId: DefinitionIdSchema,
    definitionRevision: z.number().int().min(1).max(WORKFLOW_DEFINITION_REVISION_LIMIT).optional(),
    inputs: z.record(WorkflowValueSchema).optional(),
  }).strict(),
  z.object({
    ...NodeBase,
    type: z.literal("condition"),
    condition: WorkflowConditionSchema,
    then: WorkflowNodeSchema,
    else: WorkflowNodeSchema.optional(),
  }).strict(),
]) as unknown as z.ZodType<WorkflowNode>)

const DefinitionSchemaBase = z.object({
  version: z.literal(1),
  id: DefinitionIdSchema,
  name: TitleSchema,
  description: z.string().trim().max(2_000).optional(),
  root: WorkflowNodeSchema,
  budget: z.object({
    maxCost: z.number().finite().positive().max(1_000_000).optional(),
    maxTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  }).strict().refine((budget) => budget.maxCost !== undefined || budget.maxTokens !== undefined, "Budget cannot be empty").optional(),
  maxConcurrency: z.number().int().min(1).max(WORKFLOW_LIMITS.concurrency).optional(),
  maxExpandedNodes: z.number().int().min(1).max(WORKFLOW_LIMITS.expandedNodes).optional(),
}).strict()

const inspectTree = (node: WorkflowNode, state: { ids: Set<string>; count: number; estimated: number }, depth: number): string[] => {
  const issues: string[] = []
  state.count += 1
  if (depth > WORKFLOW_LIMITS.depth) issues.push(`Node ${node.id} exceeds maximum depth ${WORKFLOW_LIMITS.depth}`)
  if (state.ids.has(node.id)) issues.push(`Node ID ${node.id} is duplicated`)
  state.ids.add(node.id)

  let children: WorkflowNode[] = []
  let multiplier = 1
  if (node.type === "sequence") children = node.steps
  else if (node.type === "parallel") children = node.branches
  else if (node.type === "foreach") { children = [node.body]; multiplier = node.maxItems }
  else if (node.type === "repeat") { children = [node.body]; multiplier = node.maxIterations }
  else if (node.type === "condition") children = [node.then, ...(node.else ? [node.else] : [])]

  const before = state.estimated
  state.estimated += 1
  for (const child of children) issues.push(...inspectTree(child, state, depth + 1))
  if (multiplier > 1) state.estimated += (state.estimated - before - 1) * (multiplier - 1)
  return issues
}

export const WorkflowDefinitionSchema: z.ZodType<WorkflowDefinitionV1> = DefinitionSchemaBase.superRefine((definition, ctx) => {
  const state = { ids: new Set<string>(), count: 0, estimated: 0 }
  for (const message of inspectTree(definition.root, state, 1)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message, path: ["root"] })
  }
  if (state.count > WORKFLOW_LIMITS.staticNodes) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Definition exceeds ${WORKFLOW_LIMITS.staticNodes} static nodes`, path: ["root"] })
  }
  const expandedLimit = definition.maxExpandedNodes ?? WORKFLOW_LIMITS.expandedNodes
  if (state.estimated > expandedLimit) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Definition can expand to ${state.estimated} nodes, above limit ${expandedLimit}`, path: ["root"] })
  }
})

const sortJson = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortJson)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [
    key,
    sortJson((value as Record<string, unknown>)[key]),
  ]))
}

export interface ParsedWorkflowDefinition {
  definition: WorkflowDefinitionV1
  canonical: string
}

const inspectInput = (input: unknown) => {
  const pending = [{ value: input, depth: 0 }]
  const seen = new WeakSet<object>()
  let values = 0
  while (pending.length) {
    const { value, depth } = pending.pop()!
    if (++values > 50_000) throw new Error("Workflow definition has too many values")
    if (depth > WORKFLOW_LIMITS.depth * 3) throw new Error("Workflow definition is too deeply nested")
    if (value === null || typeof value === "string" || typeof value === "boolean") continue
    if (typeof value === "number" && Number.isFinite(value)) continue
    if (!value || typeof value !== "object") throw new Error("Workflow definition must contain only JSON values")
    if (seen.has(value)) throw new Error("Workflow definition cannot contain cycles")
    seen.add(value)
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new Error("Workflow definition must contain only plain JSON objects")
    }
    for (const child of Object.values(value)) pending.push({ value: child, depth: depth + 1 })
  }
}

export function parseWorkflowDefinition(source: string | unknown): ParsedWorkflowDefinition {
  let input = source
  if (typeof source === "string") {
    if (Buffer.byteLength(source, "utf8") > WORKFLOW_LIMITS.sourceBytes) throw new Error("Workflow definition source is too large")
    const document = parseDocument(source, { schema: "core", uniqueKeys: true })
    if (document.errors.length) throw new Error(document.errors.map((error) => error.message).join("; "))
    input = document.toJS({ maxAliasCount: 0 })
  }
  inspectInput(input)
  if (Buffer.byteLength(JSON.stringify(input), "utf8") > WORKFLOW_LIMITS.sourceBytes) {
    throw new Error("Workflow definition source is too large")
  }
  const definition = WorkflowDefinitionSchema.parse(input)
  return { definition, canonical: `${JSON.stringify(sortJson(definition), null, 2)}\n` }
}

export function validateWorkflowDefinition(source: string | unknown) {
  try {
    return { valid: true as const, ...parseWorkflowDefinition(source) }
  } catch (error) {
    if (error instanceof z.ZodError) return { valid: false as const, issues: error.issues }
    return { valid: false as const, issues: [{ code: "custom", path: [], message: error instanceof Error ? error.message : String(error) }] }
  }
}
