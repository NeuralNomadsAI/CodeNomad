// Native foreground capability qualification ONLY, not a product child dispatcher.
import assert from "node:assert/strict"
import { randomUUID, createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import { build } from "esbuild"
import { atomicJSON } from "./missions-authority-spike/broker.mjs"
import { ASSIGNED_CLI, privateRoot, launch, launchSentinel } from "./missions-child-environment/runtime.mjs"
import { startChildProvider } from "./missions-child-environment/provider.mjs"
import { ownedBackend } from "./missions-child-environment/backend.mjs"
import { CHILD_ENV_RPC } from "./missions-child-environment/schema.mjs"
import { explicitSeam } from "./missions-child-environment/seam-scenarios.mjs"

const cli = process.argv[2] ?? ASSIGNED_CLI
const previousEnvironment = { ...process.env }, deadline = Date.now() + 180_000
const token = randomUUID(), events = [], parents = [], calls = new Map(), settingsTrace = []
let root, project, config, provider, running, sentinel, backend, stage = "private isolation", failure
const subscription = new AbortController()
const evidence = { status: "running", qualified: false, nativeInheritance: null, explicitAdmission: false,
  signedLifecycleQualified: false, productForegroundEnabled: false, capabilities: [], blockers: [
  "No product foreground child admission/authority integration is enabled by this fixture",
  "Actual durable Pause/Stop generation fencing before native child admission remains unsupported/unqualified; no boolean grant simulation",
  "No recursive cancellation, per-inbox environment isolation, background notifications, restart or crash atomicity qualification",
], observations: { settingsReads: 0 }, artifacts: null }
const gate = name => { evidence.capabilities.push(name); console.log(`PASS ${name}`) }
const sourceFiles = ["scripts/test-missions-continuity-spike.mjs", "packages/server/src/missions/journal.ts",
  "packages/server/src/missions/authority-core.ts", "packages/server/src/missions/authority-store.ts", "packages/server/src/workspaces/manager.ts",
  "packages/server/src/workspaces/session-environment.ts", "packages/server/src/server/http-server.ts",
  "packages/server/src/opencode/missions/durable-plugin.ts", "packages/server/src/auth/manager.ts",
  "packages/server/src/workspaces/worktree-session-evacuation.ts", "packages/server/src/workspaces/opencode-service.ts",
  "packages/server/src/server/routes/mission-input.ts", "scripts/missions-authority-spike/broker.mjs", "scripts/missions-authority-spike/provider.mjs"]
const hashes = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, createHash("sha256").update(await readFile(file)).digest("hex")])))
async function until(predicate, label = stage) {
  const end = Math.min(deadline, Date.now() + 25_000)
  while (Date.now() < end) {
    if (failure || provider?.failure || provider?.observationFailure) throw failure ?? provider.failure ?? provider.observationFailure
    if (running?.child.exitCode !== null && running?.child.exitCode !== undefined) throw new Error("Owned private serve exited")
    if (await predicate()) return
    await delay(40)
  }
  throw new Error(`Bounded fixture timeout: ${label}`)
}
const options = () => ({ signal: AbortSignal.timeout(20_000) })
const primary = sessionID => provider.observations.filter(record => record.kind === "primary" && record.sessionID === sessionID)
const rpc = (method, input = {}) => running.client.rpc(CHILD_ENV_RPC)[method]({ token, ...input }, { location: { directory: project }, ...options() })
const wait = sessionID => running.client.session.wait({ sessionID }, options())
const messages = async sessionID => (await running.client.message.list({ sessionID, limit: { order: "asc", limit: 100 } }, options())).data
const tools = records => records.flatMap(message => message.content ?? []).filter(part => part.type === "tool")
const childInput = (description, extra = {}) => ({ agent: "fixture_child", description, prompt: "Perform only the private bounded shell probe", ...extra })
const toolCall = (tool, input, id) => ({ tool, input, id })
const probeCommand = label => `node probe.cjs ${label}.json`
const readProbe = async label => JSON.parse(await readFile(path.join(project, `${label}.json`), "utf8"))
const safeProbe = value => {
  assert.equal(value.path, true)
  return value
}
const cleanRoot = value => {
  safeProbe(value)
  for (const key of ["db", "state", "serverPassword", "bridgeToken", "bootstrapToken"]) assert.equal(value[key], false, `No ${key} in owned root shell`)
  return value
}
async function profile(marker, retired) {
  const bin = path.join(root, `bin-${marker}`); await mkdir(bin, { recursive: true })
  const variables = { CHILD_ENV_MARKER: marker, PATH: `${bin}${path.delimiter}${previousEnvironment.PATH ?? previousEnvironment.Path}`,
    ...(retired ? { CHILD_ENV_RETIRED: retired } : {}) }
  await atomicJSON(path.join(root, "profile.json"), { environmentVariables: variables })
  settingsTrace.push({ marker, retired: retired ?? null })
}
async function parent(name, permissions) {
  const session = await backend.proxy.session.create({ location: { directory: project }, title: name, ...(permissions ? { permissions } : {}) }, options())
  assert.equal(session.parentID, undefined)
  parents.push(session.id)
  backend.admission.approveRoot(session.id, path.join(root, "profile.json"))
  return session.id
}
async function submit(parentID, callID, input, rootRequestID = `msg_${randomUUID().replaceAll("-", "")}`) {
  provider.answers.set(parentID, [toolCall("subagent", childInput(callID, input), callID)])
  const reads = evidence.observations.settingsReads
  const admission = await backend.proxy.session.prompt({ sessionID: parentID, id: rootRequestID, text: "Run the selected bounded native foreground invocation",
    metadata: { "private.child.environment": { rootRequestID } } }, options())
  assert.equal(admission.id, rootRequestID, "Actual owned route admission, no direct fallback")
  assert(evidence.observations.settingsReads > reads, "Fresh private settings read before every root send")
}
async function prepare(parentID, callID, input = {}, childAnswers = [], hold = false, owner) {
  const rootRequestID = `msg_${randomUUID().replaceAll("-", "")}`
  const contract = { parentID, callID, rootRequestID, executionID: owner?.executionID ?? `execution-${callID}`,
    taskKey: owner?.taskKey ?? `task-${callID}`, contractRequestID: owner?.contractRequestID ?? `contract-${callID}` }
  await rpc("authorize", contract)
  await backend.admission.record(contract, token, owner?.fault)
  calls.set(callID, contract)
  if (childAnswers.length) provider.childPlans.set(callID, { answers: childAnswers, hold })
  await submit(parentID, callID, input, rootRequestID)
  return contract
}
async function binding(parentID, callID) {
  let result
  await until(async () => { result = (await rpc("proof", { parentID, callID })).binding; return result }, `structured binding ${callID}`)
  assert.equal(result.parentID, parentID); assert.equal(result.callID, callID)
  assert.match(result.assistantMessageID, /^msg_/)
  assert.equal((await running.client.session.get({ sessionID: result.childID }, options())).parentID, parentID)
  return result
}
async function finish(parentID, callID, label, expectedModel = "child") {
  await wait(parentID)
  const bound = await binding(parentID, callID), requests = primary(bound.childID)
  assert(requests.length > 0)
  const currentRequest = requests.find(record => record.callID === callID)
  assert(currentRequest, "Actual child provider request has structured call identity")
  const contextText = currentRequest.messages.filter(message => message.role === "system").map(message =>
    typeof message.content === "string" ? message.content : message.content.map(part => part.text ?? "").join("\n")).join("\n")
  assert(contextText.includes("CHILD_ENV_BINDING:" + JSON.stringify(bound)), "Binding present BEFORE first child provider")
  assert.equal(currentRequest.model, expectedModel)
  const part = tools(await messages(parentID)).find(part => part.id === callID)
  assert.equal(part.state.status, "completed")
  assert.equal(part.state.metadata.sessionID, bound.childID)
  const observed = safeProbe(await readProbe(label))
  // Independent real session.shell measurement after binding, never a child prompt.
  await running.client.session.shell({ sessionID: bound.childID, command: probeCommand(`${label}-api`) }, options())
  const api = safeProbe(await readProbe(`${label}-api`))
  assert.deepEqual(api, observed, "Native tool shell and session.shell see the same child snapshot")
  await wait(bound.childID)
  return { binding: bound, shell: observed, sessionShell: api, child: await running.client.session.get({ sessionID: bound.childID }, options()) }
}

try {
  ({ root, project, config } = await privateRoot(cli)); evidence.artifacts = root
  console.log(`Private foreground fixture: ${root}`)
  evidence.sourceBefore = await hashes()
  await writeFile(path.join(project, "probe.cjs"), `const e=process.env;require('node:fs').writeFileSync(process.argv[2],JSON.stringify({marker:e.CHILD_ENV_MARKER??null,retired:e.CHILD_ENV_RETIRED??null,path:!!e.PATH,pathFirst:(e.PATH??'').split(require('node:path').delimiter)[0],pathBins:['A1','B1','A2'].filter(x=>(e.PATH??'').includes('bin-'+x)),db:!!e.OPENCODE_DB,state:!!e.XDG_STATE_HOME,serverPassword:!!e.OPENCODE_SERVER_PASSWORD,bridgeToken:!!e.CODENOMAD_AUTOMATION_BRIDGE_TOKEN,bootstrapToken:!!e.CODENOMAD_BOOTSTRAP_TOKEN}));console.log('PRIVATE_ENV_PROBE_SAVED')`)
  provider = await startChildProvider()
  const pluginDirectory = path.join(root, "private-plugin"); await mkdir(pluginDirectory)
  const pluginPath = fileURLToPath(new URL("./missions-child-environment/plugin.mjs", import.meta.url)).replaceAll("\\", "/")
  const entry = path.join(root, "entry.mjs")
  await writeFile(entry, `import { childEnvironmentPlugin } from ${JSON.stringify(pluginPath)};export default childEnvironmentPlugin(${JSON.stringify(token)},${JSON.stringify(path.join(root, "child-admission-seed.json"))});`)
  await build({ entryPoints: [entry], outfile: path.join(pluginDirectory, "index.mjs"), bundle: true, platform: "node", format: "esm", target: "node22" })
  sentinel = await launchSentinel(cli, root, deadline)
  const sentinelSession = await sentinel.client.session.create({ location: { directory: path.join(root, "sentinel") }, title: "Private cleanup sentinel" }, options())
  evidence.sentinel = { pid: sentinel.info.pid, sessionID: sentinelSession.id }
  process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ model: "fixture/fixture", update: "disable", snapshots: false,
    permissions: [{ action: "*", resource: "*", effect: "allow" }, { action: "execute", resource: "*", effect: "deny" }],
    agents: { fixture_child: { mode: "subagent", description: "Private deterministic bounded child", system: "Private child probe only", model: "fixture/child" },
      fixture_primary: { mode: "primary", description: "Private invalid child selection" } },
    providers: { fixture: { package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: provider.url, apiKey: "private" }, models: { fixture: {}, child: {} } } }, plugins: [pluginDirectory] })
  running = await launch(cli, root, process.env, deadline)
  evidence.nativeVersion = running.info.version
  await profile("A1", "only-A1")
  backend = await ownedBackend({ root, project, cli, running, token, settingsFile: path.join(root, "profile.json"), observations: evidence.observations, deadline })
  const openapi = await (await fetch(`${running.url}/openapi.json`, { headers: running.headers, signal: AbortSignal.timeout(10_000) })).json()
  await writeFile(path.join(root, "openapi.json"), JSON.stringify(openapi, null, 2))
  const caps = await rpc("capabilities"); evidence.nativeCapabilities = caps
  const models = (await running.client.model.list({ location: { directory: project } }, options())).data
  evidence.nativeModels = models.filter(model => model.providerID === "fixture").map(({ id, modelID, providerID, variants }) =>
    ({ id, modelID, providerID, variants: variants.map(variant => variant.id) }))
  const explicitChoice = evidence.nativeModels.find(model => model.id === "fixture" || model.modelID === "fixture")
  assert(explicitChoice?.variants.length, "Explicit native fixture model/variants are discoverable")
  assert.equal(caps.preservedFields, true)
  assert.deepEqual(caps.currentOptions, caps.nativeOptions); assert.deepEqual(caps.currentInput, caps.nativeInput)
  assert(!openapi.paths["/api/session"].post.requestBody.content["application/json"].schema.properties.parentID)
  void (async () => { try { for await (const event of running.client.event.subscribe({ signal: subscription.signal })) { events.push(event); if (events.length > 4000) throw new Error("Native event budget exceeded") } }
    catch (error) { if (!subscription.signal.aborted) failure = error } })()
  gate("actual native executor/options retained; no invented child creation API")

  stage = "independent simultaneous child environments"
  const a = await parent("Profile A"), b = await parent("Profile B")
  provider.holdNext.add(a)
  const aContract = await prepare(a, "child_A1", {}, [toolCall("shell", { command: probeCommand("A1") }, "probe_A1")], true)
  await until(() => provider.holds.has(a))
  await profile("B1", "only-B1")
  provider.holdNext.add(b)
  await prepare(b, "child_B1", {}, [toolCall("shell", { command: probeCommand("B1") }, "probe_B1")], true)
  await until(() => provider.holds.has(b))
  provider.release(a); provider.release(b)
  const aBound = await binding(a, "child_A1"), bBound = await binding(b, "child_B1")
  await until(() => provider.holds.has(aBound.childID) && provider.holds.has(bBound.childID))
  const activeBoth = await running.client.session.active({}, options())
  assert(activeBoth[aBound.childID] && activeBoth[bBound.childID])
  await profile("A2") // Editing settings alone must not mutate either native child.
  provider.release(aBound.childID); provider.release(bBound.childID)
  evidence.initial = { A: await finish(a, "child_A1", "A1"), B: await finish(b, "child_B1", "B1") }
  await running.client.session.shell({ sessionID: a, command: probeCommand("root-A1") }, options())
  await running.client.session.shell({ sessionID: b, command: probeCommand("root-B1") }, options())
  evidence.rootSnapshots = { A: cleanRoot(await readProbe("root-A1")), B: cleanRoot(await readProbe("root-B1")) }
  assert.equal(evidence.rootSnapshots.A.marker, "A1"); assert.equal(evidence.rootSnapshots.B.marker, "B1")
  assert.equal(evidence.rootSnapshots.A.retired, "only-A1"); assert.equal(evidence.rootSnapshots.B.retired, "only-B1")
  assert.deepEqual(evidence.rootSnapshots.A.pathBins, ["A1"]); assert.deepEqual(evidence.rootSnapshots.B.pathBins, ["B1"])
  evidence.environmentInheritanceQualified = evidence.initial.A.shell.marker === "A1" && evidence.initial.B.shell.marker === "B1"
    && !evidence.initial.A.shell.db && !evidence.initial.A.shell.serverPassword && !evidence.initial.B.shell.db && !evidence.initial.B.shell.serverPassword
  evidence.nativeInheritance = evidence.environmentInheritanceQualified
  if (!evidence.environmentInheritanceQualified) {
    evidence.blockers.push("Actual 2.0.21 foreground children do not inherit the cleaned per-parent environment: private daemon startup marker/PATH and private-variable presence measured instead")
    console.log("BLOCKED native child profile/environment inheritance (measured, no child-write workaround)")
  }
  gate("real owned route applies independent cleaned root profiles; simultaneous native child snapshots measured")

  stage = "same child continuation after complete profile replacement"
  await prepare(a, "continue_A2", { sessionID: aBound.childID }, [toolCall("shell", { command: probeCommand("A2-continuation") }, "probe_A2_continue")], false, aContract)
  evidence.continuation = await finish(a, "continue_A2", "A2-continuation")
  assert.equal(evidence.continuation.binding.childID, aBound.childID)
  assert.equal(events.filter(event => event.type === "session.created" && event.data.parentID === a).length, 1)
  await prepare(a, "new_A2", {}, [toolCall("shell", { command: probeCommand("A2-new") }, "probe_A2_new")])
  evidence.newAfterChange = await finish(a, "new_A2", "A2-new")
  await running.client.session.shell({ sessionID: a, command: probeCommand("root-A2") }, options())
  evidence.changedRoot = cleanRoot(await readProbe("root-A2"))
  assert.equal(evidence.changedRoot.marker, "A2"); assert.equal(evidence.changedRoot.retired, null)
  assert.deepEqual(evidence.changedRoot.pathBins, ["A2"])
  gate("same-child continuation measured separately from new-child creation under changed complete profile")

  stage = "private correlation gate negative native invocations"
  const beforeGate = primary(aBound.childID).length
  await prepare(a, "wrong_contract", { sessionID: aBound.childID }, [], false, { ...aContract, taskKey: "other-task" })
  await wait(a)
  assert.equal(tools(await messages(a)).find(part => part.id === "wrong_contract").state.status, "error")
  assert.equal(primary(aBound.childID).length, beforeGate)
  await assert.rejects(rpc("authorize", { ...calls.get("wrong_contract"), taskKey: "changed-again" }))
  const missing = await parent("No invocation authorization")
  await submit(missing, "missing_contract", {})
  await wait(missing)
  assert.equal(tools(await messages(missing)).find(part => part.id === "missing_contract").state.status, "error")
  assert.equal((await rpc("proof", { parentID: missing, callID: "missing_contract" })).binding, null)
  const mismatch = await parent("Mismatched root request")
  await rpc("authorize", { parentID: mismatch, callID: "wrong_request", rootRequestID: `msg_${randomUUID().replaceAll("-", "")}`,
    executionID: "fixture-execution", taskKey: "fixture-task", contractRequestID: "fixture-contract" })
  await submit(mismatch, "wrong_request", {})
  await wait(mismatch)
  assert.equal(tools(await messages(mismatch)).find(part => part.id === "wrong_request").state.status, "error")
  assert.equal((await rpc("proof", { parentID: mismatch, callID: "wrong_request" })).binding, null)
  gate("native invocations reject missing/mismatched correlation and immutable task-contract substitution")

  stage = "cross-parent continuation, permissions and agent choices"
  const foreign = await parent("Foreign continuation"), beforeChild = primary(aBound.childID).length
  await prepare(foreign, "foreign_call", { sessionID: aBound.childID }, [], false, aContract)
  await wait(foreign)
  assert.equal(tools(await messages(foreign)).find(part => part.id === "foreign_call").state.status, "error")
  assert.equal(primary(aBound.childID).length, beforeChild)
  const deniedShell = await parent("Inherited shell deny", [{ action: "shell", resource: "*", effect: "deny" }])
  await prepare(deniedShell, "permission_child", {}, ["CHILD_WITHOUT_SHELL"])
  await wait(deniedShell)
  const permissionBinding = await binding(deniedShell, "permission_child")
  evidence.permissions = { binding: permissionBinding, firstTools: primary(permissionBinding.childID)[0].tools,
    nativeChild: await running.client.session.get({ sessionID: permissionBinding.childID }, options()) }
  assert(!evidence.permissions.firstTools.includes("shell"))
  const invalid = await parent("Primary-only child refused")
  await prepare(invalid, "invalid_agent", { agent: "fixture_primary" })
  await wait(invalid)
  assert.equal(tools(await messages(invalid)).find(part => part.id === "invalid_agent").state.status, "error")
  assert.equal((await rpc("proof", { parentID: invalid, callID: "invalid_agent" })).binding, null)
  const deniedAgent = await parent("Native subagent permission deny", [{ action: "subagent", resource: "fixture_child", effect: "deny" }])
  await prepare(deniedAgent, "denied_agent")
  await wait(deniedAgent)
  assert.equal(tools(await messages(deniedAgent)).find(part => part.id === "denied_agent").state.status, "error")
  assert.equal((await rpc("proof", { parentID: deniedAgent, callID: "denied_agent" })).binding, null)
  await prepare(b, "invalid_variant", { model: "fixture/fixture#unregistered-private-variant" })
  await wait(b)
  assert.equal(tools(await messages(b)).find(part => part.id === "invalid_variant").state.status, "error")
  assert.equal((await rpc("proof", { parentID: b, callID: "invalid_variant" })).binding, null)
  await prepare(b, "explicit_model", { model: `fixture/fixture#${explicitChoice.variants[0]}` }, [toolCall("shell", { command: probeCommand("explicit-model") }, "probe_explicit_model")])
  evidence.explicitModel = await finish(b, "explicit_model", "explicit-model", "fixture")
  assert.equal(evidence.explicitModel.binding.nativeAgent, "fixture_child")
  assert.equal(evidence.explicitModel.binding.nativeModel.id, "fixture")
  assert.equal(evidence.explicitModel.binding.nativeModel.providerID, "fixture")
  assert.equal(evidence.explicitModel.binding.nativeModel.variant, explicitChoice.variants[0])
  gate("immutable same-parent correlation, inherited shell deny and native agent/permission checks preserved")

  stage = "depth-one foreground parent interrupt"
  const cancel = await parent("Depth-one interrupt")
  await prepare(cancel, "interrupt_child", {}, ["INTERRUPT_CHILD_RELEASED"], true)
  const cancelBinding = await binding(cancel, "interrupt_child")
  await until(() => provider.holds.has(cancelBinding.childID))
  await running.client.session.interrupt({ sessionID: cancel, resume: false }, options())
  await wait(cancel); await wait(cancelBinding.childID)
  evidence.interrupt = { parent: await running.client.session.get({ sessionID: cancel }, options()),
    child: await running.client.session.get({ sessionID: cancelBinding.childID }, options()),
    childActive: Boolean((await running.client.session.active({}, options()))[cancelBinding.childID]) }
  assert.equal(evidence.interrupt.parent.outcome, "interrupted"); assert.equal(evidence.interrupt.child.outcome, "interrupted")
  assert.equal(evidence.interrupt.childActive, false)
  provider.release(cancelBinding.childID)
  gate("actual depth-one foreground interrupt measured via active state AND historical parent/child outcomes")

  stage = "explicit private child environment admission seam"
  const seam = await explicitSeam({ root, backend, provider, running, evidence, parent, prepare, binding, finish, wait, until, primary,
    messages, tools, rpc, cleanRoot, readProbe, probeCommand, toolCall, options, profile, gate })

  stage = "actual private bridge/presence detach during foreground work"
  const detached = await parent("Detached foreground"), captured = await parent("Captured disposed wrapper"), detachedBeforeGate = await parent("Bridge gone before child gate"), disposing = await parent("Dispose during real write")
  await prepare(detached, "detached_child", {}, [toolCall("shell", { command: probeCommand("detached") }, "probe_detached")], true)
  const detachedBinding = await binding(detached, "detached_child")
  await until(() => provider.holds.has(detachedBinding.childID))
  provider.holdNext.add(captured)
  await prepare(captured, "captured_disposed")
  await until(() => provider.holds.has(captured))
  provider.holdNext.add(detachedBeforeGate)
  await prepare(detachedBeforeGate, "detached_before_gate")
  await until(() => provider.holds.has(detachedBeforeGate))
  await prepare(disposing, "dispose_during_write", {}, [], false, { fault: "hold-real-write-settlement" })
  await until(() => backend.admission.holds.has("dispose_during_write"))
  await backend.detach()
  evidence.explicit.rejected.disposal = await seam.rejection(disposing, "dispose_during_write")
  await running.client.session.shell({ sessionID: evidence.explicit.rejected.disposal.childID, command: probeCommand("disposed-snapshot") }, options())
  evidence.explicit.disposedSnapshot = cleanRoot(await readProbe("disposed-snapshot"))
  provider.release(detachedBeforeGate)
  evidence.explicit.rejected.detachedBeforeGate = await seam.rejection(detachedBeforeGate, "detached_before_gate")
  assert(!backend.admission.trace.some(entry => entry.callID === "dispose_during_write" && entry.operation === "admitted"))
  assert((await running.client.session.active({}, options()))[detachedBinding.childID])
  provider.release(detachedBinding.childID)
  evidence.detached = await finish(detached, "detached_child", "detached")
  seam.matches(evidence.detached, "A2")
  assert.equal(evidence.detached.child.outcome, "succeeded")
  assert.equal((await running.client.session.get({ sessionID: detached }, options())).outcome, "succeeded")
  gate("real bridge manifest/server and Missions presence removed; already-bound foreground operation completes natively")
  gate("detach before gate and disposal during real write settlement deny progress before first child model; already-cleaned denied snapshot is not consumption")
  await rpc("disposeWrapper")
  provider.release(captured); await wait(captured)
  assert.equal(tools(await messages(captured)).find(part => part.id === "captured_disposed").state.status, "error")
  assert.equal((await rpc("proof", { parentID: captured, callID: "captured_disposed" })).binding, null)
  gate("captured native wrapper fails closed after its actual transformation disposal")
  evidence.explicit.failClosedBeforeModel = true
  evidence.sourceAfter = await hashes()
  evidence.sourcesUnchanged = JSON.stringify(evidence.sourceBefore) === JSON.stringify(evidence.sourceAfter)
  if (!evidence.sourcesUnchanged) evidence.blockers.push("Concurrent source changes: product-source qualification must be rerun on a fixed revision")
  const catalogSchemas = provider.observations.filter(record => record.kind === "primary" && record.subagentSchema).map(record => record.subagentSchema)
  assert(catalogSchemas.length > 0)
  for (const schema of catalogSchemas) assert.deepEqual(schema, catalogSchemas[0], "Native model-visible subagent schema unchanged across rounds")
  evidence.nativeSubagentSchema = catalogSchemas[0]
  evidence.counts = { parents: parents.length, providerRequests: provider.observations.length, events: events.length, registeredContracts: calls.size }
  const ids = new Set([...parents, ...events.filter(event => event.type === "session.created").map(event => event.data.sessionID)])
  const removedChild = evidence.explicit?.rejected.api?.childID
  await writeFile(path.join(root, "transcripts.json"), JSON.stringify(Object.fromEntries(await Promise.all([...ids].map(async id =>
    [id, id === removedChild ? { removedByPrivateNativeAPIRejectionProbe: true } : await messages(id)]))), null, 2))
  evidence.skipped = [{ gate: "durable-two-generation-Pause-Stop-before-child-environment-admission", status: "unsupported/unqualified",
    reason: "Explicit environment seam measured via authenticated backend, but private seeded correlation/lifecycle generations are not signed durable native authority" }]
  assert(!provider.failure && !provider.observationFailure && !failure)
  evidence.status = "passed-capabilities"
} catch (error) {
  evidence.status = "failed"; evidence.failure = { stage, error: String(error), stack: error.stack }; process.exitCode = 1
  console.error(`FAIL ${stage}: ${root}: ${String(error)}`)
} finally {
  subscription.abort()
  try {
    const cleanup = await Promise.allSettled([backend?.close(), provider?.close()])
    evidence.resourceCleanup = cleanup.map(result => result.status === "fulfilled" ? "fulfilled" : String(result.reason))
    await running?.stop()
    if (cleanup.some(result => result.status === "rejected")) throw new Error("Private resource cleanup failed")
    if (sentinel) {
      const after = await sentinel.client.server.info(options())
      assert.equal(after.pid, evidence.sentinel.pid)
      assert.equal((await sentinel.client.session.get({ sessionID: evidence.sentinel.sessionID }, options())).id, evidence.sentinel.sessionID)
      evidence.sentinel.survivedMainCleanup = true
    }
  } catch (error) { evidence.status = "failed-cleanup"; evidence.cleanupFailure = String(error); process.exitCode = 1; console.error(String(error)) }
  finally {
    await sentinel?.stop()
    if (root) {
      await writeFile(path.join(root, "results.json"), JSON.stringify(evidence, null, 2))
      await writeFile(path.join(root, "requests.json"), JSON.stringify(provider?.observations ?? [], null, 2))
      await writeFile(path.join(root, "events.json"), JSON.stringify(events, null, 2))
      await writeFile(path.join(root, "contracts.json"), JSON.stringify([...calls.values()], null, 2))
      await writeFile(path.join(root, "profiles.json"), JSON.stringify(settingsTrace, null, 2))
      await writeFile(path.join(root, "serve.log"), running?.logs ?? "")
      await writeFile(path.join(root, "admission-trace.json"), JSON.stringify(backend?.admission.trace ?? [], null, 2))
    }
    for (const key of Object.keys(process.env)) if (!(key in previousEnvironment)) delete process.env[key]
    Object.assign(process.env, previousEnvironment)
  }
  if (!process.exitCode) console.log(`PASS foreground capabilities ONLY (product qualification remains blocked): ${root}`)
}
