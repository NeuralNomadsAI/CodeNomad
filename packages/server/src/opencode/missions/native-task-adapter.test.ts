import assert from "node:assert/strict"
import test from "node:test"
import type { Plugin } from "@opencode/plugin"
import type * as Tool from "@opencode/plugin/promise/tool"
import type { Registration } from "@opencode/plugin/promise/registration"
import { taskContractReferenceWireSchema } from "../../missions/native-wire-schema"
import { installNativeTaskAdapter, type NativeTaskAdmissions, type NativeTaskFailure,
  type NativeTaskInvocation, type NativeTaskReference } from "./native-task-adapter"

// Deterministic official-shaped executor/editor, NOT a private native runtime or
// a genuine host-qualification test. The production seam cannot issue authority;
// signed native host + journal + ENV integration remains a separate gate.
const mission: NativeTaskReference = { missionID: "mission-one", taskKey: "implementation", generation: 1 }
const child = "ses_actual_child"
const nativeInput = {
  description: "Bound work", prompt: "Do work", agent: "worker", model: { providerID: "openai", id: "model", variant: "high" },
  maxDepth: 3, confirmation: true, background: false,
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function context(id = "call_native", sessionID = "ses_owner", messageID = "msg_actual_assistant"): Tool.ToolContext {
  return { sessionID: sessionID as Tool.ToolContext["sessionID"], messageID: messageID as Tool.ToolContext["messageID"],
    id: id as Tool.ToolContext["id"], agent: "coordinator" as Tool.ToolContext["agent"],
    signal: new AbortController().signal, progress: async () => {} }
}

type Claim = { readonly sequence: number }
type Bound = { readonly childSessionID: string; readonly claim: Claim }

async function fixture(execute?: Tool.Info["execute"]) {
  const progress: Tool.Metadata[] = []
  const order: string[] = []
  const invocations: NativeTaskInvocation[] = []
  const failures: NativeTaskFailure<Claim, Bound>[] = []
  const executions: Array<{ input: unknown; context: Tool.ToolContext }> = []
  const result: Tool.Result = { content: [{ type: "text", text: "native output" },
    { type: "file", mime: "image/png", uri: "data:image/png;base64,AAAA", name: "native.png" }],
    output: { native: "untouched" }, metadata: { sessionID: child } }
  const original: Tool.Info = {
    name: "subagent", description: "Native permissions, depth, agent/model selection and confirmation stay here",
    input: { type: "object", properties: {
      description: { type: "string" }, prompt: { type: "string" }, agent: { type: "string" },
      model: { type: "object" }, maxDepth: { type: "integer" }, confirmation: { type: "boolean" },
      sessionID: { type: "string" }, background: { type: "boolean" },
    }, required: ["description", "prompt"], additionalProperties: false, $comment: "native schema untouched" },
    output: { type: "object", properties: { native: { type: "string" } } },
    options: { codemode: true, pinned: true, permission: "subagent" },
    execute: async (input, tool) => {
      order.push("native"); executions.push({ input, context: tool })
      if (execute) return execute(input, tool)
      await tool.progress({ sessionID: child, status: "running", nativeExtra: { untouched: true } })
      order.push("native-prompt") // Native (not adapter) owns the prompt after awaited progress.
      return result
    },
  }
  let current = original
  let policyCurrent = true
  let sequence = 0
  const durableClaims = new Set<string>()
  const admissions: NativeTaskAdmissions<Claim, Bound> = {
    assertCurrent: () => { if (!policyCurrent) throw new Error("trusted owner revoked") },
    reserve: async (invocation, fence) => {
      fence.assertCurrent(); order.push("reserve"); invocations.push(invocation)
      // This is a test double's reservation, not a production qualification.
      if (durableClaims.has(invocation.id)) throw new Error("durable capacity refused")
      durableClaims.add(invocation.id)
      return { scope: "owned", claim: { sequence: ++sequence } }
    },
    guardContinuation: async (_invocation, _reservation, sessionID, fence) => {
      fence.assertCurrent(); order.push("continuation")
      if (sessionID !== child) throw new Error("exact ended child required")
    },
    bindActualChild: async (_invocation, reservation, sessionID, fence) => {
      fence.assertCurrent(); order.push("signed-binding+journal")
      order.push("fresh-env"); fence.assertCurrent()
      return { childSessionID: sessionID, claim: reservation.claim }
    },
    launchReturned: async (_invocation, _reservation, _bound, _result, fence) => {
      fence.assertCurrent(); order.push("launch-return")
    },
    returned: async (invocation, _reservation, _bound, _result, fence) => {
      fence.assertCurrent(); order.push("foreground-return"); durableClaims.delete(invocation.id)
    },
    failureObserved: async failure => { failures.push(failure); order.push("failure-observed") },
  }
  const editor: Tool.ToolEditor = {
    get: id => id === "subagent" ? { ...current, id } : undefined,
    list: () => [{ ...current, id: "subagent" }], namespace: () => {},
    add: () => { throw new Error("Adapter must not add a tool") },
    update: (id, update) => {
      assert.equal(id, "subagent")
      const draft = { ...current }
      update(draft); current = draft
    },
    remove: () => { throw new Error("Adapter must not remove native tools") },
  }
  let transform: ((editor: Tool.ToolEditor) => void) | undefined
  const ctx: Pick<Plugin.Context, "tool"> = { tool: {
    transform: async callback => { transform = callback; callback(editor); return {
      dispose: async () => { order.push("registration-dispose"); current = original },
    } },
    list: async () => [{ ...current, id: "subagent" }],
    reload: async () => { current = original; transform?.(editor) },
    hook: async () => { throw new Error("Final tool/model gates are not installed by this seam") },
  } }
  const registration = await installNativeTaskAdapter(ctx, admissions)
  const captured = current
  const invoke = (input: unknown = { ...nativeInput, mission }, tool = context()) => captured.execute(input,
    { ...tool, progress: async update => { order.push("forward-progress"); progress.push(update); await tool.progress(update) } })
  return { original, captured, admissions, registration, ctx, progress, order, invocations, failures, executions, result,
    durableClaims, invoke, revoke: () => { policyCurrent = false } }
}

test("official editor preserves every native field/schema/options; direct and Code Mode use one executor/signal", async () => {
  const f = await fixture()
  for (const key of Object.keys(f.original) as Array<keyof Tool.Info>) {
    if (key !== "input" && key !== "execute") assert.equal(f.captured[key], f.original[key])
  }
  const before = f.original.input as Record<string, unknown>
  const after = f.captured.input as Record<string, unknown>
  for (const key of Object.keys(before)) {
    if (key !== "properties") assert.equal(after[key], before[key])
  }
  const properties = after.properties as Record<string, unknown>
  for (const [key, value] of Object.entries(before.properties as Record<string, unknown>)) assert.equal(properties[key], value)
  assert.equal("mission" in (before.properties as Record<string, unknown>), false)
  assert.equal(properties.mission, taskContractReferenceWireSchema)
  const tool = context()
  assert.equal(await f.invoke(undefined, tool), f.result)
  assert.equal(f.executions[0].context.signal, tool.signal)
  assert.deepEqual(f.executions[0].input, nativeInput)
  assert.deepEqual(f.invocations[0], { sessionID: tool.sessionID, messageID: tool.messageID, id: tool.id, agent: tool.agent,
    nativeInput, mission })
  // Code Mode's catalog captures Tool.Info.execute, not an alternate path.
  const catalog = { subagent: f.captured.execute }
  assert.equal(catalog.subagent, f.captured.execute)
  const codeTool = context("call_codemode")
  assert.equal(await catalog.subagent({ ...nativeInput, mission }, codeTool), f.result)
  assert.equal(f.executions[1].context.signal, codeTool.signal)
  assert.deepEqual(f.order.slice(0, 7), ["reserve", "native", "signed-binding+journal", "fresh-env", "forward-progress",
    "native-prompt", "foreground-return"])
})

test("raw owned family calls cannot bypass reservation, lifecycle or fresh child ENV", async () => {
  const f = await fixture()
  await f.invoke(nativeInput)
  assert.equal(f.invocations[0].mission, undefined)
  assert.deepEqual(f.order, ["reserve", "native", "signed-binding+journal", "fresh-env", "forward-progress", "native-prompt", "foreground-return"])
  f.revoke()
  await assert.rejects(f.invoke(nativeInput, context("call_after_revoke")), /trusted owner revoked/)
  assert.equal(f.executions.length, 1)
})

test("requested native input and ref cannot change underneath reservation across a Code Mode await", async () => {
  const gate = deferred()
  const entered = deferred()
  const f = await fixture()
  const reserve = f.admissions.reserve
  f.admissions.reserve = async (...args) => { const value = await reserve(...args); entered.resolve(); await gate.promise; return value }
  const request = { ...nativeInput, model: { ...nativeInput.model }, mission: { ...mission } }
  const pending = f.invoke(request)
  await entered.promise
  request.prompt = "changed after signed reservation"
  request.model.id = "different model"
  request.mission.generation = 4
  assert.equal(Object.isFrozen(f.invocations[0].nativeInput), true)
  assert.equal(Object.isFrozen(f.invocations[0].nativeInput.model), true)
  gate.resolve(); await pending
  assert.deepEqual(f.executions[0].input, nativeInput)
  assert.deepEqual(f.invocations[0].mission, mission)
})

test("unowned raw requires an explicit trusted policy result, still traverses binding; declared cannot be unowned", async () => {
  const f = await fixture()
  const reserve = f.admissions.reserve
  f.admissions.reserve = async (...args) => ({ ...await reserve(...args), scope: "unowned" })
  await f.invoke(nativeInput)
  assert.equal(f.order.includes("signed-binding+journal"), true)
  await assert.rejects(f.invoke({ ...nativeInput, mission }, context("call_declared")), /Unknown native task admission/)
  assert.equal(f.executions.length, 1)
  f.admissions.reserve = async () => undefined as never
  await assert.rejects(f.invoke(nativeInput, context("call_absent_policy")), /Unknown native task admission/)
  assert.equal(f.executions.length, 1)
})

test("missing host capability and unsigned/async current assertions fail closed", async () => {
  const f = await fixture()
  await assert.rejects(installNativeTaskAdapter(f.ctx, {} as NativeTaskAdmissions<Claim, Bound>), /Missing trusted/)
  f.admissions.assertCurrent = () => true
  await assert.rejects(f.invoke(nativeInput), /Invalid synchronous native task fence/)
  f.admissions.assertCurrent = async () => {}
  await assert.rejects(f.invoke(nativeInput), /Invalid synchronous native task fence/)
  assert.equal(f.executions.length, 0)
})

test("durable birth capacity refusal precedes native executor; local state is never qualification", async () => {
  const f = await fixture()
  f.durableClaims.add("call_native")
  await assert.rejects(f.invoke(), /durable capacity refused/)
  assert.equal(f.executions.length, 0)
  assert.equal(f.failures[0].phase, "reserve")
  assert.equal(f.durableClaims.has("call_native"), true)
})

test("overlapping known call/task/child refuses at entry without waiting for reserve", async t => {
  for (const conflict of ["call", "task", "child"] as const) await t.test(conflict, async () => {
    const gate = deferred()
    const entered = deferred()
    const f = await fixture()
    const reserve = f.admissions.reserve
    f.admissions.reserve = async (...args) => { entered.resolve(); await gate.promise; return reserve(...args) }
    const first = { ...nativeInput, ...(conflict === "child" ? { sessionID: child } : {}), ...(conflict === "task" ? { mission } : {}) }
    const pending = f.invoke(first)
    await entered.promise
    const next = conflict === "call" ? context() : context("call_other")
    await assert.rejects(f.invoke(first, next), /Overlapping native task invocation/)
    assert.equal(f.executions.length, 0)
    assert.equal(f.invocations.length, 0)
    gate.resolve(); await pending
    assert.equal(f.executions.length, 1)
  })
})

test("reservation-await disposal/revocation/abort blocks native birth and preserves host claim", async t => {
  for (const cause of ["dispose", "revoke", "abort"] as const) await t.test(cause, async () => {
    const gate = deferred()
    const entered = deferred()
    const f = await fixture()
    const reserve = f.admissions.reserve
    f.admissions.reserve = async (...args) => { const value = await reserve(...args); entered.resolve(); await gate.promise; return value }
    const controller = new AbortController()
    const pending = f.invoke(undefined, { ...context(), signal: controller.signal })
    await entered.promise
    if (cause === "dispose") await f.registration.dispose()
    if (cause === "revoke") f.revoke()
    if (cause === "abort") controller.abort(new Error("native abort"))
    gate.resolve()
    await assert.rejects(pending, /retired|revoked|native abort/)
    assert.equal(f.executions.length, 0)
    assert.equal(f.durableClaims.has("call_native"), true)
    assert.equal(f.failures[0].reservation?.claim.sequence, 1)
  })
})

test("captured wrapper and late progress stay retired before registration disposal, including ENV await", async () => {
  const entered = deferred()
  const gate = deferred()
  const f = await fixture()
  f.admissions.bindActualChild = async (_invocation, reservation, sessionID, fence) => {
    f.order.push("signed-binding+journal"); entered.resolve(); await gate.promise
    // Return partial binding evidence even if disposal occurred during host work.
    return { childSessionID: sessionID, claim: reservation.claim }
  }
  const pending = f.invoke()
  await entered.promise
  await f.registration.dispose()
  gate.resolve()
  await assert.rejects(pending, /retired/)
  assert.equal(f.progress.length, 0)
  assert.equal(f.order.includes("native-prompt"), false)
  assert.equal(f.failures[0].bound?.childSessionID, child)
  assert.equal(f.failures[0].observedChildSessionID, child)
  assert.equal(f.failures[0].retired, true)
  await assert.rejects(f.captured.execute(nativeInput, context("captured_after_disposal")), /retired/)
  assert.equal(f.executions.length, 1)
})

test("fresh ENV failure prevents progress/prompt even on a raw family call; no replay or durable release", async () => {
  const error = new Error("real host ENV refused")
  const f = await fixture()
  f.admissions.bindActualChild = async () => { throw error }
  await assert.rejects(f.invoke(nativeInput), actual => actual === error)
  assert.equal(f.order.includes("native-prompt"), false)
  assert.equal(f.progress.length, 0)
  assert.equal(f.failures[0].observedChildSessionID, child)
  assert.equal(f.failures[0].phase, "bind")
  assert.equal(f.durableClaims.has("call_native"), true)
  await assert.rejects(f.invoke(nativeInput), /durable capacity refused/)
  assert.equal(f.executions.length, 1)
})

test("background launch-return preserves native result and is neither execution end nor business completion", async () => {
  const result: Tool.Result = { content: "launched", metadata: { sessionID: child, status: "running", nativeExtra: 42 } }
  const f = await fixture(async (_input, tool) => { await tool.progress({ sessionID: child }); return result })
  assert.equal(await f.invoke({ ...nativeInput, background: true, mission }), result)
  assert.equal(f.order.includes("launch-return"), true)
  assert.equal(f.order.includes("foreground-return"), false)
  assert.equal(f.durableClaims.has("call_native"), true)
  await assert.rejects(f.invoke({ ...nativeInput, background: true, mission }), /durable capacity refused/)
  assert.equal(f.executions.length, 1)
})

test("same-actor continuation is guarded before birth; exact native sessionID cannot be substituted", async () => {
  const f = await fixture()
  await f.invoke({ ...nativeInput, mission, sessionID: child })
  assert(f.order.indexOf("continuation") < f.order.indexOf("native"))
  await assert.rejects(f.invoke({ ...nativeInput, mission, sessionID: "ses_foreign" }, context("call_foreign")), /exact ended child required/)
  assert.equal(f.executions.length, 1)
  const substituted = await fixture(async (_input, tool) => { await tool.progress({ sessionID: "ses_substitute" }); return {} })
  await assert.rejects(substituted.invoke({ ...nativeInput, mission, sessionID: child }), /Native child identity changed/)
  assert.equal(substituted.order.includes("signed-binding+journal"), false)
})

test("strict malformed references reject before reservation, including revision/proof/duplicated plan", async () => {
  const f = await fixture()
  for (const value of [null, [], undefined, { ...mission, revision: 1 }, { ...mission, proof: true }, { ...mission, plan: {} },
    { missionID: mission.missionID, taskKey: mission.taskKey, revision: 1 }, { ...mission, generation: 0 }, { ...mission, generation: -1 },
    { ...mission, generation: 0.5 }, { ...mission, generation: Infinity }, { ...mission, generation: "0" },
    { ...mission, generation: Number.MAX_SAFE_INTEGER + 1 }, { ...mission, missionID: "" }, { ...mission, missionID: "ab" },
    { ...mission, missionID: "x".repeat(101) }, { ...mission, missionID: "invalid.id" }, { ...mission, missionID: "invalid id" },
    { ...mission, taskKey: "x" }, { ...mission, taskKey: "x".repeat(65) }, { ...mission, taskKey: "UPPER" },
    { ...mission, taskKey: "_wrong-leading" }, { ...mission, taskKey: "invalid key" }, { ...mission, taskKey: "wrong/key" }]) {
    await assert.rejects(f.invoke({ ...nativeInput, mission: value }), /Invalid strict native task reference/)
  }
  assert.equal(f.invocations.length, 0)
  assert.equal(f.executions.length, 0)
})

test("actual native IDs retain separate 1-240 ABI bounds, never mission/task-key patterns", async () => {
  const nativeID = `Ses.Native-${"X".repeat(229)}`
  assert.equal(nativeID.length, 240)
  const f = await fixture(async (_input, tool) => { await tool.progress({ sessionID: nativeID }); return { content: "native output" } })
  const tool = context(nativeID, nativeID, nativeID)
  await f.invoke(undefined, tool)
  assert.equal(f.invocations[0].sessionID, nativeID)
  assert.equal(f.failures.length, 0)
  for (const invalid of ["", "x".repeat(241), "has space", "has\u0000control", "has\u007fcontrol"]) {
    await assert.rejects(f.invoke(undefined, context("call_valid", invalid)), /Invalid actual native invocation identity/)
    await assert.rejects(f.invoke({ ...nativeInput, sessionID: invalid, mission }, context("call_valid")), /Invalid native continuation sessionID/)
  }
  assert.equal(f.invocations.length, 1)
  assert.equal(f.executions.length, 1)
})

test("no structured child progress rejects: result/text child IDs cannot manufacture binding", async () => {
  const f = await fixture(async () => ({ content: `child: ${child}`, metadata: { sessionID: child } }))
  await assert.rejects(f.invoke(), /without settled actual child binding/)
  assert.equal(f.order.includes("signed-binding+journal"), false)
  assert.equal(f.order.includes("foreground-return"), false)
  assert.equal(f.failures[0].bound, undefined)
  assert.equal(f.durableClaims.has("call_native"), true)
})

test("repeated exact child progress does not rebind/reprepare ENV; different child/result rejects", async t => {
  const exact = await fixture(async (_input, tool) => {
    await tool.progress({ sessionID: child, step: 1 }); await tool.progress({ sessionID: child, step: 2 })
    return { content: "native result" }
  })
  await exact.invoke()
  assert.equal(exact.order.filter(item => item === "fresh-env").length, 1)
  assert.equal(exact.progress.length, 2)
  for (const where of ["progress", "result"] as const) await t.test(where, async () => {
    const f = await fixture(async (_input, tool) => {
      await tool.progress({ sessionID: child })
      if (where === "progress") await tool.progress({ sessionID: "ses_other" })
      return { metadata: { sessionID: "ses_other" } }
    })
    await assert.rejects(f.invoke(), /child identity changed/)
    assert.equal(f.order.filter(item => item === "signed-binding+journal").length, 1)
    assert.equal(f.failures[0].bound?.childSessionID, child)
  })
})

test("native error identity and actual partial binding survive failed observation; never retry", async () => {
  const error = { nativeError: "unchanged" }
  const f = await fixture(async (_input, tool) => { await tool.progress({ sessionID: child }); throw error })
  const observe = f.admissions.failureObserved
  f.admissions.failureObserved = async failure => { await observe(failure); throw new Error("observation lost") }
  await assert.rejects(f.invoke(), actual => actual === error)
  assert.equal(f.failures[0].bound?.childSessionID, child)
  assert.equal(f.failures[0].error, error)
  assert.equal(f.durableClaims.has("call_native"), true)
  assert.equal(f.executions.length, 1)
})

test("swallowed progress errors cannot manufacture success or retry a failed binding", async () => {
  const error = new Error("binding reply ambiguous")
  const f = await fixture(async (_input, tool) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try { await tool.progress({ sessionID: child }) } catch { /* Native must not hide admission failure. */ }
    }
    return { content: "manufactured success" }
  })
  let binds = 0
  f.admissions.bindActualChild = async () => { binds++; throw error }
  await assert.rejects(f.invoke(), actual => actual === error)
  assert.equal(binds, 1)
  assert.equal(f.progress.length, 0)
  assert.equal(f.order.includes("foreground-return"), false)
  assert.equal(f.durableClaims.has("call_native"), true)
})

test("unawaited native progress fails closed and preserves later partial binding evidence", async () => {
  const gate = deferred()
  let late!: Promise<void>
  const f = await fixture(async (_input, tool) => {
    late = tool.progress({ sessionID: child })
    void late.catch(() => {})
    return { content: "native did not await binding" }
  })
  f.admissions.bindActualChild = async (_invocation, reservation, sessionID) => {
    await gate.promise
    return { childSessionID: sessionID, claim: reservation.claim }
  }
  await assert.rejects(f.invoke(), /without settled actual child binding/)
  assert.equal(f.failures[0].bound, undefined)
  assert.equal(f.failures[0].observedChildSessionID, child)
  gate.resolve()
  await assert.rejects(late, /outlived execution|invocation retired/)
  assert.equal(f.failures[1].bound?.childSessionID, child)
  assert.equal(f.failures[1].retired, true)
  assert.equal(f.progress.length, 0)
  assert.equal(f.durableClaims.has("call_native"), true)
})

test("overlapping progress is latched as failure, never a second bind or forwarded child admission", async () => {
  const gate = deferred()
  let binds = 0
  const f = await fixture(async (_input, tool) => {
    const first = tool.progress({ sessionID: child })
    const overlap = tool.progress({ sessionID: child })
    gate.resolve()
    await Promise.allSettled([first, overlap])
    return { content: "native result after overlapping callbacks" }
  })
  f.admissions.bindActualChild = async (_invocation, reservation, sessionID) => {
    binds++; await gate.promise
    return { childSessionID: sessionID, claim: reservation.claim }
  }
  await assert.rejects(f.invoke(), /Unsettled native child progress/)
  assert.equal(binds, 1)
  assert.equal(f.progress.length, 0)
  assert.equal(f.failures[0].bound?.childSessionID, child)
})

test("unknown child binding and malformed structured progress never advance to native prompt", async t => {
  await t.test("unknown binding", async () => {
    const f = await fixture()
    f.admissions.bindActualChild = async () => undefined as never
    await assert.rejects(f.invoke(), /Unknown actual child binding/)
    assert.equal(f.progress.length, 0)
    assert.equal(f.order.includes("native-prompt"), false)
  })
  for (const sessionID of [undefined, null, "", 42, "x".repeat(241)]) await t.test(String(sessionID), async () => {
    const f = await fixture(async (_input, tool) => { await tool.progress({ sessionID }); return {} })
    await assert.rejects(f.invoke(), /Invalid structured native child sessionID/)
    assert.equal(f.order.includes("signed-binding+journal"), false)
    assert.equal(f.progress.length, 0)
  })
})

test("ambiguous settlement retains claim/result/binding and does not auto-release/replay", async t => {
  for (const background of [false, true]) await t.test(String(background), async () => {
    const result: Tool.Result = { content: "native returned", metadata: { status: background ? "running" : "completed" } }
    const f = await fixture(async (_input, tool) => { await tool.progress({ sessionID: child }); return result })
    const ambiguity = new Error("signed settlement outcome unknown")
    if (background) f.admissions.launchReturned = async () => { throw ambiguity }
    else f.admissions.returned = async () => { throw ambiguity }
    await assert.rejects(f.invoke({ ...nativeInput, background, mission }), actual => actual === ambiguity)
    assert.equal(f.failures[0].nativeResult, result)
    assert.equal(f.failures[0].bound?.childSessionID, child)
    assert.equal(f.failures[0].phase, background ? "launch-return" : "return")
    assert.equal(f.durableClaims.has("call_native"), true)
    await assert.rejects(f.invoke(), /durable capacity refused/)
    assert.equal(f.executions.length, 1)
  })
})

test("optional bounded JSON report reference preserves native file/images/output/metadata without wakes", async () => {
  const f = await fixture()
  f.admissions.reportReference = async () => ({ ...mission, reportID: "report-one" })
  const result = await f.invoke()
  assert.equal(result.output, f.result.output)
  assert.equal(result.metadata, f.result.metadata)
  assert(Array.isArray(result.content))
  assert(Array.isArray(f.result.content))
  assert.equal(result.content[0], f.result.content[0])
  assert.equal(result.content[1], f.result.content[1])
  assert.deepEqual(result.content[2], { type: "text", text: JSON.stringify({ mission: { ...mission, reportID: "report-one" } }) })
  f.admissions.reportReference = async () => ({ ...mission, reportID: "x".repeat(257) })
  await assert.rejects(f.invoke(undefined, context("call_oversized_report")), /Invalid strict/)
  f.admissions.reportReference = async () => ({ ...mission, generation: 2 })
  await assert.rejects(f.invoke(undefined, context("call_wrong_report")), /differs from declared task/)
})

test("reload uses official transform replay; captured old executor still observes revocation", async () => {
  const f = await fixture()
  await f.ctx.tool.reload()
  const replayed = (await f.ctx.tool.list())[0]
  assert.equal(replayed.options, f.original.options)
  await replayed.execute({ ...nativeInput, mission }, context("call_reloaded"))
  assert.equal(f.executions.length, 1)
  f.revoke()
  await assert.rejects(f.captured.execute(nativeInput, context("call_old_snapshot")), /revoked/)
})

test("host fences captured from a finished invocation retire independently of plugin lifetime", async () => {
  const f = await fixture()
  let capturedFence!: () => void
  const reserve = f.admissions.reserve
  f.admissions.reserve = async (invocation, fence) => { capturedFence = fence.assertCurrent; return reserve(invocation, fence) }
  await f.invoke()
  assert.throws(capturedFence, /invocation retired/)
  await f.invoke(undefined, context("call_later_valid"))
  assert.equal(f.executions.length, 2)
})

test("schema collisions/unknown schema fail closed rather than guessing native constraints", async () => {
  const f = await fixture()
  await f.registration.dispose()
  const unsupported: Tool.Info[] = [
    { ...f.original, input: { type: "object", properties: { mission: { type: "object" } } } },
    { ...f.original, input: { type: "object", properties: {}, allOf: [] } },
    { ...f.original, input: { type: "string" } },
  ]
  for (const info of unsupported) {
    const ctx: Pick<Plugin.Context, "tool"> = { tool: { ...f.ctx.tool,
      transform: async callback => {
        const editor: Tool.ToolEditor = { get: () => ({ ...info, id: "subagent" }), list: () => [], namespace: () => {},
          add: () => {}, remove: () => {}, update: (_id, update) => update({ ...info }) }
        callback(editor)
        return { dispose: async () => {} } satisfies Registration
      },
    } }
    await assert.rejects(installNativeTaskAdapter(ctx, f.admissions), /Unsupported native subagent input schema/)
  }
})
