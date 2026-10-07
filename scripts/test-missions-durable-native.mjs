// Isolated product-adapter integration ONLY. Never discover/start a shared daemon.
import assert from "node:assert/strict"
import { spawn, execFileSync } from "node:child_process"
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto"
import { mkdtemp, mkdir, readFile, writeFile, realpath } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import { build } from "esbuild"
import { OpenCode } from "@opencode/client"
import { tsImport } from "tsx/esm/api"
import pino from "pino"
import { claimFamily, familyIdentity } from "./missions-authority-spike/family-ownership.mjs"
import { atomicJSON, freshSettings } from "./missions-authority-spike/broker.mjs"
import { startProvider } from "./missions-authority-spike/provider.mjs"
import { startDurableBroker } from "./missions-durable-native/broker.mjs"
import { FIXTURE_RPC } from "./missions-durable-native/schema.mjs"
import { probeReceiptRead } from "./missions-durable-native/receipt-read.mjs"
import { clearFixtureGitEnvironment } from "./native-fixture-guards.mjs"

const allowedCLI = "C:/Users/Admin/AppData/Roaming/npm/node_modules/@opencode/cli/bin/opencode.exe"
// Current qualification target (#830). Historical 2.0.21 artifacts remain evidence
// for that runtime only; this exact pin is not the product's technical minimum.
const expectedRuntimeVersion = "2.0.22"
const cli = process.argv[2] ?? allowedCLI
assert.equal(path.resolve(cli).toLowerCase(), path.resolve(allowedCLI).toLowerCase(), "Assigned absolute private CLI only")
const previousEnvironment = { ...process.env }
const root = await mkdtemp(path.join("C:/Users/Admin/AppData/Local/Temp/opencode", "missions-durable-"))
console.log(`Private durable product fixture: ${root}`)
const project = path.join(root, "project"), config = path.join(root, "config"), settingsFile = path.join(root, "profile.json"), registry = path.join(root, "host-grant.json")
let provider, broker, manager, client, child, closed, sentinel, sentinelSession, claim, mission, challenge, grant, stage = "isolation", logs = "", counter = 0
const evidence = { gates: [], blockers: [], qualified: false, trust: "private injected construction ONLY", artifacts: root,
  observations: { settingsReads: 0 }, capabilities: { desktop: false, presence: false, background: false, managedWriter: false } }
const gate = name => { evidence.gates.push(name); console.log(`PASS ${name}`) }
const sources = ["packages/server/src/opencode/missions/durable-plugin.ts", "packages/server/src/opencode/missions-plugin.ts",
  ...["protocol", "core", "store", "rpc", "receipt", "synchronous", "admission"].map(name => `packages/server/src/missions/authority-${name}.ts`)]
const sourceHashes = async () => Object.fromEntries(await Promise.all(sources.map(async file => [file, createHash("sha256").update(await readFile(file)).digest("hex")])))
async function until(predicate, label = stage) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (provider?.failure) throw provider.failure
    if (await predicate()) return
    if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error(`Private child exited: ${logs.slice(-2500)}`)
    await delay(50)
  }
  throw new Error(`Bounded private timeout: ${label}`)
}
async function launch(environment) {
  let output = "", failure
  const process = spawn(cli, ["serve", "--hostname", "127.0.0.1", "--port", "0", "--print-logs"], { cwd: root, env: environment, windowsHide: true })
  const done = new Promise(resolve => process.once("close", resolve))
  process.once("error", error => { failure = error })
  for (const stream of [process.stdout, process.stderr]) stream.on("data", value => { output += value; logs = output })
  try { await until(() => { if (failure) throw failure; return /http:\/\/127\.0\.0\.1:\d+/.test(output) }, "private serve URL") }
  catch (error) { process.kill(); await done; throw error }
  const url = output.match(/http:\/\/127\.0\.0\.1:\d+/)[0]
  return { process, done, url, client: OpenCode.make({ baseUrl: url, headers: { authorization: `Basic ${Buffer.from(`opencode:${environment.OPENCODE_SERVER_PASSWORD}`).toString("base64")}` } }) }
}
try {
  for (const directory of [project, config, path.join(root, "hooks-disabled")]) await mkdir(directory)
  clearFixtureGitEnvironment()
  for (const key of Object.keys(process.env)) if (/^(OPENCODE_|XDG_|CODENOMAD_)/i.test(key)) delete process.env[key]
  for (const key of ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) process.env[key] = path.join(root, key)
  Object.assign(process.env, { HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root, OPENCODE_TEST_HOME: root,
    XDG_RUNTIME_DIR: root, OPENCODE_CONFIG_DIR: config, OPENCODE_DB: path.join(root, "fixture.db"),
    OPENCODE_SERVER_PASSWORD: randomUUID(), OPENCODE_CONFIG_PROJECT_DISABLE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_FFF: "1",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(root, "gitconfig-empty"), AUTHORITY_MARKER: "base" })
  delete process.env.WSL_DISTRO_NAME
  await writeFile(process.env.GIT_CONFIG_GLOBAL, "")
  await writeFile(path.join(config, "opencode.json"), "{}\n")
  await atomicJSON(settingsFile, { environmentVariables: { AUTHORITY_MARKER: "first" } })
  execFileSync("git", ["init", project], { stdio: "pipe", windowsHide: true })
  execFileSync("git", ["-C", project, "-c", "user.name=Private Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false",
    "-c", `core.hooksPath=${path.join(root, "hooks-disabled")}`, "commit", "--allow-empty", "-m", "Private product fixture"], { stdio: "pipe", windowsHide: true })
  await writeFile(path.join(project, "probe.cjs"), `require('node:fs').writeFileSync(process.argv[2],JSON.stringify({marker:process.env.AUTHORITY_MARKER,path:!!process.env.PATH,password:process.env.OPENCODE_SERVER_PASSWORD,bridge:process.env.CODENOMAD_AUTOMATION_BRIDGE_TOKEN,db:process.env.OPENCODE_DB}))`)
  evidence.sourceBefore = await sourceHashes()
  const { WorkspaceManager } = await tsImport("../packages/server/src/workspaces/manager.ts", import.meta.url)
  const { EventBus } = await tsImport("../packages/server/src/events/bus.ts", import.meta.url)
  const { rememberRuntime } = await tsImport("../packages/server/src/opencode/compatibility/runtime.ts", import.meta.url)
  const { WorktreeDeletionFence } = await tsImport("../packages/server/src/workspaces/worktree-session-evacuation.ts", import.meta.url)
  const { CODENOMAD_MISSIONS_RPC } = await tsImport("../packages/server/src/missions/rpc.ts", import.meta.url)
  const { CODENOMAD_MISSIONS_AUTHORITY_RPC: RPC } = await tsImport("../packages/server/src/missions/authority-rpc.ts", import.meta.url)
  const protocol = await tsImport("../packages/server/src/missions/authority-protocol.ts", import.meta.url)
  const { stableToken } = await tsImport("../packages/server/src/missions/journal.ts", import.meta.url)
  const family = await familyIdentity(project), physicalProject = await realpath(project)
  const profileID = "private-durable-profile", authorityID = randomUUID(), keyID = randomUUID(), executionHost = "private-windows-host", generation = randomUUID()
  const location = { directory: project }, token = randomUUID(), keys = generateKeyPairSync("ed25519")
  const publicKey = keys.publicKey.export({ type: "spki", format: "pem" })
  claim = await claimFamily(path.join(root, "claims"), family, profileID)
  provider = await startProvider()
  const options = { claim, profileID, authorityID, keyID, executionHost, token, registry, location, physicalProject,
    missionsRPC: CODENOMAD_MISSIONS_RPC, fence: new WorktreeDeletionFence(), trace: [] }
  broker = await startDurableBroker(options)
  options.port = Number(new URL(broker.url).port)
  const bridgeURL = broker.url
  const pluginDirectory = path.join(root, "product-plugin")
  await mkdir(pluginDirectory)
  const entry = path.join(root, "entry.mjs"), pluginModule = fileURLToPath(new URL("./missions-durable-native/plugin.mjs", import.meta.url)).replaceAll("\\", "/")
  await writeFile(entry, `import { fixturePlugin } from ${JSON.stringify(pluginModule)}; export default fixturePlugin(${JSON.stringify({
    publicKey, profileID, authorityID, keyID, executionHost, generation, token, bridge: broker.url, familyID: family, checkoutID: physicalProject,
    physicalProject: physicalProject.toLowerCase(),
  })});`)
  await build({ entryPoints: [entry], outfile: path.join(pluginDirectory, "index.mjs"), bundle: true, platform: "node", format: "esm", target: "node22" })
  // Private independent sentinel: its storage/auth/server must survive fixture cleanup.
  const sentinelRoot = path.join(root, "sentinel")
  await mkdir(sentinelRoot)
  const sentinelEnv = { ...process.env, HOME: sentinelRoot, USERPROFILE: sentinelRoot, OPENCODE_TEST_HOME: sentinelRoot,
    OPENCODE_CONFIG_DIR: sentinelRoot, OPENCODE_DB: path.join(sentinelRoot, "sentinel.db"), OPENCODE_CONFIG_CONTENT: "{}", OPENCODE_SERVER_PASSWORD: randomUUID() }
  for (const key of ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) sentinelEnv[key] = path.join(sentinelRoot, key)
  sentinel = await launch(sentinelEnv)
  const sentinelInfo = await sentinel.client.server.info()
  sentinelSession = await sentinel.client.session.create({ location: { directory: sentinelRoot }, title: "Private sentinel must survive main fixture cleanup" })
  evidence.sentinel = { version: sentinelInfo.version, pid: sentinelInfo.pid, sessionID: sentinelSession.id }
  process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ model: "fixture/fixture", update: "disable", snapshots: false,
    permissions: [{ action: "*", resource: "*", effect: "allow" }, { action: "browser", resource: "*", effect: "deny" }],
    providers: { fixture: { package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: provider.url, apiKey: "private" }, models: { fixture: {} } } }, plugins: [pluginDirectory] })
  stage = "actual native setup and storage"
  const running = await launch(process.env)
  child = running.process; closed = running.done; client = running.client
  const info = await client.server.info()
  evidence.nativeVersion = info.version
  assert.equal(info.version, expectedRuntimeVersion)
  const endpoint = { url: running.url, auth: { type: "basic", username: "opencode", password: process.env.OPENCODE_SERVER_PASSWORD } }
  rememberRuntime(endpoint, { version: info.version, pid: info.pid, discovery: "info" })
  manager = new WorkspaceManager({ rootDir: root, logger: pino({ level: "silent" }), eventBus: new EventBus(), settings: freshSettings(settingsFile, evidence.observations),
    binaryResolver: { resolveDefault: () => ({ path: cli, label: "Private product fixture" }) },
    hostServiceLifecycleFactory: () => ({ discover: async () => endpoint, ensure: async () => endpoint }) })
  const { workspace } = await manager.create(project)
  options.manager = manager; options.client = client
  const authorityRPC = client.rpc(RPC), missionsRPC = client.rpc(CODENOMAD_MISSIONS_RPC), fixtureRPC = client.rpc(FIXTURE_RPC)
  const rpcOptions = () => ({ location, signal: AbortSignal.timeout(30_000) })
  const nonce = randomUUID()
  challenge = await authorityRPC.challenge({ nonce }, rpcOptions())
  assert.equal(challenge.nonce, nonce); assert.equal(challenge.policy, protocol.MISSION_AUTHORITY_POLICY)
  assert.match(challenge.namespace, /^[a-f0-9-]{36}$/i)
  const capabilities = await fixtureRPC.capabilities({ token }, rpcOptions())
  evidence.nativeCapabilities = capabilities
  evidence.nativeClientSessionMethods = Object.keys(client.session)
  assert.equal(capabilities.namespace, challenge.namespace)
  assert(!capabilities.tools.some(id => /^codenomad_/.test(id)), "No desktop automation plugin tools")
  // Native browser tool definitions can exist in the registry without a browser
  // attachment. Their deny rule is separate from our absent desktop integration.
  for (const method of ["create", "get", "hook", "context"]) assert(capabilities.sessionMethods.includes(method))
  for (const method of ["environment", "inbox", "synthetic", "prompt", "interrupt"]) assert(evidence.nativeClientSessionMethods.includes(method))
  gate("genuine product setup registers native storage/RPC/tools without desktop or presence")
  stage = "native project storage scoping"
  const otherProject = path.join(root, "other-project")
  await mkdir(otherProject)
  execFileSync("git", ["init", otherProject], { stdio: "pipe", windowsHide: true })
  execFileSync("git", ["-C", otherProject, "-c", "user.name=Private Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false",
    "-c", `core.hooksPath=${path.join(root, "hooks-disabled")}`, "commit", "--allow-empty", "-m", "Separate native storage scope"], { stdio: "pipe", windowsHide: true })
  const otherNonce = randomUUID()
  const otherChallenge = await authorityRPC.challenge({ nonce: otherNonce }, { location: { directory: otherProject }, signal: AbortSignal.timeout(20_000) })
  evidence.storageScope = { firstNamespace: challenge.namespace, secondNamespace: otherChallenge.namespace,
    firstProject: challenge.projectID, secondProject: otherChallenge.projectID, firstDirectory: project, secondDirectory: otherProject }
  assert.equal(otherChallenge.nonce, otherNonce)
  assert.notEqual(otherChallenge.projectID, challenge.projectID)
  // Namespace is the native storage incarnation, NOT its project partition.
  // The authority store's document key is project-derived; test actual grant
  // isolation after writing one, rather than assuming distinct UUIDs per project.
  assert.equal((await missionsRPC.snapshot({}, { location: { directory: otherProject } })).missions.length, 0)
  gate("distinct native Git project identities observed within the storage incarnation")
  const roots = [{ mode: "git", directory: project, family, checkout: physicalProject }]
  const refresh = async () => { mission = (await missionsRPC.snapshot({}, rpcOptions())).missions.find(value => value.id === mission.id); return mission }
  const state = () => authorityRPC.state({ missionID: mission.id }, rpcOptions())
  let intents = {}
  const persist = async () => atomicJSON(registry, { policy: protocol.MISSION_AUTHORITY_POLICY, family, profileID, grant, intents })
  const signed = (method, payload, overrides = {}) => {
    const body = protocol.authorityIntentSchema.parse({ version: 1, policy: protocol.MISSION_AUTHORITY_POLICY, authorityID, keyID, profileID, executionHost,
      namespace: challenge.namespace, projectID: challenge.projectID, projectCanonical: challenge.projectCanonical, roots,
      missionID: mission?.id, coordinatorSessionID: mission?.coordinatorSessionId, expectedRevision: mission?.revision ?? 0,
      epoch: grant?.epoch ?? 0, requestID: `durable-${++counter}`, method, payload, ...overrides })
    const envelope = { body, signature: sign(null, protocol.authoritySigningBytes(body), keys.privateKey).toString("base64") }
    protocol.authenticateAuthorityIntent(envelope, [{ ...body, publicKey: keys.publicKey, provisioningGeneration: generation, qualification: "qualified" }])
    return envelope
  }
  const submit = async envelope => {
    intents[envelope.body.requestID] = { digest: protocol.authorityDigest(envelope.body), body: envelope.body }
    if (envelope.body.method === "lifecycle" && grant) grant = { ...grant, sendsEnabled: false, ...(envelope.body.payload.action === "stop" ? { state: "revoked" } : {}) }
    await persist()
    const result = await authorityRPC.intent(envelope, rpcOptions())
    grant = result.grant; await persist()
    if (mission) await refresh()
    return result
  }
  const action = async name => { await refresh(); return submit(signed("lifecycle", { action: name })) }
  const primary = id => provider.requests.filter(value => value.kind === "primary" && value.sessionID === id)
  const wait = id => client.session.wait({ sessionID: id }, { signal: AbortSignal.timeout(25_000) })
  const tool = async (sessionID, name, input) => {
    const callID = `fixture-${++counter}`
    provider.answers.set(sessionID, [{ id: callID, tool: `mission_${name}`, input }, "DURABLE_NATIVE_TOOL_DONE"])
    // Explicit private human test stimulus only, not an adapter send/fallback.
    await client.session.prompt({ sessionID, text: `Private native tool stimulus ${counter}` })
    await wait(sessionID)
    const context = await client.session.context({ sessionID })
    evidence.lastNativeContext = JSON.stringify(context).slice(-6000)
    const executed = context.flatMap(message => message.content ?? []).find(part => part.type === "tool" && part.id === callID)
    assert(executed, "Real native tool result missing")
    evidence.toolResults ??= []
    evidence.toolResults.push({ sessionID, name, callID, status: executed.state.status })
    await refresh()
    assert.equal(executed.state.status, "completed", JSON.stringify(executed.state.error))
    return context
  }
  const probe = async (id, marker, label) => {
    await client.session.shell({ sessionID: id, command: `node probe.cjs ${label}.json` })
    const observed = JSON.parse(await readFile(path.join(project, `${label}.json`), "utf8"))
    assert.deepEqual(observed, { marker, path: true }); evidence.observations[label] = observed
  }
  stage = "signed deterministic prepared create and adoption"
  const requestID = `prepared-${randomUUID()}`
  const missionID = `msn_${stableToken(`${challenge.projectID}\0${requestID}`, 24)}`
  const coordinatorID = `ses_${stableToken(`${missionID}\0coordinator`, 26)}`
  const creation = signed("create", { objective: "Private durable product mission", template: "custom", prepared: true }, { requestID, missionID, coordinatorSessionID: coordinatorID })
  const created = await submit(creation)
  assert.equal(created.receipt.completion.result.prepared, true)
  mission = { id: missionID }; await refresh()
  assert.equal(mission.coordinatorSessionId, coordinatorID); assert.equal(mission.runState, "prepared")
  assert.equal(primary(coordinatorID).length, 0)
  assert.equal((await submit(creation)).receipt.digest, created.receipt.digest)
  const otherOptions = { location: { directory: otherProject }, signal: AbortSignal.timeout(20_000) }
  const receiptProbe = async (envelope, receipt, negative = false) => {
    evidence.receiptReads ??= []
    evidence.receiptReads.push(await probeReceiptRead({ rpc: authorityRPC, protocol, intent: envelope.body, receipt,
      options: rpcOptions, otherOptions, negative, observe: async () => {
        const { generatedAt: _readTime, ...snapshot } = await missionsRPC.snapshot({}, rpcOptions())
        return { state: await state(), snapshot,
          writes: (await fixtureRPC.capabilities({ token }, rpcOptions())).productWrites, requests: provider.requests.length }
      } }))
  }
  await receiptProbe(creation, created.receipt, true)
  gate("real read-only authority receipt RPC returns exact immutable evidence; rejects foreign scope/digest without writes or sends")
  for (const [method, payload] of Object.entries({ create: { requestID: "unsigned-create", objective: "Denied", template: "custom" },
    update: { missionID, requestID: "unsigned-update", expectedRevision: mission.revision, objective: "Denied" },
    delete: { missionID, requestID: "unsigned-delete", expectedRevision: mission.revision },
    lifecycle: { missionID, requestID: "unsigned-start", expectedRevision: mission.revision, action: "start" },
    recover: { missionID, expectedRevision: mission.revision, target: "coordinator" } })) await assert.rejects(missionsRPC[method](payload, rpcOptions()))
  assert.equal((await broker.app.inject({ method: "POST", url: "/admission", payload: {} })).statusCode, 403)
  const adoption = signed("adopt", {}, { epoch: 1 })
  const forged = structuredClone(adoption); forged.body.profileID = "other"
  await assert.rejects(authorityRPC.intent(forged, rpcOptions()))
  await submit(adoption)
  assert.equal(grant.epoch, adoption.body.epoch); assert.equal(grant.sendsEnabled, false)
  assert.equal(primary(coordinatorID).length, 0)
  const isolatedState = await authorityRPC.state({ missionID }, otherOptions)
  assert.equal(isolatedState.grant, null)
  assert.deepEqual(isolatedState.pendingRequestIDs, [])
  assert.equal((await missionsRPC.snapshot({}, otherOptions)).missions.length, 0)
  await assert.rejects(authorityRPC.intent(adoption, otherOptions))
  assert.deepEqual((await state()).grant, grant)
  evidence.storageScope.otherProjectState = isolatedState
  gate("actual project-keyed authority/journal isolation; original project signature cannot mutate the other project")
  await tool(coordinatorID, "inspect", { missionID })
  gate("signed product protocol prepared creation/adoption, exact epoch, unsigned denials and real native inspect")
  stage = "real Play through WorkspaceManager and final native checkpoint"
  await action("start"); await wait(coordinatorID)
  assert(grant.sendsEnabled)
  assert(primary(coordinatorID).some(value => value.messages.includes(`Start or resume existing mission ${missionID}`)))
  await probe(coordinatorID, "first", "first-play")
  gate("Play provider consumption through authenticated bridge, real lifecycle, final checkpoint and fresh environment")
  stage = "native delegation, actor reporting and outbox consumption"
  const actor = await client.session.create({ location, title: "Private existing durable actor" })
  const contract = { missionID, taskKey: "real-work", title: "Private evidence", brief: "PRODUCT_ADAPTER_ASSIGNMENT", role: "worker", targetSessionID: actor.id,
    executionMode: { kind: "independent", reason: "playbook", explanation: "Isolated root assignment and lifecycle qualification" } }
  await tool(coordinatorID, "delegate", contract); await wait(actor.id)
  assert(primary(actor.id).some(value => value.messages.includes("PRODUCT_ADAPTER_ASSIGNMENT")))
  await probe(actor.id, "first", "first-assignment")
  await atomicJSON(settingsFile, { environmentVariables: { AUTHORITY_MARKER: "changed" } })
  const report = { missionID, taskKey: "real-work", outcome: "completed", summary: "DURABLE_REPORT_CONSUMED", evidence: ["native-provider-proof"] }
  await tool(actor.id, "report", report)
  await until(() => primary(coordinatorID).some(value => value.messages.includes(report.summary))); await wait(coordinatorID)
  assert.equal(mission.reports[0].notificationStatus, "admitted")
  await probe(coordinatorID, "changed", "report-fresh-environment")
  const turns = primary(coordinatorID).length
  await tool(actor.id, "report", report); await wait(coordinatorID)
  assert.equal(primary(coordinatorID).length, turns)
  gate("genuine native agent delegation/report tool; outbox ACK distinguished from actual coordinator consumption")
  stage = "detached backend evidence and explicit restoration"
  await tool(coordinatorID, "delegate", { ...contract, taskKey: "detached-work", brief: "ALREADY_ADMITTED_BEFORE_DETACH" }); await wait(actor.id)
  // Physically stop ONLY the owned private bridge listener. Native daemon,
  // product plugin, provider, database and sentinel all remain live.
  await broker.app.close()
  const detachedTurns = primary(coordinatorID).length
  await tool(actor.id, "inspect", { missionID })
  const detachedReport = { ...report, taskKey: "detached-work", summary: "DURABLE_DETACHED_EVIDENCE" }
  await tool(actor.id, "report", detachedReport)
  assert(mission.reports.some(value => value.summary === detachedReport.summary && value.notificationStatus === "pending"))
  assert.equal(primary(coordinatorID).length, detachedTurns)
  assert(primary(actor.id).some(value => value.messages.includes("saved mission map is not execution authorization")))
  gate("detached backend keeps native inspect/context/report evidence pending with no coordinator wake")
  stage = "explicit bridge restoration and second Play"
  const inputsBeforeRestore = broker.trace.filter(value => ["prompt", "synthetic"].includes(value.operation)).length
  broker = await startDurableBroker(options)
  assert.equal(broker.url, bridgeURL, "Explicit bridge restoration retains the trusted endpoint")
  await action("pause")
  await action("start"); await wait(coordinatorID)
  // "recover/report" asks an actor for a MISSING task report, not notification
  // recovery for an already saved report. Re-report the same native evidence to
  // explicitly retry its existing outbox identity; no background worker exists.
  await tool(actor.id, "report", detachedReport); await wait(coordinatorID)
  assert(primary(coordinatorID).some(value => value.messages.includes(detachedReport.summary)))
  const restoredInputs = broker.trace.filter(value => ["prompt", "synthetic"].includes(value.operation)).slice(inputsBeforeRestore)
  assert(!restoredInputs.some(value => value.sessionID === actor.id), "Restoration must not replay assignments")
  assert.equal(mission.reports.find(value => value.summary === detachedReport.summary).notificationStatus, "admitted")
  gate("explicit restore/Pause/Play and native saved-report retry consume evidence without replaying assignments")
  stage = "shared worktree deletion fence and late evidence preparation"
  const lateContract = { ...contract, taskKey: "late-evidence", brief: "ADMITTED_RESULT_FOR_DAMAGED_AUTHORITY" }
  const identity = await manager.getWorktreeIdentityForPath(workspace.id, project)
  const releaseFence = options.fence.enter([identity])
  assert(releaseFence)
  let unblock
  const mutation = options.fence.run(identity, [identity], () => new Promise(resolve => { unblock = resolve }))
  const promptCount = broker.trace.filter(value => value.operation === "prompt").length
  try {
    await assert.rejects(tool(coordinatorID, "delegate", lateContract))
    assert.equal(broker.trace.filter(value => value.operation === "prompt").length, promptCount)
    assert.equal(mission.tasks.find(value => value.key === lateContract.taskKey).status, "dispatching")
  } finally { releaseFence(); await until(() => Boolean(unblock), "private fence drain"); unblock(); await mutation }
  await tool(coordinatorID, "delegate", lateContract); await wait(actor.id)
  assert.equal(broker.trace.filter(value => value.operation === "prompt").length, promptCount + 1)
  const selections = await Promise.all([coordinatorID, actor.id].map(sessionID => client.session.get({ sessionID })))
  evidence.selectionsBefore = selections.map(({ id, agent, model, location }) => ({ id, agent, model, location }))
  gate("real shared directory fence vetoes native assignment; only explicit identical retry admits one input")
  stage = "signed update/recovery/pause and final host checkpoint veto"
  await submit(signed("update", { objective: "Explicit signed durable objective" }))
  assert.equal(mission.objective, "Explicit signed durable objective")
  await submit(signed("recover", { target: "coordinator" })); await wait(coordinatorID)
  await action("pause"); assert.equal(mission.runState, "paused")
  const sendsBeforeVeto = broker.trace.filter(value => value.operation === "synthetic").length
  const blockedPlay = signed("lifecycle", { action: "start" })
  broker.faults.afterEnvironment = async () => { grant = { ...grant, epoch: grant.epoch + 1 }; await persist() }
  await assert.rejects(submit(blockedPlay))
  assert.equal(broker.trace.filter(value => value.operation === "synthetic").length, sendsBeforeVeto)
  const pending = await state()
  assert(pending.pendingRequestIDs.includes(blockedPlay.body.requestID)); assert.equal(pending.grant.sendsEnabled, false)
  grant = pending.grant; await persist()
  const repeated = await submit(blockedPlay)
  assert.equal(repeated.receipt.completion, undefined)
  await receiptProbe(blockedPlay, repeated.receipt)
  assert.equal(broker.trace.filter(value => value.operation === "synthetic").length, sendsBeforeVeto)
  gate("signed update/recover/pause; changed protected epoch after preparation vetoes native effect and exact retry never replays")
  stage = "signed terminal Stop, private reload disposal and damaged authority"
  await refresh()
  const stopIntent = signed("lifecycle", { action: "stop" })
  const stopped = await submit(stopIntent); assert.equal(mission.runState, "stopped")
  await receiptProbe(stopIntent, stopped.receipt)
  await client.location.reload({ location })
  assert.equal((await fixtureRPC.staleInspector({ token }, rpcOptions())).rejected, true)
  assert.equal((await authorityRPC.challenge({ nonce: randomUUID() }, rpcOptions())).namespace, challenge.namespace)
  await receiptProbe(stopIntent, stopped.receipt)
  await fixtureRPC.damageAuthority({ token }, rpcOptions())
  await client.location.reload({ location })
  await assert.rejects(authorityRPC.challenge({ nonce: randomUUID() }, rpcOptions()))
  await assert.rejects(authorityRPC.receipt({ intent: stopIntent.body, digest: protocol.authorityDigest(stopIntent.body) }, rpcOptions()))
  await tool(actor.id, "inspect", { missionID })
  const lateReport = { ...report, taskKey: "late-evidence", summary: "NEW_DAMAGED_AUTHORITY_NATIVE_EVIDENCE" }
  const coordinatorTurnsBeforeLate = primary(coordinatorID).length
  await tool(actor.id, "report", lateReport)
  assert(mission.reports.some(value => value.summary === lateReport.summary && value.late && value.notificationStatus === "pending"))
  assert.equal(primary(coordinatorID).length, coordinatorTurnsBeforeLate)
  evidence.selectionsAfter = (await Promise.all([coordinatorID, actor.id].map(sessionID => client.session.get({ sessionID }))))
    .map(({ id, agent, model, location }) => ({ id, agent, model, location }))
  assert.deepEqual(evidence.selectionsAfter, evidence.selectionsBefore, "No agent/model/location selection changes")
  for (const [index, effect] of broker.trace.entries()) if (["prompt", "synthetic"].includes(effect.operation)) {
    assert.equal(broker.trace[index - 1].operation, "checkpoint")
    assert(broker.trace.slice(0, index).some(value => value.operation === "environment" && value.sessionID === effect.sessionID))
  }
  gate("terminal Stop; actual location unload fences captured tool; damaged native authority preserves independent journal/evidence")
  evidence.sourceAfter = await sourceHashes()
  assert.deepEqual(evidence.sourceAfter, evidence.sourceBefore, "Product source changed during run; repeat against stable reviewed sources")
  evidence.snapshot = await missionsRPC.snapshot({}, rpcOptions())
  evidence.workspace = { id: workspace.id, directory: workspace.path }
  evidence.completed = true
} catch (error) {
  evidence.blockers.push({ stage, message: error instanceof Error ? error.message : JSON.stringify(error), stack: error instanceof Error ? error.stack : undefined })
  console.error(`BLOCKED ${stage}: ${evidence.blockers[0].message}`)
  process.exitCode = 1
} finally {
  // Own children only; never enumerate/kill shared OpenCode processes.
  await manager?.shutdown().catch(() => {})
  if (child && child.exitCode === null) { child.kill(); await closed }
  if (sentinel) {
    try {
      const info = await sentinel.client.server.info()
      const preserved = await sentinel.client.session.get({ sessionID: sentinelSession.id })
      assert.deepEqual(preserved, sentinelSession)
      evidence.sentinelAfterCleanup = { version: info.version, pid: info.pid, sessionID: preserved.id, unchanged: true }
      assert.equal(info.pid, sentinel.process.pid)
    }
    catch (error) { evidence.blockers.push({ stage: "sentinel preservation", message: error.message }); process.exitCode = 1 }
    sentinel.process.kill(); await sentinel.done
  }
  await broker?.app.close()
  await provider?.close()
  await claim?.release()
  evidence.transport = broker?.trace ?? []
  evidence.provider = provider?.requests ?? []
  evidence.sourceAfter ??= await sourceHashes()
  await writeFile(path.join(root, "result.json"), JSON.stringify(evidence, null, 2))
  await writeFile(path.join(root, "native.log"), logs)
  for (const key of Object.keys(process.env)) if (!(key in previousEnvironment)) delete process.env[key]
  Object.assign(process.env, previousEnvironment)
  console.log(`Artifacts: ${path.join(root, "result.json")}`)
}
