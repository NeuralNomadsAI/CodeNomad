// Private authority qualification. No service discovery/start/reload or user runtime access.
import assert from "node:assert/strict"
import { spawn, execFileSync } from "node:child_process"
import { generateKeyPairSync, randomUUID } from "node:crypto"
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import { build } from "esbuild"
import { OpenCode } from "@opencode/client"
import { tsImport } from "tsx/esm/api"
import pino from "pino"
import { canonical, envelope, POLICY, RPC } from "./missions-authority-spike/protocol.mjs"
import { claimFamily, familyIdentity, inspectFamily } from "./missions-authority-spike/family-ownership.mjs"
import { atomicJSON, freshSettings, startBroker } from "./missions-authority-spike/broker.mjs"
import { startProvider } from "./missions-authority-spike/provider.mjs"

const allowedCLI = "C:/Users/Admin/AppData/Roaming/npm/node_modules/@opencode/cli/bin/opencode.exe"
const cli = process.argv[2] ?? allowedCLI
assert.equal(path.resolve(cli).toLowerCase(), path.resolve(allowedCLI).toLowerCase(), "Only the assigned absolute CLI, as a private serve child")
const temporary = "C:/Users/Admin/AppData/Local/Temp/opencode"
await mkdir(temporary, { recursive: true })
const root = await mkdtemp(path.join(temporary, "missions-authority-"))
console.log(`Private authority fixture: ${root}`)
const project = path.join(root, "project"), config = path.join(root, "config"), settingsFile = path.join(root, "profile.json")
for (const directory of [project, config, path.join(root, "hooks-disabled")]) await mkdir(directory)
for (const key of Object.keys(process.env)) if (/^(OPENCODE_|XDG_|CODENOMAD_)/i.test(key)) delete process.env[key]
for (const key of ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) process.env[key] = path.join(root, key)
Object.assign(process.env, { HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root, OPENCODE_TEST_HOME: root,
  XDG_RUNTIME_DIR: root, OPENCODE_CONFIG_DIR: config, OPENCODE_DB: path.join(root, "fixture.db"),
  OPENCODE_SERVER_PASSWORD: "private-authority", OPENCODE_CONFIG_PROJECT_DISABLE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_FFF: "1",
  GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(root, "gitconfig-empty"), AUTHORITY_MARKER: "base" })
delete process.env.WSL_DISTRO_NAME
await writeFile(process.env.GIT_CONFIG_GLOBAL, "")
await writeFile(path.join(config, "opencode.json"), "{}\n")
await atomicJSON(settingsFile, { environmentVariables: { AUTHORITY_MARKER: "first" } })
execFileSync("git", ["init", project], { stdio: "pipe", windowsHide: true })
execFileSync("git", ["-C", project, "-c", "user.name=Private Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false",
  "-c", `core.hooksPath=${path.join(root, "hooks-disabled")}`, "commit", "--allow-empty", "-m", "Private authority fixture"], { stdio: "pipe", windowsHide: true })
await writeFile(path.join(project, "probe.cjs"), `require('node:fs').writeFileSync(process.argv[2],JSON.stringify({marker:process.env.AUTHORITY_MARKER,path:!!process.env.PATH,password:process.env.OPENCODE_SERVER_PASSWORD,bridge:process.env.CODENOMAD_AUTOMATION_BRIDGE_TOKEN,db:process.env.OPENCODE_DB}))`)
const { WorkspaceManager } = await tsImport("../packages/server/src/workspaces/manager.ts", import.meta.url)
const { EventBus } = await tsImport("../packages/server/src/events/bus.ts", import.meta.url)
const { rememberRuntime } = await tsImport("../packages/server/src/opencode/compatibility/runtime.ts", import.meta.url)
const { WorktreeDeletionFence } = await tsImport("../packages/server/src/workspaces/worktree-session-evacuation.ts", import.meta.url)
const { CODENOMAD_MISSIONS_RPC } = await tsImport("../packages/server/src/missions/rpc.ts", import.meta.url)
const { assignmentInput } = await tsImport("../packages/server/src/missions/inputs.ts", import.meta.url)
const location = { directory: project }, profileID = "private-profile-A", authorityID = randomUUID(), executionHost = `host-${process.platform}`
const keys = generateKeyPairSync("ed25519"), publicKey = keys.publicKey.export({ type: "spki", format: "pem" })
const token = randomUUID(), registry = path.join(root, "authority.json"), observations = { settingsReads: 0 }
const family = await familyIdentity(project), claimDirectory = path.join(root, "claims")
let claim, broker, provider, child, secondary, stopped, manager, client, stage = "family claims", output = "", requestIndex = 0, grant, challenge, mission
const evidence = { gates: [], observations, capabilities: { desktop: false, automation: false, workflowScheduler: false } }
const gate = name => { evidence.gates.push(name); console.log(`PASS ${name}`) }
async function until(predicate, label = stage) {
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    if (provider?.failure) throw provider.failure
    if (await predicate()) return
    if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error(output.slice(-4000))
    await delay(50)
  }
  throw new Error(`Private timeout: ${label}`)
}
const ownershipChild = fileURLToPath(new URL("./missions-authority-spike/ownership-child.mjs", import.meta.url))
async function contender(directory, profile, mode = "once") {
  const process = spawn(globalThis.process.execPath, [ownershipChild, directory, family, profile, mode], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
  let text = ""
  process.stdout.on("data", data => { text += data })
  const closed = new Promise(resolve => process.once("close", resolve))
  await until(() => text.includes("\n"), "family claim child receipt")
  return { process, closed, receipt: JSON.parse(text.trim().split("\n")[0]) }
}
const nonceChallenge = async (target = client) => {
  const nonce = randomUUID(), result = await target.rpc(RPC).challenge({ nonce }, { location, signal: AbortSignal.timeout(15_000) })
  assert.equal(result.nonce, nonce)
  assert.equal(result.policy, POLICY)
  return result
}
const signed = (method, payload, overrides = {}) => envelope({ version: 1, authorityID, profileID, executionHost, epoch: grant?.epoch ?? 1,
  namespace: challenge.namespace, projectID: challenge.projectID, projectCanonical: challenge.projectCanonical, roots: [challenge.directory],
  method, missionID: mission?.id ?? null, expectedRevision: mission?.revision ?? 0, requestID: `authority-${++requestIndex}`, payload, ...overrides }, keys.privateKey)
const privileged = input => client.rpc(RPC).privileged(input, { location, signal: AbortSignal.timeout(30_000) })
const snapshot = async () => (await client.rpc(CODENOMAD_MISSIONS_RPC).snapshot({}, { location })).missions.find(m => m.id === mission.id)
const wait = sessionID => client.session.wait({ sessionID }, { signal: AbortSignal.timeout(20_000) })
const primary = id => provider.requests.filter(r => r.kind === "primary" && r.sessionID === id)
const persistGrant = async value => atomicJSON(registry, { version: 1, state: "active", policy: POLICY, family, profileID, grant: value })
const invoke = (tool, input, sessionID = mission.coordinatorSessionId, method = "invoke", extra = {}) => privileged(signed(method,
  { coordinatorID: mission.coordinatorSessionId, tool, input, sessionID, ...extra }))
const action = async (name, supplied) => {
  mission = await snapshot()
  const requestID = `authority-control-${++requestIndex}`
  const command = supplied ?? signed("lifecycle", { coordinatorID: mission.coordinatorSessionId, missionID: mission.id,
    expectedRevision: mission.revision, requestID, action: name }, { requestID })
  if (name === "stop") { grant = { ...grant, state: "revoked" }; await persistGrant(grant) }
  const result = await privileged(command)
  mission = result.mission
  if (name === "stop") { grant = { ...grant, state: "revoked" }; await persistGrant(grant) }
  return command
}
const probe = async (sessionID, expected, label) => {
  const file = `${label}.json`
  await client.session.shell({ sessionID, command: `node probe.cjs ${file}` })
  const result = JSON.parse(await readFile(path.join(project, file), "utf8"))
  assert.deepEqual(result, { marker: expected, path: true })
  evidence.observations[label] = result
}
let brokerOptions
async function launch(environment = process.env) {
  let logs = "", launchFailure
  const process = spawn(cli, ["serve", "--hostname", "127.0.0.1", "--port", "0", "--print-logs"], { cwd: root, env: environment, windowsHide: true })
  const closed = new Promise(resolve => process.once("close", resolve))
  process.once("error", error => { launchFailure = error })
  process.stdout.on("data", data => { logs += data })
  process.stderr.on("data", data => { logs += data })
  try { await until(() => { if (launchFailure) throw launchFailure; return /http:\/\/127\.0\.0\.1:\d+/.test(logs) }, "private serve URL") }
  catch (error) { process.kill(); await closed; throw error }
  const url = logs.match(/http:\/\/127\.0\.0\.1:\d+/)[0]
  const authorization = `Basic ${Buffer.from(`opencode:${environment.OPENCODE_SERVER_PASSWORD}`).toString("base64")}`
  return { process, closed, url, native: OpenCode.make({ baseUrl: url, headers: { authorization } }), logs: () => logs }
}
try {
  claim = await claimFamily(claimDirectory, family, profileID)
  for (const profile of [profileID, "private-profile-B"]) {
    const duplicate = await contender(claimDirectory, profile)
    assert.equal(duplicate.receipt.acquired, false)
    assert.match(duplicate.receipt.error, /ownership conflict/)
    await duplicate.closed
  }
  const crashDirectory = path.join(root, "crash-claims"), heldClaim = await contender(crashDirectory, "private-crash", "hold")
  assert.equal(heldClaim.receipt.acquired, true)
  heldClaim.process.kill()
  await heldClaim.closed
  const stale = await inspectFamily(crashDirectory, family)
  assert.equal(stale.pidAlive, false)
  await assert.rejects(claimFamily(crashDirectory, family, profileID), /ownership conflict/)
  evidence.staleClaim = { pidAlive: stale.pidAlive, reclaim: stale.reclaim }
  gate("atomic family ownership rejects duplicate broker/profiles; dead PID is not stolen")

  stage = "private durable plugin and backend"
  provider = await startProvider()
  brokerOptions = { claim, profileID, authorityID, executionHost, token, registry, location, missionsRPC: CODENOMAD_MISSIONS_RPC, fence: new WorktreeDeletionFence() }
  broker = await startBroker(brokerOptions)
  const pluginDirectory = path.join(root, "authority-plugin")
  await mkdir(pluginDirectory)
  const entry = path.join(root, "entry.mjs"), modulePath = fileURLToPath(new URL("./missions-authority-spike/plugin.mjs", import.meta.url)).replaceAll("\\", "/")
  await writeFile(entry, `import { authorityPlugin } from ${JSON.stringify(modulePath)}; export default authorityPlugin(${JSON.stringify({ publicKey, profileID, authorityID, executionHost, token, bridge: broker.url })});`)
  await build({ entryPoints: [entry], outfile: path.join(pluginDirectory, "index.mjs"), bundle: true, platform: "node", format: "esm", target: "node22" })
  process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ model: "fixture/fixture", update: "disable", snapshots: false,
    permissions: [{ action: "*", resource: "*", effect: "allow" }, { action: "browser", resource: "*", effect: "deny" }], providers: { fixture: { package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL: provider.url, apiKey: "private" }, models: { fixture: {} } } }, plugins: [pluginDirectory] })
  const running = await launch()
  child = running.process; stopped = running.closed; client = running.native; output = running.logs()
  const info = await client.server.info()
  assert.equal(info.version, "2.0.21")
  evidence.nativeVersion = info.version
  const endpoint = { url: running.url, auth: { type: "basic", username: "opencode", password: process.env.OPENCODE_SERVER_PASSWORD } }
  rememberRuntime(endpoint, { version: info.version, pid: info.pid, discovery: "info" })
  manager = new WorkspaceManager({ rootDir: root, logger: pino({ level: "silent" }), eventBus: new EventBus(), settings: freshSettings(settingsFile, observations),
    binaryResolver: { resolveDefault: () => ({ path: cli, label: "Private authority fixture" }) },
    hostServiceLifecycleFactory: () => ({ discover: async () => endpoint, ensure: async () => endpoint }) })
  const { workspace } = await manager.create(project)
  brokerOptions.manager = manager; brokerOptions.client = client
  challenge = await nonceChallenge()
  await writeFile(path.join(root, "native-capabilities.json"), JSON.stringify(challenge, null, 2))
  assert(!challenge.tools.some(t => /^codenomad_/.test(t)))
  evidence.nativeCapabilities = { environment: challenge.sessionMethods.includes("environment"), inbox: challenge.sessionMethods.includes("inbox"),
    sessionMethods: challenge.sessionMethods, tools: challenge.tools, admissionUses: "authenticated-backend-only" }
  gate("durable plugin with zero desktop/browser capabilities; installed session methods measured")

  stage = "privileged authentication and explicit adoption"
  const coordinator = await client.session.create({ location, title: "Private authority coordinator" })
  const creationID = `create-${randomUUID()}`
  const creation = signed("create", { requestID: creationID, coordinatorSessionID: coordinator.id, prepared: true, objective: "Private authority continuity", template: "custom" }, { requestID: creationID })
  mission = (await privileged(creation)).mission
  assert.equal(mission.runState, "prepared")
  assert.equal(primary(coordinator.id).length, 0)
  await assert.rejects(client.rpc(CODENOMAD_MISSIONS_RPC).lifecycle({ missionID: mission.id, requestID: "unsigned-play", expectedRevision: mission.revision, action: "start" }, { location }))
  await assert.rejects(client.rpc(CODENOMAD_MISSIONS_RPC).create({ requestID: "legacy-create", objective: "Not admitted", template: "custom" }, { location }))
  await assert.rejects(client.rpc(CODENOMAD_MISSIONS_RPC).update({ missionID: mission.id, requestID: "legacy-update", expectedRevision: mission.revision, objective: "Not admitted" }, { location }))
  await assert.rejects(client.rpc(CODENOMAD_MISSIONS_RPC).delete({ missionID: mission.id, requestID: "legacy-delete", expectedRevision: mission.revision }, { location }))
  const unauthenticated = await broker.app.inject({ method: "POST", url: "/admission", payload: {} })
  assert.equal(unauthenticated.statusCode, 403)
  const adoption = signed("adopt", { coordinatorID: coordinator.id })
  const forged = structuredClone(adoption); forged.body.profileID = "other"
  await assert.rejects(privileged(forged))
  await assert.rejects(privileged(envelope(adoption.body, generateKeyPairSync("ed25519").privateKey)))
  for (const overrides of [{ namespace: randomUUID() }, { profileID: "private-profile-B" }, { roots: [path.join(project, "foreign")] }, { executionHost: "other-host" }, { expectedRevision: 0 }]) {
    await assert.rejects(privileged(signed("adopt", { coordinatorID: coordinator.id }, overrides)))
  }
  await atomicJSON(registry, { state: "pending", profileID, policy: POLICY, family })
  grant = (await privileged(adoption)).grant
  await persistGrant(grant)
  assert.equal(primary(coordinator.id).length, 0, "Adoption alone is not Play")
  assert.deepEqual((await privileged(adoption)).grant, grant)
  await assert.rejects(privileged(envelope({ ...adoption.body, payload: { coordinatorID: coordinator.id, changed: true } }, keys.privateKey)))
  gate("Ed25519 native RPC binding, legacy mutation refusal, adoption CAS/idempotence and no auto-start")

  stage = "real admissions, fresh environment and report consumption"
  const firstPlay = await action("start")
  await wait(coordinator.id)
  assert(primary(coordinator.id).some(r => r.messages.includes(`Start or resume existing mission ${mission.id}`)))
  assert(primary(coordinator.id).every(r => !r.tools.some(t => /^browser_|codenomad_/.test(t))), "No native UI tools exposed to provider")
  // Fail-closed for mutators added by concurrent product work, not only legacy names.
  if (CODENOMAD_MISSIONS_RPC.methods.recover) {
    await assert.rejects(client.rpc(CODENOMAD_MISSIONS_RPC).recover({ missionID: mission.id, expectedRevision: mission.revision, target: "coordinator" }, { location }))
  }
  const contract = { missionID: mission.id, taskKey: "first-work", title: "Private work", brief: "Authority task", role: "worker", blockedBy: [] }
  mission = (await invoke("delegate", contract)).mission
  const actorID = mission.tasks.find(t => t.key === contract.taskKey).actorSessionId
  await wait(actorID)
  await probe(actorID, "first", "actor-first")
  await atomicJSON(settingsFile, { environmentVariables: { AUTHORITY_MARKER: "changed" } })
  mission = (await invoke("report", { missionID: mission.id, taskKey: contract.taskKey, outcome: "completed", summary: "AUTHORITY_REPORT_CONSUMED" }, actorID)).mission
  await until(() => primary(coordinator.id).some(r => r.messages.includes("AUTHORITY_REPORT_CONSUMED")))
  await wait(coordinator.id)
  await probe(coordinator.id, "changed", "coordinator-changed")
  const reportTurns = primary(coordinator.id).length
  await invoke("report", { missionID: mission.id, taskKey: contract.taskKey, outcome: "completed", summary: "AUTHORITY_REPORT_CONSUMED" }, actorID)
  await wait(coordinator.id)
  assert.equal(primary(coordinator.id).length, reportTurns)
  gate("actual provider consumption; fresh full environment before assignment, notification and Play; native shell observations")

  stage = "exact payload and settings/environment failure"
  const beforeReads = observations.settingsReads
  const invalid = assignmentInput(mission, mission.tasks.find(t => t.key === contract.taskKey))
  invalid.text += " FORGED"
  const rejected = await broker.app.inject({ method: "POST", url: "/admission", headers: { authorization: `Bearer ${token}` }, payload: { coordinatorID: coordinator.id, kind: "prompt", input: invalid, grant } })
  assert.equal(rejected.statusCode, 409)
  assert.equal(observations.settingsReads, beforeReads, "Contract mismatch cannot reach environment")
  const countSends = () => broker.trace.filter(t => t.operation === "prompt" || t.operation === "synthetic").length
  const failureTask = { ...contract, taskKey: "environment-failure" }
  await writeFile(settingsFile, "{broken")
  const sendsBefore = countSends()
  await assert.rejects(invoke("delegate", failureTask))
  assert.equal(countSends(), sendsBefore)
  const dispatching = await snapshot(), pendingTask = dispatching.tasks.find(t => t.key === failureTask.taskKey)
  assert.equal(pendingTask.status, "dispatching")
  const forgedPending = assignmentInput(dispatching, pendingTask)
  forgedPending.text += " FORGED_PENDING"
  const malformed = await broker.app.inject({ method: "POST", url: "/admission", headers: { authorization: `Bearer ${token}` },
    payload: { coordinatorID: coordinator.id, kind: "prompt", input: forgedPending, grant } })
  assert.equal(malformed.statusCode, 409)
  assert.equal(countSends(), sendsBefore)
  await atomicJSON(settingsFile, { environmentVariables: { AUTHORITY_MARKER: "will-not-send" } })
  broker.faults.environment = true
  await assert.rejects(invoke("delegate", failureTask))
  assert.equal(countSends(), sendsBefore)
  await atomicJSON(settingsFile, { environmentVariables: {} })
  mission = (await invoke("delegate", failureTask)).mission
  const failureActor = mission.tasks.find(t => t.key === failureTask.taskKey).actorSessionId
  await wait(failureActor)
  await probe(failureActor, "base", "override-removed")
  assert(!JSON.stringify(broker.trace).includes("PRIVATE_ENV_SECRET"))
  gate("payload matching, corrupt settings and failed environment fail closed; removal restores base; errors redacted")

  stage = "exact-root and shared worktree fence"
  const fenceTask = { ...contract, taskKey: "fenced-work" }
  const identity = await manager.getWorktreeIdentityForPath(workspace.id, project)
  const releaseFence = brokerOptions.fence.enter([identity])
  let unblock
  const mutation = brokerOptions.fence.run(identity, [identity], () => new Promise(resolve => { unblock = resolve }))
  const beforeFence = countSends()
  await assert.rejects(invoke("delegate", fenceTask))
  assert.equal(countSends(), beforeFence)
  releaseFence()
  await until(() => Boolean(unblock)); unblock(); await mutation
  mission = (await invoke("delegate", fenceTask)).mission
  const fencedActor = mission.tasks.find(t => t.key === fenceTask.taskKey).actorSessionId
  await wait(fencedActor)
  const other = path.join(root, "unowned")
  await mkdir(other)
  await client.session.move({ sessionID: fencedActor, directory: other })
  const movedSends = countSends()
  await assert.rejects(invoke("delegate", { ...contract, taskKey: "moved-work", targetSessionID: fencedActor }))
  assert.equal(countSends(), movedSends)
  await client.session.move({ sessionID: fencedActor, directory: project })
  gate("unique real manager/fence blocks in-flight family mutation; moved root cannot admit")

  stage = "partial Pause receipts and explicit retry"
  for (const id of [coordinator.id, actorID]) {
    provider.holdNext.add(id)
    // Private setup inputs are deliberately not Mission inputs; isolate lifecycle interrupt observation.
    await client.session.environment({ sessionID: id, variables: await manager.getSessionEnvironment(workspace.id) })
    await client.session.prompt({ sessionID: id, text: "PRIVATE_CONTROL_HOLD" })
    await until(() => provider.holds.has(id))
  }
  broker.faults.interruptTarget = actorID
  mission = await snapshot()
  const pauseID = `pause-${randomUUID()}`, pause = signed("lifecycle", { coordinatorID: coordinator.id, missionID: mission.id,
    requestID: pauseID, expectedRevision: mission.revision, action: "pause" }, { requestID: pauseID })
  await assert.rejects(privileged(pause))
  mission = await snapshot()
  assert.equal(mission.runState, "paused")
  assert.deepEqual(mission.control.pending, [actorID])
  const pausedCounts = countSends()
  await assert.rejects(invoke("delegate", { ...contract, taskKey: "paused-dispatch" }))
  assert.equal(countSends(), pausedCounts)
  mission = (await privileged(pause)).mission
  assert.equal(mission.control.pending.length, 0)
  for (const id of [coordinator.id, actorID]) { await wait(id); provider.release(id); assert.equal((await client.session.get({ sessionID: id })).outcome, "interrupted") }
  mission = (await invoke("report", { missionID: mission.id, taskKey: failureTask.taskKey, outcome: "completed", summary: "PAUSED_PROOF_SAVED" }, failureActor)).mission
  assert.equal(mission.reports.find(r => r.taskKey === failureTask.taskKey).notificationStatus, "pending")
  assert.equal(countSends(), pausedCounts)
  await action("start")
  await until(() => primary(coordinator.id).some(r => r.messages.includes("PAUSED_PROOF_SAVED")))
  await Promise.all(mission.actors.map(a => wait(a.sessionId)))
  gate("Pause desired state and per-target partial receipts; explicit exact retry; paused report saved without wake")

  stage = "durable namespace reload and old captured writer exclusion"
  await invoke("inspect", {}, coordinator.id, "capture", { captureID: "old-writer" })
  const namespaceBefore = challenge.namespace
  await client.debug.location.evict({ location })
  challenge = await nonceChallenge()
  assert.equal(challenge.namespace, namespaceBefore)
  await assert.rejects(invoke("inspect", {}, coordinator.id, "invoke-captured", { captureID: "old-writer" }))
  mission = await snapshot()
  gate("same namespace/journal after native location reload; disposed captured legacy executor rejected")

  stage = "explicit revoke, re-adopt and terminal Stop"
  const raceSends = countSends()
  broker.faults.afterEnvironment = () => persistGrant({ ...grant, state: "revoked" })
  await assert.rejects(invoke("delegate", { ...contract, taskKey: "revocation-race" }))
  assert.equal(countSends(), raceSends, "Revocation during native environment await prevents dispatch")
  mission = await snapshot()
  const revoke = signed("revoke", { coordinatorID: coordinator.id })
  const revokeResult = await privileged(revoke)
  assert.equal(revokeResult.revoked, true)
  grant = { ...grant, state: "revoked" }; await persistGrant(grant)
  const revokedCounts = countSends()
  await assert.rejects(invoke("delegate", { ...contract, taskKey: "revoked-work" }))
  await assert.rejects(privileged(firstPlay))
  assert.equal(countSends(), revokedCounts)
  assert.equal((await privileged(adoption)).grant.state, "revoked", "Old adoption replay cannot activate its grant")
  const newAdoption = signed("adopt", { coordinatorID: coordinator.id }, { epoch: grant.epoch + 1 })
  grant = (await privileged(newAdoption)).grant; await persistGrant(grant)
  await client.session.environment({ sessionID: actorID, variables: await manager.getSessionEnvironment(workspace.id) })
  const parked = await client.session.synthetic({ sessionID: actorID, text: "PRIVATE_MISSION_PENDING", resume: false,
    metadata: { "codenomad.mission": { missionID: mission.id, kind: "assignment" } } })
  await client.session.environment({ sessionID: actorID, variables: await manager.getSessionEnvironment(workspace.id) })
  const unrelated = await client.session.synthetic({ sessionID: actorID, text: "PRIVATE_NON_MISSION_PENDING", resume: false })
  await action("stop")
  assert.equal(mission.status, "stopped")
  assert.equal(mission.control.pending.length, 0)
  const inbox = await client.session.inbox.list({ sessionID: actorID })
  assert(!inbox.some(i => i.id === parked.id)); assert(inbox.some(i => i.id === unrelated.id))
  await assert.rejects(privileged(firstPlay))
  await assert.rejects(privileged(signed("adopt", { coordinatorID: coordinator.id }, { epoch: grant.epoch + 1 })))
  assert.equal((await snapshot()).status, "stopped")
  gate("revoke blocks sends and stale Play/adoption; terminal Stop receipts cancel only mission inbox")

  stage = "different native database rejected"
  const secondRoot = path.join(root, "second-runtime")
  await mkdir(secondRoot); await mkdir(path.join(secondRoot, "config")); await writeFile(path.join(secondRoot, "config", "opencode.json"), "{}")
  const secondEnv = { ...process.env, HOME: secondRoot, USERPROFILE: secondRoot, APPDATA: secondRoot, LOCALAPPDATA: secondRoot,
    OPENCODE_TEST_HOME: secondRoot, OPENCODE_DB: path.join(secondRoot, "different.db"), OPENCODE_CONFIG_DIR: path.join(secondRoot, "config"), XDG_RUNTIME_DIR: secondRoot }
  for (const key of ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) secondEnv[key] = path.join(secondRoot, key)
  secondary = await launch(secondEnv)
  const otherChallenge = await nonceChallenge(secondary.native)
  assert.notEqual(otherChallenge.namespace, namespaceBefore)
  await assert.rejects(secondary.native.rpc(RPC).privileged(creation, { location }))
  secondary.process.kill(); await secondary.closed; secondary = undefined
  gate("authenticated native namespace differs across private DBs; captured authorization cannot transfer")

  stage = "same database private daemon restart without auto-start"
  const requestsBeforeRestart = provider.requests.length
  await manager.shutdown(); manager = undefined
  child.kill(); await stopped; child = undefined
  const restarted = await launch()
  child = restarted.process; stopped = restarted.closed; client = restarted.native
  const restartedInfo = await client.server.info()
  const restartedEndpoint = { url: restarted.url, auth: endpoint.auth }
  rememberRuntime(restartedEndpoint, { version: restartedInfo.version, pid: restartedInfo.pid, discovery: "info" })
  manager = new WorkspaceManager({ rootDir: root, logger: pino({ level: "silent" }), eventBus: new EventBus(), settings: freshSettings(settingsFile, observations),
    binaryResolver: { resolveDefault: () => ({ path: cli, label: "Private authority restart" }) },
    hostServiceLifecycleFactory: () => ({ discover: async () => restartedEndpoint, ensure: async () => restartedEndpoint }) })
  await manager.create(project)
  brokerOptions.manager = manager; brokerOptions.client = client
  challenge = await nonceChallenge()
  assert.equal(challenge.namespace, namespaceBefore)
  assert.equal((await snapshot()).status, "stopped")
  assert.equal(challenge.grants.find(g => g.missionID === mission.id).state, "revoked")
  assert.equal(provider.requests.length, requestsBeforeRestart, "Restart/read does not wake any actor")
  await assert.rejects(privileged(firstPlay))
  gate("same native storage namespace, terminal state and revoked grant survive private daemon restart; no implicit prompt")

  for (let index = 0; index < broker.trace.length; index++) {
    const item = broker.trace[index]
    if (["prompt", "synthetic"].includes(item.operation)) assert.equal(broker.trace[index - 1]?.operation, "environment", "Every mission send has an awaited fresh environment")
  }
  evidence.trace = broker.trace
  evidence.providerRequests = provider.requests
  evidence.mission = { id: mission.id, state: mission.status, controlPending: mission.control.pending }
  evidence.settingsReads = observations.settingsReads
  evidence.verdict = "private-prototype-passed; product-migration-and-host-lifetime-unqualified"
  await writeFile(path.join(root, "evidence.json"), JSON.stringify(evidence, null, 2))
  console.log(`PASS private authority spike: ${evidence.gates.length} gates; OpenCode ${info.version}; evidence ${path.join(root, "evidence.json")}`)
} catch (error) {
  await writeFile(path.join(root, "failure.json"), JSON.stringify({ stage, message: error.message, gates: evidence.gates, trace: broker?.trace, providerRequests: provider?.requests }, null, 2))
  console.error(`Private authority spike failed at ${stage}; ${root}`)
  throw error
} finally {
  for (const id of provider?.holds.keys() ?? []) provider.release(id)
  await broker?.app.close()
  await manager?.shutdown()
  if (secondary) { secondary.process.kill(); await secondary.closed }
  if (child) { child.kill(); await stopped }
  await provider?.close()
  await claim?.release()
}
