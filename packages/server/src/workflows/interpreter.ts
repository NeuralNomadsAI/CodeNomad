import { randomUUID } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client"
import type {
  WorkflowCondition,
  WorkflowBudget,
  WorkflowExecutionNode,
  WorkflowNode,
  WorkflowRun,
  WorkflowUsage,
  WorkflowValue,
} from "../api-types"
import { WORKFLOW_LIMITS } from "./definition-schema"
import { validateJsonSchemaValue } from "./json-schema"

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1_000
const MAX_OUTPUT_CHARS = 16_000
const MAX_RUN_OUTPUT_CHARS = 4_000_000
const MAX_CONTEXT_BYTES = 256_000
const MAX_CONTEXT_VALUES = 50_000
const SAFE_AGENT_TOOL_IDS = new Set(["read", "glob", "grep", "lsp"])

export class WorkflowSuspendedError extends Error {}
export class WorkflowBudgetError extends Error {}
class WorkflowAmbiguousSideEffectError extends Error {}

export interface WorkflowInterpreterOptions {
  run: WorkflowRun
  client: OpencodeClient
  persist: () => Promise<void>
  signal: (timeoutMs: number) => AbortSignal
  sessionStarted: (sessionId: string) => boolean
  sessionFinished: (sessionId: string) => void
  abortSession: (sessionId: string) => Promise<boolean>
  isCancelled: () => boolean
  isPauseCommitted?: () => boolean
}

interface ExecutionContext {
  vars: Record<string, unknown>
  inputs: Record<string, unknown>
  budgets: WorkflowBudget[]
  limiters: ActionLimiter[]
  definitionInvocationKey: string
  instanceKey?: string
}

interface ActionLimiter {
  max: number
  active: number
  waiters: Array<{
    resolve: () => void
    reject: (reason?: unknown) => void
    signal: AbortSignal
    abort: () => void
  }>
}

interface ActionResult {
  output: unknown
  sessionId: string
}

const emptyUsage = (): WorkflowUsage => ({
  cost: 0,
  tokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
})

export class WorkflowInterpreter {
  private readonly run: WorkflowRun
  private readonly nodes: WorkflowExecutionNode[]
  private expanded = 0
  private outputChars = 0
  private readonly schedulerAbort = new AbortController()
  private readonly maxConcurrency: number
  private readonly rootLimiter: ActionLimiter
  private readonly budgetLimiters = new Map<string, ActionLimiter>()
  private readonly savedDefinitionKeys: Set<string>

  constructor(private readonly options: WorkflowInterpreterOptions) {
    this.run = options.run
    this.nodes = this.run.executionNodes ??= []
    this.run.usage ??= emptyUsage()
    this.expanded = this.nodes.length
    this.outputChars = this.nodes.reduce((total, node) => total + (node.output === undefined ? 0 : JSON.stringify(node.output).length), 0)
    this.maxConcurrency = this.run.definitionSnapshot?.maxConcurrency ?? 1
    this.rootLimiter = { max: this.maxConcurrency, active: 0, waiters: [] }
    this.savedDefinitionKeys = new Set((this.run.savedDefinitionSnapshots ?? []).map((snapshot) => `${snapshot.id}@${snapshot.revision}`))
  }

  async execute(): Promise<void> {
    const definition = this.run.definitionSnapshot
    if (!definition) throw new Error("Workflow definition snapshot is missing")
    if (!this.run.rootSessionId) {
      const root = await this.requireData(this.options.client.session.create({
        ...(this.run.initiatorSessionId ? { parentID: this.run.initiatorSessionId } : {}),
        title: `Workflow: ${this.run.objective.slice(0, 80)}`,
        metadata: this.sessionMetadata("workflow"),
      }, { signal: this.operationSignal(DEFAULT_TIMEOUT_MS) }), "create workflow session")
      this.options.sessionStarted(root.id)
      try {
        this.throwIfCancelled()
        this.run.rootSessionId = root.id
        await this.options.persist()
        this.options.sessionFinished(root.id)
      } catch (error) {
        if (!await this.options.abortSession(root.id)) {
          throw new WorkflowAmbiguousSideEffectError(`Workflow root session abort was not confirmed: ${this.errorMessage(error)}`)
        }
        this.options.sessionFinished(root.id)
        throw error
      }
    }
    const definitionInvocationKey = `${this.run.definitionId}@${this.run.definitionRevision}`
    await this.executeNode(definition.root, definition.root.id, {
      vars: {},
      inputs: this.run.inputs ?? {},
      budgets: definition.budget ? [definition.budget] : [],
      // ponytail: usage is observed after actions, so budgeted actions serialize until nodes declare reservable maxima.
      limiters: [this.rootLimiter, ...(definition.budget ? [this.budgetLimiter(definitionInvocationKey)] : [])],
      definitionInvocationKey,
    })
  }

  private async executeNode(node: WorkflowNode, instanceKey: string, context: ExecutionContext, parentInstanceKey?: string): Promise<unknown> {
    this.throwIfCancelled()
    const existing = this.nodes.find((candidate) => candidate.instanceKey === instanceKey)
    if (existing?.status === "completed" || existing?.status === "skipped") return existing.output
    await this.pauseIfRequested()

    const execution = existing ?? this.addExecution(node, instanceKey, context.definitionInvocationKey, parentInstanceKey)
    const scopedContext = { ...context, instanceKey }
    if (node.if !== undefined && !this.evaluateCondition(node.if, scopedContext)) {
      execution.status = "skipped"
      execution.completedAt = new Date().toISOString()
      await this.options.persist()
      return undefined
    }

    execution.status = "running"
    execution.startedAt ??= new Date().toISOString()
    delete execution.error
    await this.options.persist()

    let actionSessionId: string | undefined
    try {
      let output: unknown
      switch (node.type) {
        case "sequence":
          output = await this.executeSequence(node.steps, instanceKey, scopedContext)
          break
        case "parallel":
          output = await this.executeParallel(node.branches, instanceKey, scopedContext, node.maxConcurrency)
          break
        case "foreach":
          output = await this.executeForeach(node, instanceKey, scopedContext)
          break
        case "repeat":
          output = await this.executeRepeat(node, instanceKey, scopedContext)
          break
        case "condition": {
          const selected = this.evaluateCondition(node.condition, scopedContext) ? node.then : node.else
          output = selected ? await this.executeNode(selected, `${instanceKey}/${selected.id}`, scopedContext, instanceKey) : undefined
          break
        }
        case "gate":
          return await this.executeGate(node, execution)
        case "agent":
          ({ output, sessionId: actionSessionId } = await this.executeAgent(node, execution, scopedContext))
          break
        case "shell":
          ({ output, sessionId: actionSessionId } = await this.executeShell(node, execution, scopedContext))
          break
        case "workflow":
          output = await this.executeSavedWorkflow(node, instanceKey, scopedContext)
          break
      }
      const structural = !["agent", "shell", "gate"].includes(node.type)
      const bounded = this.boundOutput(output, structural)
      if (bounded.truncated) throw new Error(`Workflow node ${node.id} output exceeds ${MAX_OUTPUT_CHARS} characters`)
      const outputChars = output === undefined ? 0 : JSON.stringify(output).length
      if (this.outputChars + outputChars > MAX_RUN_OUTPUT_CHARS) throw new Error("Workflow run output limit exceeded")
      this.outputChars += outputChars
      execution.output = bounded.output
      execution.status = "completed"
      execution.completedAt = new Date().toISOString()
      await this.options.persist()
      if (actionSessionId) this.options.sessionFinished(actionSessionId)
      return output
    } catch (caught) {
      let error = caught
      if (actionSessionId) {
        if (await this.options.abortSession(actionSessionId)) {
          this.options.sessionFinished(actionSessionId)
          this.forgetSession(execution, actionSessionId)
        }
        else error = new WorkflowAmbiguousSideEffectError(`Workflow session abort was not confirmed: ${this.errorMessage(error)}`)
      }
      if (error instanceof WorkflowSuspendedError) {
        execution.status = "waiting"
        await this.options.persist()
      } else if (error instanceof WorkflowAmbiguousSideEffectError) {
        execution.status = "interrupted"
        execution.error = this.errorMessage(error)
        execution.completedAt = new Date().toISOString()
        await this.options.persist()
      } else if (!this.options.isCancelled()) {
        execution.status = "failed"
        execution.error = this.errorMessage(error)
        execution.completedAt = new Date().toISOString()
        await this.options.persist()
      }
      throw error
    }
  }

  private async executeSequence(steps: WorkflowNode[], parent: string, context: ExecutionContext): Promise<unknown> {
    let output: unknown
    for (const child of steps) output = await this.executeNode(child, `${parent}/${child.id}`, context, parent)
    return output
  }

  private async executeParallel(branches: WorkflowNode[], parent: string, context: ExecutionContext, concurrency?: number): Promise<unknown[]> {
    return this.mapBounded(branches, concurrency, (branch) =>
      this.executeNode(branch, `${parent}/${branch.id}`, {
        vars: { ...context.vars }, inputs: context.inputs, budgets: context.budgets, limiters: context.limiters,
        definitionInvocationKey: context.definitionInvocationKey,
      }, parent))
  }

  private async executeForeach(node: Extract<WorkflowNode, { type: "foreach" }>, parent: string, context: ExecutionContext): Promise<unknown[]> {
    const value = this.resolveValue(node.items, context)
    if (!Array.isArray(value)) throw new Error(`Foreach node ${node.id} items must resolve to an array`)
    if (value.length > node.maxItems) throw new Error(`Foreach node ${node.id} exceeded maxItems ${node.maxItems}`)
    return this.mapBounded(value, node.maxConcurrency, (item, index) => this.executeNode(
      node.body,
      `${parent}/${node.body.id}[${index}]`,
      {
        vars: { ...context.vars, [node.item]: item, [`${node.item}Index`]: index },
        inputs: context.inputs, budgets: context.budgets, limiters: context.limiters,
        definitionInvocationKey: context.definitionInvocationKey,
      },
      parent,
    ))
  }

  private async executeRepeat(node: Extract<WorkflowNode, { type: "repeat" }>, parent: string, context: ExecutionContext): Promise<unknown[]> {
    const output: unknown[] = []
    for (let index = 0; index < node.maxIterations; index += 1) {
      const iterationContext = {
        vars: { ...context.vars, iteration: index }, inputs: context.inputs, budgets: context.budgets, limiters: context.limiters,
        definitionInvocationKey: context.definitionInvocationKey, instanceKey: context.instanceKey,
      }
      if (node.while !== undefined && !this.evaluateCondition(node.while, iterationContext)) break
      output.push(await this.executeNode(node.body, `${parent}/${node.body.id}[${index}]`, iterationContext, parent))
    }
    return output
  }

  private async executeGate(node: Extract<WorkflowNode, { type: "gate" }>, execution: WorkflowExecutionNode): Promise<unknown> {
    if (execution.status === "completed") return execution.output
    if (this.run.pendingGate && this.run.pendingGate.executionNodeId !== execution.id) throw new WorkflowSuspendedError()
    execution.status = "waiting"
    this.run.pendingGate = {
      executionNodeId: execution.id,
      definitionNodeId: node.id,
      gate: node.gate,
      prompt: node.prompt,
      ...(node.inputSchema ? { inputSchema: node.inputSchema } : {}),
    }
    this.run.status = node.gate === "approval" ? "waiting_for_review" : "waiting_for_input"
    await this.options.persist()
    throw new WorkflowSuspendedError()
  }

  private async executeAgent(
    node: Extract<WorkflowNode, { type: "agent" }>,
    execution: WorkflowExecutionNode,
    context: ExecutionContext,
  ): Promise<ActionResult> {
    const signal = this.operationSignal(node.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    const contextValue = node.context === undefined ? undefined : this.resolveContext(node.context, context, signal)
    const prompt = [
      `Workflow node: ${node.title ?? node.id}`,
      "",
      `Objective:\n${this.run.objective}`,
      "",
      `Instructions:\n${node.instructions}`,
      ...(contextValue === undefined ? [] : ["", `Context:\n${JSON.stringify(contextValue, null, 2)}`]),
    ].join("\n")
    return this.withActionPermit(context.limiters, signal, async () => {
      this.enforceActionAdmission(context.budgets)
      const tools = await this.toolOverrides(node.tools ?? [], signal)
      return this.retry(node.retry?.maxAttempts ?? 1, node.retry?.delayMs ?? 0, execution, context.budgets, signal, async () => {
        const sessionId = await this.createChildSession(node, execution, signal)
      try {
        const response = await this.requireData(this.options.client.session.prompt({
          sessionID: sessionId,
          ...(node.agent ? { agent: node.agent } : {}),
          ...(node.model ? { model: node.model } : {}),
          tools,
          ...(node.outputSchema ? { format: { type: "json_schema" as const, schema: node.outputSchema, retryCount: 2 } } : {}),
          parts: [{ type: "text", text: prompt }],
        }, { signal }), `run ${node.id} session`)
        this.observeUsage(response.info, execution, context.budgets)
        if (response.info.error) throw new Error(this.errorMessage(response.info.error))
        if (node.outputSchema) {
          if (response.info.structured === undefined) throw new Error(`Structured output is missing for ${node.id}`)
          const issues = validateJsonSchemaValue(response.info.structured, node.outputSchema)
          if (issues.length) throw new Error(`Structured output is invalid for ${node.id}: ${issues.join("; ")}`)
          return { output: response.info.structured, sessionId }
        }
        return { output: response.parts.filter((part) => part.type === "text").map((part) => part.text).join("\n"), sessionId }
      } catch (error) {
        if (await this.options.abortSession(sessionId)) {
          this.options.sessionFinished(sessionId)
          this.forgetSession(execution, sessionId)
        }
        else throw new WorkflowAmbiguousSideEffectError(`Workflow session abort was not confirmed: ${this.errorMessage(error)}`)
        throw error
      }
      })
    })
  }

  private async executeShell(
    node: Extract<WorkflowNode, { type: "shell" }>,
    execution: WorkflowExecutionNode,
    context: ExecutionContext,
  ): Promise<ActionResult> {
    const signal = this.operationSignal(node.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    return this.withActionPermit(context.limiters, signal, () => this.retry(
      node.retry?.maxAttempts ?? 1, node.retry?.delayMs ?? 0, execution, context.budgets, signal, async () => {
      this.enforceActionAdmission(context.budgets)
      const sessionId = await this.createChildSession(node, execution, signal)
      try {
        const response = await this.requireData(this.options.client.session.shell({
          sessionID: sessionId,
          agent: node.agent,
          command: node.command,
          ...(node.model ? { model: node.model } : {}),
        }, { signal }), `run ${node.id} shell`)
        this.observeUsage(response.info, execution, context.budgets)
        if ("error" in response.info && response.info.error) throw new Error(this.errorMessage(response.info.error))
        const toolParts = response.parts.filter((part) => part.type === "tool")
        const toolError = toolParts.find((part) => part.state.status === "error")
        if (toolError?.state.status === "error") throw new Error(toolError.state.error)
        const output = toolParts.filter((part) => part.state.status === "completed")
          .map((part) => part.state.status === "completed" ? part.state.output : "").join("\n")
        return { output: output || response.parts.filter((part) => part.type === "text").map((part) => part.text).join("\n"), sessionId }
      } catch (error) {
        if (await this.options.abortSession(sessionId)) {
          this.options.sessionFinished(sessionId)
          this.forgetSession(execution, sessionId)
        }
        else throw new WorkflowAmbiguousSideEffectError(`Workflow session abort was not confirmed: ${this.errorMessage(error)}`)
        throw error
      }
    }))
  }

  private async executeSavedWorkflow(
    node: Extract<WorkflowNode, { type: "workflow" }>,
    instanceKey: string,
    context: ExecutionContext,
  ): Promise<unknown> {
    const snapshot = this.run.savedDefinitionSnapshots?.find((candidate) =>
      candidate.id === node.definitionId && candidate.revision === node.definitionRevision)
    if (!snapshot) throw new Error(`Saved workflow snapshot ${node.definitionId}@${node.definitionRevision ?? "unresolved"} is missing`)
    const inputs = Object.fromEntries(Object.entries(node.inputs ?? {}).map(([key, value]) => [key, this.resolveValue(value, context)]))
    const root = snapshot.definition.root
    const definitionInvocationKey = `${instanceKey}/${snapshot.id}@${snapshot.revision}`
    return this.executeNode(root, `${definitionInvocationKey}/${root.id}`, {
      vars: {},
      inputs,
      budgets: snapshot.definition.budget ? [...context.budgets, snapshot.definition.budget] : context.budgets,
      limiters: [
        ...context.limiters,
        this.actionLimiter(snapshot.definition.maxConcurrency ?? 1),
        ...(snapshot.definition.budget ? [this.budgetLimiter(`${snapshot.id}@${snapshot.revision}`)] : []),
      ],
      definitionInvocationKey,
    }, instanceKey)
  }

  private async createChildSession(
    node: Extract<WorkflowNode, { type: "agent" | "shell" }>,
    execution: WorkflowExecutionNode,
    signal: AbortSignal,
  ): Promise<string> {
    this.throwIfCancelled()
    const session = await this.requireData(this.options.client.session.create({
      parentID: this.run.rootSessionId,
      title: `${node.title ?? node.id}: ${this.run.objective.slice(0, 60)}`,
      ...(node.agent ? { agent: node.agent } : {}),
      metadata: this.sessionMetadata(node.id),
    }, { signal }), `create ${node.id} session`)
    execution.sessionIds ??= []
    execution.sessionIds.push(session.id)
    const accepted = this.options.sessionStarted(session.id)
    try {
      if (!accepted) this.throwIfCancelled()
      signal.throwIfAborted()
      await this.options.persist()
      signal.throwIfAborted()
    } catch (error) {
      if (await this.options.abortSession(session.id)) {
        this.options.sessionFinished(session.id)
        this.forgetSession(execution, session.id)
      }
      else throw new WorkflowAmbiguousSideEffectError(`Workflow session abort was not confirmed: ${this.errorMessage(error)}`)
      throw error
    }
    return session.id
  }

  private async retry<T>(
    attempts: number,
    delayMs: number,
    execution: WorkflowExecutionNode,
    budgets: WorkflowBudget[],
    signal: AbortSignal,
    operation: () => Promise<T>,
  ): Promise<T> {
    let lastError: unknown = new Error("Workflow retry limit was already exhausted")
    for (let attempt = execution.attempt + 1; attempt <= attempts; attempt += 1) {
      signal.throwIfAborted()
      this.enforceActionAdmission(budgets)
      execution.attempt = attempt
      await this.options.persist()
      signal.throwIfAborted()
      try {
        return await operation()
      } catch (error) {
        lastError = error
        if (error instanceof WorkflowAmbiguousSideEffectError || error instanceof WorkflowBudgetError) throw error
        this.throwIfCancelled()
        signal.throwIfAborted()
        this.enforceActionAdmission(budgets)
        if (attempt < attempts && delayMs) await this.sleep(delayMs, signal)
      }
    }
    throw lastError
  }

  private async mapBounded<T, R>(items: T[], requested: number | undefined, operation: (item: T, index: number) => Promise<R>): Promise<R[]> {
    const concurrency = Math.min(requested ?? this.maxConcurrency, this.maxConcurrency, WORKFLOW_LIMITS.concurrency, items.length || 1)
    const results = new Array<R>(items.length)
    let next = 0
    let suspended: WorkflowSuspendedError | undefined
    let failed: unknown
    const workers = Array.from({ length: concurrency }, async () => {
      while (next < items.length && !suspended && failed === undefined) {
        const index = next++
        try {
          results[index] = await operation(items[index]!, index)
        } catch (error) {
          if (error instanceof WorkflowSuspendedError) suspended = error
          else if (failed === undefined) { failed = error; this.schedulerAbort.abort(error) }
        }
      }
    })
    await Promise.all(workers)
    if (failed !== undefined) throw failed
    if (suspended) throw suspended
    return results
  }

  private addExecution(
    node: WorkflowNode,
    instanceKey: string,
    definitionInvocationKey: string,
    parentInstanceKey?: string,
  ): WorkflowExecutionNode {
    const limit = this.run.definitionSnapshot?.maxExpandedNodes ?? WORKFLOW_LIMITS.expandedNodes
    if (++this.expanded > limit) throw new Error(`Workflow exceeded expanded node limit ${limit}`)
    const execution: WorkflowExecutionNode = {
      id: randomUUID(),
      instanceKey,
      definitionInvocationKey,
      definitionNodeId: node.id,
      type: node.type,
      status: "pending",
      attempt: 0,
      ...(parentInstanceKey ? { parentInstanceKey } : {}),
    }
    this.nodes.push(execution)
    return execution
  }

  private resolveValue(value: WorkflowValue, context: ExecutionContext, visit?: () => void): unknown {
    visit?.()
    if (Array.isArray(value)) return value.map((item) => this.resolveValue(item, context, visit))
    if (!value || typeof value !== "object") return value
    if (Object.prototype.hasOwnProperty.call(value, "$ref") && typeof value.$ref === "string") return this.resolveRef(value.$ref, context)
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.resolveValue(item, context, visit)]))
  }

  private resolveContext(value: WorkflowValue, context: ExecutionContext, signal: AbortSignal): unknown {
    const resolved = this.resolveValue(value, context, () => signal.throwIfAborted())
    const pending: Array<{ value: unknown; exit?: boolean }> = [{ value: resolved }]
    const ancestors = new WeakSet<object>()
    let count = 0
    while (pending.length) {
      signal.throwIfAborted()
      const { value: current, exit } = pending.pop()!
      if (exit) {
        ancestors.delete(current as object)
        continue
      }
      if (++count > MAX_CONTEXT_VALUES) throw new Error(`Workflow context exceeds ${MAX_CONTEXT_VALUES} values`)
      if (!current || typeof current !== "object") continue
      if (ancestors.has(current)) throw new Error("Workflow context contains a cycle")
      ancestors.add(current)
      pending.push({ value: current, exit: true })
      pending.push(...Object.values(current).reverse().map((value) => ({ value })))
    }
    const serialized = JSON.stringify(resolved)
    if (serialized !== undefined && Buffer.byteLength(serialized, "utf8") > MAX_CONTEXT_BYTES) {
      throw new Error(`Workflow context exceeds ${MAX_CONTEXT_BYTES} bytes`)
    }
    return resolved
  }

  private resolveRef(ref: string, context: ExecutionContext): unknown {
    const [root, name, ...path] = ref.split(".")
    let value: unknown
    if (root === "inputs" && Object.prototype.hasOwnProperty.call(context.inputs, name)) value = context.inputs[name!]
    else if (root === "vars" && Object.prototype.hasOwnProperty.call(context.vars, name)) value = context.vars[name!]
    else if (root === "nodes") {
      const candidates = this.nodes.filter((node) => node.definitionNodeId === name && node.status === "completed"
        && this.executionDefinitionInvocationKey(node) === context.definitionInvocationKey).reverse()
      value = candidates.sort((left, right) => this.commonPrefix(right.instanceKey, context.instanceKey ?? "")
        - this.commonPrefix(left.instanceKey, context.instanceKey ?? "")).at(0)
    }
    for (const part of path) {
      if (!value || typeof value !== "object" || !Object.prototype.hasOwnProperty.call(value, part)) return undefined
      value = (value as Record<string, unknown>)[part]
    }
    return value
  }

  private evaluateCondition(condition: WorkflowCondition, context: ExecutionContext): boolean {
    if (typeof condition === "boolean") return condition
    const actual = this.resolveValue(condition.value, context)
    if (condition.equals !== undefined) return this.equal(actual, this.resolveValue(condition.equals, context))
    if (condition.notEquals !== undefined) return !this.equal(actual, this.resolveValue(condition.notEquals, context))
    if (condition.exists !== undefined) return (actual !== undefined) === condition.exists
    return Boolean(actual) === (condition.truthy ?? true)
  }

  private equal(left: unknown, right: unknown): boolean {
    return isDeepStrictEqual(left, right)
  }

  private commonPrefix(left: string, right: string): number {
    let index = 0
    while (index < left.length && left[index] === right[index]) index += 1
    return index
  }

  private observeUsage(info: unknown, execution: WorkflowExecutionNode, budgets: WorkflowBudget[]) {
    if (!info || typeof info !== "object"
      || !Object.prototype.hasOwnProperty.call(info, "cost")
      || !Object.prototype.hasOwnProperty.call(info, "tokens")) return
    const message = info as { cost?: number; tokens?: { total?: number; input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } } }
    const number = (value: unknown, field: string) => {
      if (value === undefined) return 0
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new Error(`Workflow SDK usage ${field} must be finite and non-negative`)
      }
      return value
    }
    if (!message.tokens || typeof message.tokens !== "object") throw new Error("Workflow SDK usage tokens must be an object")
    const inputTokens = number(message.tokens.input, "tokens.input")
    const outputTokens = number(message.tokens.output, "tokens.output")
    const reasoningTokens = number(message.tokens.reasoning, "tokens.reasoning")
    const cacheReadTokens = number(message.tokens.cache?.read, "tokens.cache.read")
    const cacheWriteTokens = number(message.tokens.cache?.write, "tokens.cache.write")
    const add = (left: number, right: number, field: string) => {
      if (!Number.isFinite(left) || left < 0 || !Number.isFinite(right) || right < 0) {
        throw new Error(`Workflow usage ${field} must be finite and non-negative`)
      }
      const total = left + right
      if (!Number.isFinite(total)) throw new Error(`Workflow usage ${field} overflowed`)
      return total
    }
    const usage: WorkflowUsage = {
      cost: number(message.cost, "cost"),
      tokens: message.tokens.total === undefined
        ? [outputTokens, reasoningTokens, cacheReadTokens, cacheWriteTokens]
          .reduce((total, value) => add(total, value, "tokens.total"), inputTokens)
        : number(message.tokens.total, "tokens.total"),
      inputTokens,
      outputTokens,
      reasoningTokens,
      cacheReadTokens,
      cacheWriteTokens,
    }
    const nextUsage = emptyUsage()
    for (const key of Object.keys(usage) as Array<keyof WorkflowUsage>) {
      nextUsage[key] = add(this.run.usage![key], usage[key], key)
    }
    execution.usage = usage
    this.run.usage = nextUsage
    try {
      this.enforceObservedBudget(budgets)
    } catch (error) {
      this.schedulerAbort.abort(error)
      throw error
    }
  }

  private async toolOverrides(allowed: string[], signal: AbortSignal): Promise<Record<string, boolean>> {
    for (const id of allowed) {
      if (!SAFE_AGENT_TOOL_IDS.has(id)) throw new Error(`Workflow agent tool ${id} is not allowed`)
    }
    const ids = await this.requireData(
      this.options.client.tool.ids(undefined, { signal }),
      "list workflow tools",
    )
    const installed = new Set(ids)
    const overrides: Record<string, boolean> = { "*": false, ...Object.fromEntries(ids.map((id) => [id, false])) }
    for (const id of allowed) {
      if (!installed.has(id)) throw new Error(`Workflow agent tool ${id} is unavailable`)
      overrides[id] = true
    }
    return overrides
  }

  private operationSignal(timeoutMs: number): AbortSignal {
    return AbortSignal.any([this.options.signal(timeoutMs), this.schedulerAbort.signal])
  }

  private async withActionPermit<T>(limiters: ActionLimiter[], signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    const acquired: ActionLimiter[] = []
    try {
      for (const limiter of limiters) {
        await this.acquirePermit(limiter, signal)
        acquired.push(limiter)
        signal.throwIfAborted()
        this.throwIfCancelled()
        await this.pauseIfRequested()
      }
      return await operation()
    } finally {
      for (const limiter of acquired.reverse()) this.releasePermit(limiter)
    }
  }

  private async acquirePermit(limiter: ActionLimiter, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (limiter.active < limiter.max && limiter.waiters.length === 0) {
      limiter.active += 1
      return
    }
    await new Promise<void>((resolve, reject) => {
      const waiter = { resolve, reject, signal, abort: () => undefined as void }
      waiter.abort = () => {
        const index = limiter.waiters.indexOf(waiter)
        if (index >= 0) limiter.waiters.splice(index, 1)
        reject(signal.reason)
      }
      limiter.waiters.push(waiter)
      signal.addEventListener("abort", waiter.abort, { once: true })
      if (signal.aborted) waiter.abort()
    })
  }

  private releasePermit(limiter: ActionLimiter): void {
    while (limiter.waiters.length) {
      const waiter = limiter.waiters.shift()!
      waiter.signal.removeEventListener("abort", waiter.abort)
      if (waiter.signal.aborted) {
        waiter.reject(waiter.signal.reason)
        continue
      }
      waiter.resolve()
      return
    }
    limiter.active -= 1
  }

  private async sleep(delayMs: number, signal: AbortSignal): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(signal.reason) }
      const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve() }, delayMs)
      signal.addEventListener("abort", abort, { once: true })
    })
  }

  private actionLimiter(max: number): ActionLimiter {
    return { max, active: 0, waiters: [] }
  }

  private budgetLimiter(key: string): ActionLimiter {
    const existing = this.budgetLimiters.get(key)
    if (existing) return existing
    const limiter = this.actionLimiter(1)
    this.budgetLimiters.set(key, limiter)
    return limiter
  }

  private executionDefinitionInvocationKey(execution: WorkflowExecutionNode): string {
    if (execution.definitionInvocationKey) return execution.definitionInvocationKey
    const segments = execution.instanceKey.split("/")
    const saved = segments.map((segment, index) => ({ segment, index }))
      .filter(({ segment }) => this.savedDefinitionKeys.has(segment)).at(-1)
    return saved ? segments.slice(0, saved.index + 1).join("/") : `${this.run.definitionId}@${this.run.definitionRevision}`
  }

  private forgetSession(execution: WorkflowExecutionNode, sessionId: string): void {
    if (!execution.sessionIds) return
    execution.sessionIds = execution.sessionIds.filter((candidate) => candidate !== sessionId)
    if (execution.sessionIds.length === 0) delete execution.sessionIds
  }

  private enforceActionAdmission(budgets: WorkflowBudget[]) {
    for (const budget of budgets) {
      if (budget.maxCost !== undefined && this.run.usage!.cost >= budget.maxCost) {
        throw new WorkflowBudgetError(`Workflow reached cost budget ${budget.maxCost}`)
      }
      if (budget.maxTokens !== undefined && this.run.usage!.tokens >= budget.maxTokens) {
        throw new WorkflowBudgetError(`Workflow reached token budget ${budget.maxTokens}`)
      }
    }
  }

  private enforceObservedBudget(budgets: WorkflowBudget[]) {
    // ponytail: providers report usage after an action, so one admitted action can overshoot; no estimate is invented.
    for (const budget of budgets) {
      if (budget.maxCost !== undefined && this.run.usage!.cost > budget.maxCost) {
        throw new WorkflowBudgetError(`Workflow exceeded cost budget ${budget.maxCost}`)
      }
      if (budget.maxTokens !== undefined && this.run.usage!.tokens > budget.maxTokens) {
        throw new WorkflowBudgetError(`Workflow exceeded token budget ${budget.maxTokens}`)
      }
    }
  }

  private async pauseIfRequested() {
    if (!this.run.pauseRequested || this.options.isPauseCommitted?.() === false) return
    throw new WorkflowSuspendedError()
  }

  private throwIfCancelled() {
    if (this.options.isCancelled()) throw new Error("Workflow run cancelled")
  }

  private boundOutput(output: unknown, structural = false): { output: unknown; truncated: boolean } {
    if (output === undefined) return { output: undefined, truncated: false }
    if (structural) return { output, truncated: false }
    if (typeof output === "string") return output.length <= MAX_OUTPUT_CHARS
      ? { output, truncated: false }
      : { output: output.slice(0, MAX_OUTPUT_CHARS), truncated: true }
    const serialized = JSON.stringify(output)
    return serialized.length <= MAX_OUTPUT_CHARS
      ? { output, truncated: false }
      : { output: serialized.slice(0, MAX_OUTPUT_CHARS), truncated: true }
  }

  private sessionMetadata(role: string) {
    return { codenomad: { version: 1, workflow: { runId: this.run.id, role } } }
  }

  private async requireData<T>(request: Promise<{ data?: T; error?: unknown }>, action: string): Promise<T> {
    const response = await request
    if (response.data !== undefined) return response.data
    throw new Error(`${action} failed: ${this.errorMessage(response.error)}`)
  }

  private errorMessage(error: unknown): string {
    if (error instanceof Error) return error.message
    if (typeof error === "string") return error
    try { return JSON.stringify(error) || "Unknown error" } catch { return "Unknown error" }
  }
}
