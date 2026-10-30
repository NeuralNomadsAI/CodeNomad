import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { createHash, randomBytes } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { setTimeout as sleep } from "node:timers/promises"
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"
import { buildNativeScheduleFoundation } from "../packages/server/scripts/build-native-schedule-foundation.mjs"

const [cli, root] = process.argv.slice(2)
const statusOnly = process.argv.includes("--status-only")
const coldMissing = process.argv.find(value => value.startsWith("--cold-missing="))?.split("=")[1]
const controlledMaintenance = process.argv.includes("--controlled-maintenance")
assert(!coldMissing || ["runtime", "provider"].includes(coldMissing), "cold missing artifact must be runtime or provider")
assert([statusOnly, !!coldMissing, controlledMaintenance].filter(Boolean).length <= 1, "choose one qualification mode")
assert(cli && path.isAbsolute(cli) && root && path.isAbsolute(root), "absolute isolated CLI and fresh scratch directory required")
assert(!existsSync(root), "Preserve existing evidence; use a fresh scratch child")
mkdirSync(root, { recursive: true })
const save = (name, value) => { writeFileSync(path.join(root, `${name}.json`), JSON.stringify(value, null, 2)); return value }
const log = event => appendFileSync(path.join(root, "harness.jsonl"), JSON.stringify({ at: Date.now(), ...event }) + "\n")
const eventsFile = path.join(root, "native.jsonl")
const events = () => existsSync(eventsFile) ? readFileSync(eventsFile, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : []
const env = {}
for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) if (process.env[key]) env[key] = process.env[key]
for (const role of ["CONFIG", "STATE", "DATA", "CACHE"]) env[`XDG_${role}_HOME`] = path.join(root, role.toLowerCase())
Object.assign(env, { XDG_RUNTIME_DIR: path.join(root, "runtime"), HOME: path.join(root, "home"), USERPROFILE: path.join(root, "home"),
  APPDATA: path.join(root, "appdata"), LOCALAPPDATA: path.join(root, "localappdata"), ProgramData: path.join(root, "programdata"),
  TEMP: path.join(root, "tmp"), TMP: path.join(root, "tmp"), PATH: "C:\\Windows\\System32;C:\\Program Files\\Git\\cmd",
  OPENCODE_DISABLE_PROJECT_CONFIG: "true", OPENCODE_DISABLE_CLAUDE_CODE: "true", OPENCODE_DISABLE_MODELS_FETCH: "true",
  OPENCODE_DISABLE_FILEWATCHER: "true", OPENCODE_DISABLE_FFF: "true", OPENCODE_LOG_LEVEL: "DEBUG" })
for (const [key, value] of Object.entries(env))
  if (key.startsWith("XDG_") || ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "ProgramData", "TEMP", "TMP"].includes(key))
    mkdirSync(value, { recursive: true })
const project = path.join(root, "project"), configRoot = path.join(env.XDG_CONFIG_HOME, "opencode")
mkdirSync(project); mkdirSync(configRoot, { recursive: true })
const registrationFile = path.join(env.XDG_STATE_HOME, "opencode", "service.json")
const providerRequests = []
const spy = createServer(async (req, res) => { providerRequests.push({ method: req.method, path: req.url }); res.writeHead(500).end("Provider HTTP forbidden") })
await new Promise(resolve => spy.listen(0, "127.0.0.1", resolve))
const spyPort = spy.address().port
assert.notEqual(spyPort, 28894)
const portServer = createServer()
await new Promise(resolve => portServer.listen(0, "127.0.0.1", resolve))
const port = portServer.address().port
await new Promise(resolve => portServer.close(resolve))
assert.notEqual(port, 28894)
const owned = []
let current, client, endpoint
const wait = async (predicate, timeout = 30_000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await predicate()) return
    if (current?.exitCode !== null && current?.exitCode !== undefined) throw new Error("Isolated service exited")
    await sleep(100)
  }
  throw new Error("Bounded native qualification wait expired")
}
const stop = async child => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  child.kill("SIGKILL")
  await new Promise(resolve => child.once("exit", resolve))
}
const launch = async label => {
  const child = spawn(cli, ["serve", "--service", "--hostname", "127.0.0.1", "--port", String(port)],
    { cwd: project, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
  owned.push(child); current = child
  const output = { stdout: "", stderr: "" }
  child.stdout.on("data", value => { output.stdout += value })
  child.stderr.on("data", value => { output.stderr += value })
  child.once("exit", () => {
    writeFileSync(path.join(root, `${label}-stdout.txt`), output.stdout)
    writeFileSync(path.join(root, `${label}-stderr.txt`), output.stderr)
  })
  await wait(async () => {
    if (!existsSync(registrationFile)) return false
    const registration = JSON.parse(readFileSync(registrationFile))
    if (registration.pid !== child.pid) return false
    endpoint = await Service.discover({ file: registrationFile, version: "2.2.3" })
    return !!endpoint
  })
  assert.equal(endpoint.url, `http://127.0.0.1:${port}`)
  const { id, pid, url, version } = JSON.parse(readFileSync(registrationFile))
  save(label, { id, pid, url, version })
  client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
  return { id, pid, url, version }
}
const definition = { id: "codenomad.schedule-qualification", methods: Object.fromEntries(
  ["initialize", "snapshot", "forceTitle", "ordinary", "replay", "claimOnly"].map(name => [name, { input: { type: "object" }, output: { type: "object" } }])), events: {} }
const qa = (name, input = {}) => client.rpc(definition)[name](input, { location: { directory: project }, signal: AbortSignal.timeout(20_000) })
const observerDefinition = { id: "codenomad.schedule-clock-qualification", methods: {
  tick: { input: { type: "object" }, output: { type: "object" } }, snapshot: { input: { type: "object" }, output: { type: "object" } },
}, events: {} }
const observe = (name, input) => client.rpc(observerDefinition)[name](input, { location: { directory: project }, signal: AbortSignal.timeout(20_000) })
let artifacts, principal, reconciliation, principalSchedule, reconciliationSchedule
try {
  artifacts = await buildNativeScheduleFoundation(path.join(root, "artifacts"), { qualification: true })
  const config = { "$schema": "https://opencode.ai/config.json", snapshots: false, update: "disable", experimental: { schedules: true },
    plugins: [{ package: path.dirname(artifacts.qualification.file), options: { registrationFile, provider: artifacts.provider,
      runtime: artifacts.qualification, logFile: eventsFile, loseFirstReply: !coldMissing && !controlledMaintenance,
      holdCompaction: controlledMaintenance } },
      ...(coldMissing || controlledMaintenance ? [{ package: path.dirname(artifacts.observer.file) }] : [])],
    model: "codenomad-missions-local/schedule-noop", agents: { title: { model: "remote-aux/forbidden" }, compaction: { model: "remote-aux/forbidden" } },
    providers: {
      "codenomad-missions-local": { name: "Owned local carrier", package: `aisdk:${pathToFileURL(artifacts.provider.file).href}`,
        models: { "schedule-noop": { limit: { context: 32000, output: 4096 } } } },
      "remote-aux": { name: "Forbidden auxiliary network", package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: `http://127.0.0.1:${spyPort}/v1`, apiKey: "fixture-only" }, models: { forbidden: { limit: { context: 32000, output: 4096 } } } },
    } }
  writeFileSync(path.join(configRoot, "opencode.json"), JSON.stringify(config))
  writeFileSync(path.join(configRoot, "service.json"), JSON.stringify({ hostname: "127.0.0.1", port, disabled: false }))
  save("isolation", { cli, cliSHA256: createHash("sha256").update(readFileSync(cli)).digest("hex"), root, project, port, spyPort,
    backend: "absent", sharedServiceAccess: "none", environmentKeys: Object.keys(env), artifacts,
    nativeIntervalMinutes: controlledMaintenance ? 90 : 1, productIntervalMinutes: 90, coldMissing, controlledMaintenance,
    scope: "reconciliation without passage; product mapping owner absent" })
  await launch("first-incarnation")
  const model = { providerID: "codenomad-missions-local", id: "schedule-noop" }
  const create = role => client.session.create({ title: "Mission schedule carrier", location: { directory: project }, model,
    metadata: { "codenomad.schedule-carrier": { missionID: "native_foundation", timeGeneration: 1, role, slot: 0 } } })
  principal = await create("principal")
  if (coldMissing || controlledMaintenance) {
    const now = Date.now(), info = { ...principal, id: `ses_qualification_${randomBytes(12).toString("hex")}`,
      metadata: { "codenomad.schedule-carrier": { missionID: "native_foundation", timeGeneration: 1, role: "reconciliation", slot: 0 } },
      agent: "build", outcome: "succeeded", time: { created: now - 10, updated: now, idle: now }, title: "Mission schedule carrier" }
    const seedText = "Native bounded carrier history for automatic compaction. ".repeat(3000)
    const tokenFixture = { input: 40000, output: 4, reasoning: 0, cache: { read: 0, write: 0 } }
    reconciliation = await client.experimental.session.import({ location: { directory: project }, info, messages: [
      { id: "msg_qualification_seed_user", type: "user", time: { created: now - 6 }, text: seedText },
      { id: "msg_qualification_seed_assistant", type: "assistant", time: { created: now - 5, completed: now - 4 }, agent: "build", model,
        content: [{ type: "text", text: "Seed history complete." }], cost: 0, tokens: tokenFixture, finish: "stop" },
      { id: "msg_qualification_seed_idle", type: "idle", time: { created: now - 3 }, outcome: "succeeded" },
    ] })
    save("seed-history", { method: "official native import before calendar arming; same technical identity retained thereafter",
      sessionID: reconciliation.id, textCharacters: seedText.length, textSHA256: createHash("sha256").update(seedText).digest("hex"),
      measuredTokensFixture: tokenFixture, contextLimit: 32000, automaticCompactionVerifiedByHealthyControl: controlledMaintenance })
  } else reconciliation = await create("reconciliation")
  const signal = "CODENOMAD_MISSION_SCHEDULE_WAKE"
  principalSchedule = await client.experimental.schedule.create({ sessionID: principal.id, when: { every: "90 minutes" },
    ends: { after: "91 minutes", times: 3 }, prompt: signal, name: "foundation-principal-phase" })
  reconciliationSchedule = await client.experimental.schedule.create({ sessionID: reconciliation.id, when: { every: controlledMaintenance ? "90 minutes" : "1 minute" },
    ends: controlledMaintenance ? { times: 3, after: "181 minutes" } : { times: 4 }, prompt: signal, name: "foundation-native-carrier-qualification" })
  if (controlledMaintenance) await client.experimental.schedule.pause({ scheduleID: principalSchedule.id })
  save("document-initial", await qa("initialize", { principal: { sessionID: principal.id, scheduleID: principalSchedule.id },
    reconciliation: { sessionID: reconciliation.id, scheduleID: reconciliationSchedule.id } }))
  if (coldMissing) {
    const initial = save("cold-before", await observe("snapshot", { sessionID: reconciliation.id, scheduleID: reconciliationSchedule.id }))
    const nativeCount = events().length, firstPID = current.pid
    await stop(current)
    const artifact = coldMissing === "runtime" ? artifacts.qualification : artifacts.provider
    renameSync(artifact.file, `${artifact.file}.held`)
    const cold = await launch(`cold-missing-${coldMissing}`)
    assert.notEqual(cold.pid, firstPID)
    log({ kind: "cold-negative-no-project-client-start", pid: cold.pid, missing: coldMissing })
    // The original every:1-minute native schedule fires naturally. No tick RPC,
    // prompt, context read or other project client warms the cold Location here.
    await sleep(Math.max(0, reconciliationSchedule.nextDueAt - Date.now()) + 5000)
    log({ kind: "cold-negative-no-project-client-end", pid: cold.pid, providerHTTP: providerRequests.length })
    const after = save("cold-after", await observe("snapshot", { sessionID: reconciliation.id, scheduleID: reconciliationSchedule.id }))
    save("cold-plugin-diagnostics", await client.plugin.list({ location: { directory: project } }))
    assert.equal(after.session.id, initial.session.id)
    assert.equal(after.schedule.id, initial.schedule.id)
    assert.equal(after.schedule.session_id, initial.schedule.session_id)
    assert.equal(after.document.revision, initial.document.revision)
    assert.equal(after.document.launchedCount, 0)
    assert.equal(after.document.pending, null)
    assert.equal(events().slice(nativeCount).filter(event => event.kind === "cas" || event.kind === "registered").length, 0)
    const failures = after.messages.filter(message => message.type === "idle" && message.outcome === "failed")
    assert(failures.length > 0, "missing artifact must fail the native technical turn")
    assert.equal(providerRequests.length, 0, "cold missing hooks must not reach a remote auxiliary provider")
    save("result", { completed: true, coldMissing, safeClosed: true, nativeNaturalWake: true, originalSessionAndSchedule: true,
      providerHTTP: providerRequests.length, runtimeRegisteredAfterCold: false, failedTurns: failures,
      documentRevisionUnchanged: true, launchedCount: 0, originalDueAt: initial.schedule.next_due_at,
      nativeNextDueAt: after.schedule.next_due_at, seededHistoryStillPresent: after.messages.some(message => message.id === "msg_qualification_seed_user") })
    console.log(JSON.stringify({ completed: true, coldMissing, providerHTTP: providerRequests.length, evidence: root }))
  } else if (controlledMaintenance) {
    const snapshot = () => observe("snapshot", { sessionID: reconciliation.id, scheduleID: reconciliationSchedule.id })
    const first = save("controlled-before", await snapshot()), firstDue = first.schedule.next_due_at
    assert.equal(JSON.parse(first.schedule.when).every, "90 minutes")
    save("controlled-tick-one", await observe("tick", { at: firstDue }))
    await wait(() => events().some(event => event.kind === "compaction-held"))
    const held = save("controlled-during-auto-compaction", await snapshot())
    assert(held.messages.some(message => message.type === "compaction" && message.reason === "auto" && message.status === "running"))
    assert.equal(held.schedule.next_due_at, firstDue + 90 * 60_000)
    assert.equal(held.schedule.run_count, 1)
    assert.equal(held.schedule.remaining_runs, 2)
    writeFileSync(path.join(root, "release-compaction"), "release only the fixture hook; preserve native identities")
    await wait(() => events().some(event => event.kind === "cas" && event.run === 1))
    const compacted = save("controlled-after-auto-compaction", await snapshot())
    assert(compacted.messages.some(message => message.type === "compaction" && message.reason === "auto" && message.status === "completed"))
    for (const key of ["id", "session_id", "when", "next_due_at", "ends_at", "remaining_runs", "run_count", "time_created", "time_updated"])
      assert.deepEqual(compacted.schedule[key], held.schedule[key], key)
    await stop(current)
    const cold = await launch("controlled-cold")
    const restarted = save("controlled-after-cold", await snapshot())
    for (const key of ["id", "session_id", "when", "next_due_at", "ends_at", "remaining_runs", "run_count", "time_created", "time_updated"])
      assert.deepEqual(restarted.schedule[key], compacted.schedule[key], key)
    save("controlled-tick-two", await observe("tick", { at: restarted.schedule.next_due_at }))
    await wait(() => events().some(event => event.pid === cold.pid && event.kind === "cas" && event.run === 2))
    const final = save("controlled-final", await snapshot())
    assert.equal(final.session.id, first.session.id)
    assert.equal(final.schedule.id, first.schedule.id)
    assert.equal(final.schedule.run_count, 2)
    assert.equal(final.schedule.remaining_runs, 1)
    assert.equal(final.schedule.status, "done") // next 270-minute slot is beyond ends.at at 181 minutes.
    assert.equal(final.schedule.ends_at, first.schedule.ends_at)
    assert.equal(final.document.calendars.find(item => item.role === "reconciliation").highWater, 2)
    assert.equal(final.document.launchedCount, 0)
    assert.equal(providerRequests.length, 0)
    save("result", { completed: true, controlledMaintenance: true, clock: "native Effect Clock on explicit tick only; OS clock unchanged",
      sameCarrierEvery90Minutes: true, automaticCompaction: true, historyReallyOverCeiling: true, originalSessionAndSchedule: true,
      phaseAndEndsPreservedDuringMaintenanceAndColdRestart: true, secondNativeSlotFinishedAtOriginalEnd: true,
      highWater: 2, launchedCount: 0, providerHTTP: providerRequests.length })
    console.log(JSON.stringify({ completed: true, controlledMaintenance: true, evidence: root }))
  } else if (statusOnly) {
    const { id, pid, url, version } = JSON.parse(readFileSync(registrationFile))
    const wake = { missionID: "native_foundation", generation: 1, scheduleID: reconciliationSchedule.id,
      sessionID: reconciliation.id, run: 1, messageID: `msg_${reconciliationSchedule.id}_1` }
    const definition = { id: "codenomad.missions.schedule", methods: { status: { input: { type: "object" }, output: { type: "object" } } }, events: {} }
    const status = () => client.rpc(definition).status({ wake, incarnation: { id, pid, url, version }, registrationFile }, { location: { directory: project } })
    const before = await qa("snapshot")
    assert.equal((await status()).state, "unknown")
    assert.equal((await qa("claimOnly", wake)).claimed, true)
    assert.equal((await status()).state, "pending")
    assert.equal((await qa("claimOnly", wake)).claimed, false)
    assert.equal((await qa("snapshot")).revision, before.revision)
    assert.equal(events().filter(event => event.kind === "rpc-wake" || event.kind === "cas").length, 0)
    save("result", { completed: true, statusOnly: true, unknownBeforeClaim: true, pendingAfterClaim: true,
      duplicateClaimRefused: true, documentRevisionUnchanged: true, wakeMutations: 0, providerHTTP: providerRequests.length })
    console.log(JSON.stringify({ completed: true, statusOnly: true, evidence: root }))
  } else {
  await wait(() => events().some(event => event.kind === "transport" && event.result.state === "uncertain"), 85_000)
  const first = save("document-after-lost-ack", await qa("snapshot"))
  assert.equal(first.calendars.find(item => item.role === "reconciliation").highWater, 1)
  assert.equal(first.launchedCount, 0)
  save("ordinary-guard", await qa("ordinary", { ownedCarrier: true, metadata: { schedule: { id: reconciliationSchedule.id, run: 2 } } }))
  assert.deepEqual(await qa("ordinary", { ownedCarrier: true }), { allowed: false })
  let forgedRefused = false
  try { await client.session.prompt({ sessionID: reconciliation.id, id: "msg_forged", text: signal,
    metadata: { schedule: { id: reconciliationSchedule.id, run: 2, dueAt: Date.now(), late: false } } }) } catch { forgedRefused = true }
  assert(forgedRefused)
  save("forged-input", { refused: forgedRefused, boundary: "native prompt hook + separately invoked reusable ordinary guard" })
  await qa("forceTitle", { sessionID: reconciliation.id })
  const phaseBefore = save("phase-before-compaction", await client.experimental.schedule.get({ scheduleID: principalSchedule.id }))
  const auxiliaryBefore = save("aux-before-compaction", await client.experimental.schedule.get({ scheduleID: reconciliationSchedule.id }))
  await client.session.compact({ sessionID: reconciliation.id })
  await wait(async () => {
    const result = await client.message.list({ sessionID: reconciliation.id, limit: 32 })
    return result.data.some(message => message.type === "compaction" && message.status === "completed")
  })
  const phaseCompacted = save("phase-after-compaction", await client.experimental.schedule.get({ scheduleID: principalSchedule.id }))
  const auxiliaryCompacted = save("aux-after-compaction", await client.experimental.schedule.get({ scheduleID: reconciliationSchedule.id }))
  for (const key of ["id", "sessionID", "nextDueAt", "endsAt", "remainingRuns", "runCount"])
    assert.deepEqual(phaseCompacted[key], phaseBefore[key], key)
  for (const key of ["id", "sessionID", "nextDueAt", "remainingRuns", "runCount"])
    assert.deepEqual(auxiliaryCompacted[key], auxiliaryBefore[key], key)
  const firstPID = current.pid
  await wait(() => events().some(event => event.pid === firstPID && event.kind === "cas" && event.run === 2), 75_000)
  await wait(() => events().filter(event => event.pid === firstPID && event.kind === "local-stream").length >= 2)
  const streams = events().filter(event => event.pid === firstPID && event.kind === "local-stream")
  assert.equal(new Set(streams.map(event => event.token)).size, 1)
  save("cached-language-two-occurrences", { pid: firstPID, streams: streams.length, languageObjects: 1 })
  const beforeCold = save("document-before-cold-restart", await qa("snapshot"))
  assert.equal(beforeCold.calendars.find(item => item.role === "reconciliation").highWater, 2)
  const oldPID = current.pid
  await stop(current)
  const cold = await launch("cold-incarnation")
  assert.notEqual(cold.pid, oldPID)
  // Only own local receipt files are observed here: zero project API requests,
  // CodeNomad backend or external wake calls until the native schedule fires.
  log({ kind: "no-project-client-window-start", pid: cold.pid })
  await wait(() => events().some(event => event.pid === cold.pid && event.kind === "cas" && event.run === 3), 85_000)
  log({ kind: "no-project-client-window-end", pid: cold.pid })
  const second = save("document-after-cold-wake", await qa("snapshot"))
  assert.equal(second.calendars.find(item => item.role === "reconciliation").highWater, 3)
  assert.equal(second.launchedCount, 0)
  assert.equal(second.pending, null)
  const phaseCold = save("phase-after-cold-wake", await client.experimental.schedule.get({ scheduleID: principalSchedule.id }))
  for (const key of ["id", "sessionID", "nextDueAt", "endsAt", "remainingRuns", "runCount"]) assert.deepEqual(phaseCold[key], phaseBefore[key], key)
  const wake = { missionID: second.id, generation: second.timeGeneration, scheduleID: reconciliationSchedule.id, run: 1,
    sessionID: reconciliation.id, messageID: `msg_${reconciliationSchedule.id}_1` }
  const replay = save("old-wake-replay", await qa("replay", { wake, incarnation: cold, registrationFile }))
  assert.equal(replay.state, "applied")
  assert.equal((await qa("snapshot")).revision, second.revision)
  // Disable auto-start while leaving this explicitly launched isolated daemon alive.
  writeFileSync(path.join(configRoot, "service.json"), JSON.stringify({ hostname: "127.0.0.1", port, disabled: true }))
  assert(await Service.discover({ file: registrationFile }))
  save("disabled-live", { discovered: true, supervision: "absent", pid: cold.pid })
  // Artifact checks also fence an already cached local model.
  renameSync(artifacts.provider.file, `${artifacts.provider.file}.held`)
  let missingProviderRefused = false
  try { await client.session.prompt({ sessionID: reconciliation.id, id: `msg_${reconciliationSchedule.id}_4`, text: signal,
    metadata: { schedule: { id: reconciliationSchedule.id, run: 4, dueAt: Date.now(), late: false } } }) } catch { missingProviderRefused = true }
  assert(missingProviderRefused)
  renameSync(`${artifacts.provider.file}.held`, artifacts.provider.file)
  assert.equal((await qa("snapshot")).revision, second.revision)
  save("provider-absence", { refused: true, documentUnchanged: true, cachedModel: true })
  renameSync(artifacts.qualification.file, `${artifacts.qualification.file}.held`)
  let missingBundleRefused = false
  try { await client.session.prompt({ sessionID: reconciliation.id, id: `msg_${reconciliationSchedule.id}_4`, text: signal,
    metadata: { schedule: { id: reconciliationSchedule.id, run: 4, dueAt: Date.now(), late: false } } }) } catch { missingBundleRefused = true }
  renameSync(`${artifacts.qualification.file}.held`, artifacts.qualification.file)
  assert(missingBundleRefused)
  assert.equal((await qa("snapshot")).revision, second.revision)
  save("bundle-absence", { refused: true, documentUnchanged: true, loadedRegistration: true })
  const observed = events()
  assert.equal(observed.filter(event => event.kind === "cas").length, 3)
  assert.equal(observed.filter(event => event.kind === "rpc-wake" && event.input.wake.run === 1).length, 2) // original + explicit QA replay
  assert(observed.some(event => event.kind === "title-result" && event.model.providerID === "remote-aux" && event.local))
  assert(observed.some(event => event.kind === "compaction-result" && event.model.providerID === "remote-aux" && event.local))
  assert(observed.filter(event => event.kind === "language-cache").every(event => event.same))
  assert.equal(observed.filter(event => ["provider-http-hook", "forbidden-lifecycle", "forbidden-child", "forbidden-signal"].includes(event.kind)).length, 0)
  assert.equal(providerRequests.length, 0)
  save("result", { completed: true, nativeVersion: "2.2.3", casCount: 3, highWater: 3, launchedCount: 0,
    coldWakeWithoutProjectClient: true, lostACKNoAutomaticResend: true, forcedCompaction: true,
    remoteTitleAndCompactionLocal: true, providerHTTP: providerRequests.length, forbiddenWakeOperations: 0,
    productInstalledRegistration: false, coreBusinessAdmissionQualified: false })
  console.log(JSON.stringify({ completed: true, evidence: root, providerHTTP: providerRequests.length }))
  }
} catch (error) {
  if (client) {
    try { save("plugin-diagnostics", await client.plugin.list({ location: { directory: project } })) } catch {}
  }
  save("result", { completed: false, message: error.message, stack: error.stack })
  console.error(error)
  process.exitCode = 1
} finally {
  if (artifacts?.provider && existsSync(`${artifacts.provider.file}.held`)) renameSync(`${artifacts.provider.file}.held`, artifacts.provider.file)
  if (artifacts?.qualification && existsSync(`${artifacts.qualification.file}.held`)) renameSync(`${artifacts.qualification.file}.held`, artifacts.qualification.file)
  for (const child of owned) await stop(child)
  spy.closeAllConnections(); await new Promise(resolve => spy.close(resolve))
  save("cleanup", { ownPIDs: owned.map(child => child.pid), running: owned.filter(child => child.exitCode === null && child.signalCode === null).map(child => child.pid),
    providerRequests, sharedServiceAccess: "none", externalClient: statusOnly ? "harness only; read-only status qualification"
      : controlledMaintenance ? "harness clock tick RPC; controlled-time maintenance explicitly qualified"
        : "harness only; bounded no-project-client cold window recorded" })
}
