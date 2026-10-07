// Real native API + high-level admission proof, with explicitly injected writer
// trust/gate. NOT protected-writer qualification, cold boot or desktop closure.
// node packages/server/src/opencode/missions/native-service-adapter.test.mjs
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { build } from "esbuild"
import { OpenCode } from "@opencode/client"
import { ASSIGNED_CLI, privateRoot } from "../../../../../scripts/missions-child-environment/runtime.mjs"

const original = { ...process.env }
const sourcePaths = ["opencode/missions/native-service-adapter.ts", "opencode/missions/autonomous-admission.ts",
  "opencode/missions/autonomous-contract.ts", "opencode/missions/autonomous-environment.ts", "missions/authority-synchronous.ts",
  "missions/authority-core.ts", "missions/authority-protocol.ts", "missions/authority-store.ts", "missions/journal.ts"]
const sourceHashes = () => Promise.all(sourcePaths.map(async file => [file,
  createHash("sha256").update(await readFile(path.resolve("packages/server/src", file))).digest("hex")])).then(Object.fromEntries)
const sourceInputs = await sourceHashes()
let child, closed, watchdog, provider, startupError, logs = "", providerRequests = 0
try {
  const isolated = await privateRoot(ASSIGNED_CLI)
  const plugin = path.join(isolated.root, "plugin")
  await mkdir(plugin)
  const entry = path.join(plugin, "entry.mjs")
  await writeFile(entry, `import { Cause, Context, Effect, Schema } from "effect";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { realpath } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { Plugin, Rpc } from "@opencode/plugin/effect";
import { SessionInbox } from "@opencode/schema/session-inbox";
import { acquireMissionNativeService } from ${JSON.stringify(path.resolve("packages/server/src/opencode/missions/native-service-adapter.ts"))};
import { admitAutonomousMissionInput } from ${JSON.stringify(path.resolve("packages/server/src/opencode/missions/autonomous-admission.ts"))};
import { MissionJournal } from ${JSON.stringify(path.resolve("packages/server/src/missions/journal.ts"))};
import { NativeMissionAuthorityStore } from ${JSON.stringify(path.resolve("packages/server/src/missions/authority-store.ts"))};
import { NativeMissionAuthority } from ${JSON.stringify(path.resolve("packages/server/src/missions/authority-core.ts"))};
import { authoritySigningBytes, authoritySignerDigest, canonicalAuthority, MISSION_AUTHORITY_POLICY } from ${JSON.stringify(path.resolve("packages/server/src/missions/authority-protocol.ts"))};
import { assignmentInput, reportInput } from ${JSON.stringify(path.resolve("packages/server/src/missions/inputs.ts"))};
import { controlOperationID, controlReceiptID, controlResumeAdmissionID } from ${JSON.stringify(path.resolve("packages/server/src/missions/receipt-identity.ts"))};
const execute = promisify(execFile);
const method = { input: { type: "object" }, output: { type: "object" } };
const definition = Rpc.define({ id: "private.missions.native-adapter", methods: { check: method, high: method, uncertain: method }, events: {} });
const profilePath = ${JSON.stringify(path.join(isolated.root, "profile.yaml"))};
const ownedDirectory = ${JSON.stringify(isolated.project)};
export default Plugin.define({ id: "private.missions.native-adapter", effect(ctx) {
 return Effect.gen(function* () {
 const graph = yield* Effect.context();
 const run = effect => Effect.runPromise(Effect.provide(effect, graph));
 const storage = { get: key => run(ctx.storage.get(key)), set: (key, value) => run(ctx.storage.set(key, value)), scan: input => run(ctx.storage.scan(input)) };
 let state, sequence = 0, tail = Promise.resolve();
 // A real serialized fixture gate, but NOT proof of native protected ownership.
 const withGate = operation => { const next = tail.then(operation); tail = next.catch(() => {}); return next; };
 const rootIdentity = async location => {
  assert.equal(location.directory, ownedDirectory);
  const checkout = await realpath(location.directory);
  const common = (await execute("git", ["-C", location.directory, "rev-parse", "--path-format=absolute", "--git-common-dir"], { timeout: 10000, maxBuffer: 65536, windowsHide: true })).stdout.trim();
  assert(path.isAbsolute(common));
  const family = await realpath(common);
  return { mode: "git", directory: location.directory, family: process.platform === "win32" ? path.normalize(family).toLowerCase() : path.normalize(family),
   checkout: process.platform === "win32" ? path.normalize(checkout).toLowerCase() : path.normalize(checkout) };
 };
 const event = fields => ({ version: 1, id: "evt_fixture_" + ++sequence, createdAt: sequence, projectID: state.scope.projectID, missionID: state.scope.missionID, ...fields });
 const mission = async () => (await state.journal.snapshot()).missions.find(item => item.id === state.scope.missionID);
 const authorityFor = native => new NativeMissionAuthority(state.store, {
  assertActive: native.assertCurrent, readSigners: async () => [state.signer],
  assertSignerCurrent: signer => { native.assertCurrent(); assert.equal(signer.signerDigest, authoritySignerDigest(state.key.publicKey));
   assert.equal(signer.provisioningGeneration, state.signer.provisioningGeneration); return true; },
  observeMission: async id => {
   try {
   const saved = await mission(); if (!saved || saved.id !== id) return undefined;
   for (const actor of saved.actors) {
    const live = await native.get({ sessionID: actor.sessionId });
    assert.equal(live.projectID, state.scope.projectID); assert.deepEqual(live.location, actor.location);
    assert.deepEqual(await rootIdentity(live.location), state.scope.roots[0]);
   }
   return { missionID: saved.id, coordinatorSessionID: saved.coordinatorSessionId, revision: saved.revision, status: saved.status,
    runState: saved.runState ?? "running", controlPending: Boolean(saved.control?.pending.length), control: saved.control, roots: state.scope.roots };
   } catch (error) { state.observationFailure = String(error.stack ?? error); throw error; }
  }, assertJournalCapacity: async () => state.journal.assertCanAppend(3),
 });
 const highInput = (native, authority, command, extra = {}) => ({ context: { location: ctx.location, session: { get: native.get } },
  journal: state.journal, authority, scope: state.scope, profile: { profileID: state.scope.profileID, executionHost: state.scope.executionHost, configYamlPath: profilePath },
  command, signal: AbortSignal.timeout(12000), executionHost: { environment: { FIXTURE_NATIVE_BASE: "safe-base" } }, native,
  assertCurrent: () => { native.assertCurrent(); assert.equal(state.signer.qualification, "qualified"); return true; }, withGate, resolveRoot: rootIdentity, ...extra });
 const guard = effect => effect.pipe(Effect.scoped, Effect.catchCause(cause => Effect.succeed({ fixtureError: Cause.pretty(cause), fixtureObservation: state?.observationFailure ?? "none" })));
 yield* ctx.rpc.register(definition, { check: input => guard(Effect.gen(function* () {
  const native = yield* acquireMissionNativeService();
  const session = yield* Effect.promise(() => native.get({ sessionID: input.sessionID }));
  if (session.projectID !== ctx.location.project.id || session.location.directory !== ctx.location.directory) throw new Error("Not fixture-owned");
  let checks = 0;
  const current = () => { checks++; native.assertCurrent(); return true; };
  yield* Effect.promise(() => native.environment({ sessionID: session.id, variables: { FIXTURE_MARKER: input.marker } }, {}, current));
  // Deliberately do not wake a model: verifies native durable admission, not execution completion.
  const commands = ["prompt", "synthetic"].map((kind, index) => ({ kind, input: { sessionID: session.id, id: input.ids[index], text: "Private native admission", delivery: "queue", resume: false,
   metadata: { "codenomad.mission": { version: 1, missionID: "msn_fixture", kind: kind === "prompt" ? "assignment" : "report" } } } }));
  const receipts = [];
  for (const command of commands) receipts.push(yield* Effect.promise(() => native.admit(command, {}, current)));
  const pending = yield* Effect.promise(() => native.inbox(session.id));
  const service = yield* Effect.serviceOption(Context.Service("@opencode/Session"));
  const environment = yield* service.value.environment({ sessionID: session.id });
  const guardNegatives = [];
  yield* Effect.promise(async () => {
   let assimilated = 0;
   for (const [name, guard] of [["false", () => false], ["void", () => undefined], ["async-true", () => Promise.resolve(true)],
    ["async-retired", () => Promise.reject(new Error("Fixture owner retired"))], ["thenable", () => ({ then() { assimilated++; } })]]) {
    await assert.rejects(native.environment({ sessionID: session.id, variables: { FIXTURE_MARKER: "MUST_NOT_WRITE" } }, {}, guard), /policy-unqualified/);
    for (const kind of ["prompt", "synthetic"]) {
     const command = { ...commands[kind === "prompt" ? 0 : 1], kind, input: { ...commands[0].input, id: "msg_denied_" + name + "_" + kind } };
     await assert.rejects(native.admit(command, {}, guard), /policy-unqualified/);
    }
    assert.deepEqual(await run(service.value.environment({ sessionID: session.id })), environment);
    assert.deepEqual((await native.inbox(session.id)).map(item => item.id), input.ids);
    guardNegatives.push({ name, noEnvironmentWrite: true, noAdmission: true });
   }
   assert.equal(assimilated, 0);
   await assert.rejects(Reflect.apply(native.environment, undefined, [{ sessionID: session.id, variables: { FIXTURE_MARKER: "MUST_NOT_WRITE" } }, {}]), /policy-unqualified/);
   for (const kind of ["prompt", "synthetic"]) {
    const command = { ...commands[kind === "prompt" ? 0 : 1], kind, input: { ...commands[0].input, id: "msg_denied_omitted_" + kind } };
    await assert.rejects(Reflect.apply(native.admit, undefined, [command, {}]), /policy-unqualified/);
   }
   assert.deepEqual(await run(service.value.environment({ sessionID: session.id })), environment);
   assert.deepEqual((await native.inbox(session.id)).map(item => item.id), input.ids);
   guardNegatives.push({ name: "omitted", noEnvironmentWrite: true, noAdmission: true });
  });
  return { ids: receipts.map(item => item.id), types: pending.map(item => item.type), marker: environment.FIXTURE_MARKER, checks, guardNegatives };
 })), high: input => guard(Effect.gen(function* () {
  assert.equal(state, undefined, "Fixture preparation is single-use");
  assert.equal(ctx.location.directory, ownedDirectory);
  const native = yield* acquireMissionNativeService();
  const raw = yield* Effect.serviceOption(Context.Service("@opencode/Session"));
  const coordinator = yield* Effect.promise(() => native.get({ sessionID: input.coordinatorID }));
  const worker = yield* Effect.promise(() => native.get({ sessionID: input.workerID }));
  for (const actor of [coordinator, worker]) { assert.equal(actor.projectID, ctx.location.project.id); assert.equal(actor.location.directory, ownedDirectory); }
  const journal = new MissionJournal(storage, ctx.location.project.id, ctx.location.project.canonical);
  const store = new NativeMissionAuthorityStore(storage, ctx.location.project.id, ctx.location.project.canonical);
  const namespace = yield* Effect.promise(() => store.initialize());
  const key = generateKeyPairSync("ed25519");
  const root = yield* Effect.promise(() => rootIdentity(coordinator.location));
  const scope = { authorityID: "fixture-authority", keyID: "fixture-key", profileID: "fixture-profile", executionHost: "fixture-native-host",
   namespace, projectID: coordinator.projectID, projectCanonical: ctx.location.project.canonical, roots: [root], missionID: "msn_highlevel", coordinatorSessionID: coordinator.id };
  state = { journal, store, key, scope, workerID: worker.id,
   signer: { ...scope, publicKey: key.publicKey, provisioningGeneration: "fixture-generation", policy: MISSION_AUTHORITY_POLICY, qualification: "qualified" } };
  yield* Effect.promise(() => journal.append(event({ type: "mission.created", projectCanonical: scope.projectCanonical,
   objective: "Private high-level native admission", template: "custom", coordinator: { sessionID: coordinator.id, title: "Coordinator", location: coordinator.location } })));
  const dispatch = async (taskKey, admissionID) => {
   await journal.append(event({ type: "task.created", task: { id: "tsk_" + taskKey, key: taskKey, title: taskKey, brief: "Bounded fixture work", role: "worker", blockedBy: [] } }));
   await journal.append(event({ type: "task.dispatching", taskKey, admissionID, delivery: "queue",
    actor: { sessionID: worker.id, title: "Worker", managed: true, location: worker.location } }));
  };
  state.dispatch = dispatch;
  yield* Effect.promise(() => dispatch("work", "msg_highlevel_assignment"));
  const authority = authorityFor(native);
  let envCalls = 0, sendCalls = 0;
  const observed = { ...native, environment: (...args) => { envCalls++; return native.environment(...args); }, admit: (...args) => { sendCalls++; return native.admit(...args); } };
  const command = async () => { const saved = await mission(); return { kind: "prompt", input: assignmentInput(saved, saved.tasks.find(task => task.key === "work")) }; };
  const negatives = [];
  const deny = async (name, extra = {}, changedCommand) => {
   const before = { envCalls, sendCalls };
   const beforeEnv = await run(raw.value.environment({ sessionID: worker.id }));
   let failure;
   try { await admitAutonomousMissionInput(highInput(observed, authority, changedCommand ?? await command(), extra)); } catch (error) { failure = error; }
   assert(failure, name + " must refuse"); assert.deepEqual({ envCalls, sendCalls }, before);
   assert.deepEqual(await run(raw.value.environment({ sessionID: worker.id })), beforeEnv);
   negatives.push({ name, denied: true, beforeEnvironment: true, beforePrompt: true });
  };
  yield* Effect.promise(() => deny("no-grant"));
  const executeSigned = async (method, payload, requestID) => {
   const saved = await mission();
   const body = { ...scope, version: 1, policy: MISSION_AUTHORITY_POLICY, epoch: 1, expectedRevision: saved.revision, method, payload, requestID };
   return authority.execute({ body, signature: sign(null, authoritySigningBytes(body), key.privateKey).toString("base64") }, {
    apply: async intent => {
     assert.equal(intent.method, "lifecycle"); assert.equal(intent.payload.action, "start");
     const operationID = controlOperationID(scope.missionID, intent.requestID);
     const targets = (await mission()).actors.map(actor => ({ sessionID: actor.sessionId, location: actor.location }));
     await journal.append(event({ id: operationID, type: "mission.control-requested", requestID: intent.requestID, expectedRevision: intent.expectedRevision, action: "start", targets }));
     for (const target of targets) {
      const ack = await run(raw.value.synthetic({ sessionID: target.sessionID, id: controlResumeAdmissionID(operationID, target.sessionID),
       text: "Private signed fixture Play", delivery: "queue", resume: false, metadata: { "codenomad.mission": { version: 1, kind: "lifecycle", missionID: scope.missionID, operationID } } }));
      const admission = Schema.encodeSync(Schema.toCodecJson(SessionInbox.Info))(ack);
      await journal.append(event({ id: controlReceiptID(operationID, target.sessionID), type: "mission.control-applied", operationID, sessionID: target.sessionID,
       nativeAcknowledgement: { missionID: scope.missionID, operationID, sessionID: target.sessionID, action: "start", disposition: "start-admitted", admission } }));
     }
     return { missionID: scope.missionID, operationID, revision: (await mission()).revision };
    },
   }, AbortSignal.timeout(12000));
  };
  yield* Effect.promise(() => executeSigned("adopt", {}, "fixture-adopt"));
  yield* Effect.promise(() => executeSigned("lifecycle", { action: "start" }, "fixture-start"));
  yield* Effect.promise(async () => {
   const wrong = await command(); wrong.input.sessionID = input.foreignID;
   await deny("wrong-session", {}, wrong);
   await deny("changed-root", { resolveRoot: async location => ({ ...await rootIdentity(location), family: root.family + "-injected-change" }) });
   await deny("wrong-profile", { profile: { profileID: "foreign-profile", executionHost: scope.executionHost, configYamlPath: profilePath } });
   await deny("async-owner-retired", { assertCurrent: () => Promise.reject(new Error("Fixture owner retired")) });
   await deny("nonliteral-owner", { assertCurrent: () => false });
  });
  const prompt = yield* Effect.promise(async () => admitAutonomousMissionInput(highInput(observed, authority, await command())));
  const safeEnvironment = yield* raw.value.environment({ sessionID: worker.id });
  assert.deepEqual(safeEnvironment, { FIXTURE_NATIVE_BASE: "safe-base", FIXTURE_MARKER: "highlevel-fresh" });
  yield* Effect.promise(() => journal.append(event({ type: "task.dispatched", taskKey: "work", admissionID: prompt.admissionID })));
  const report = { id: "rpt_highlevel", taskKey: "work", sessionId: worker.id, outcome: "completed", summary: "Fixture report", evidence: [], next: [], createdAt: sequence + 1 };
  yield* Effect.promise(() => journal.append(event({ type: "task.reported", report })));
  const synthetic = yield* Effect.promise(async () => admitAutonomousMissionInput(highInput(observed, authority, { kind: "synthetic", input: reportInput(await mission(), report) })));
  const saved = yield* Effect.promise(mission);
  assert.equal(saved.control.pending.length, 0);
  return { prompt, synthetic, negatives, envCalls, sendCalls, marker: safeEnvironment.FIXTURE_MARKER,
   journalRevision: saved.revision, signedReceipts: (yield* Effect.promise(() => store.read())).receipts.map(receipt => ({ method: receipt.intent.method, completed: Boolean(receipt.completion) })),
   actualNativeAPI: true, resume: true, injectedWriterTrust: true, genuineProtectedWriterProof: false, rootChangeWasInjected: true };
 })), uncertain: input => guard(Effect.gen(function* () {
  assert(state, "High-level preparation required");
  const native = yield* acquireMissionNativeService();
  assert.equal(input.workerID, state.workerID);
  yield* Effect.promise(() => state.dispatch("uncertain", "msg_highlevel_uncertain"));
  const authority = authorityFor(native);
  let attempts = 0;
  const ackLost = { ...native, admit: async (...args) => { attempts++; await native.admit(...args); throw new Error("Fixture drops ACK after native admission"); } };
  const saved = yield* Effect.promise(mission);
  const command = { kind: "prompt", input: assignmentInput(saved, saved.tasks.find(task => task.key === "uncertain")) };
  let failed = false;
  yield* Effect.promise(async () => { try { await admitAutonomousMissionInput(highInput(ackLost, authority, command)); } catch { failed = true; } });
  assert(failed); assert.equal(attempts, 1);
  const retained = (yield* Effect.promise(mission)).tasks.find(task => task.key === "uncertain");
  assert.equal(retained.status, "dispatching"); assert.equal(retained.admissionId, command.input.id);
  const pending = yield* Effect.promise(() => native.inbox(state.workerID));
  assert.equal(pending.filter(item => item.id === command.input.id).length, 1);
  return { admissionID: command.input.id, attempts, unknownAcknowledgement: true, retainedStatus: retained.status, pendingCopies: 1, replayed: false };
 })) });
 });
} });`)
  await build({ entryPoints: [entry], outfile: path.join(plugin, "index.mjs"), bundle: true, platform: "node", format: "esm",
    nodePaths: [path.resolve("node_modules")], logLevel: "silent" })
  await writeFile(path.join(plugin, "package.json"), JSON.stringify({ type: "module", main: "index.mjs" }))
  await writeFile(path.join(isolated.root, "profile.yaml"), "server:\n  environmentVariables:\n    FIXTURE_MARKER: highlevel-fresh\n")
  // All model traffic stays local and held, so a later queue item remains pending
  // while simulating lost admission ACK. No tool calls or permission autoapproval.
  provider = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Consume the fixture request body. */ }
    providerRequests++
    response.setHeader("content-type", "text/event-stream")
    response.write(": private fixture holds model response\n\n")
  })
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve))
  process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ update: "disable", snapshots: false, plugins: [plugin], model: "fixture/fixture",
    providers: { fixture: { package: "@opencode/ai/providers/openai-compatible", settings: { apiKey: "private-fixture",
      baseURL: `http://127.0.0.1:${provider.address().port}/v1` }, models: { fixture: {} } } } })
  const keys = new Set(["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "HOME", "USERPROFILE",
    "APPDATA", "LOCALAPPDATA", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL"])
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => keys.has(key.toUpperCase()) || /^(OPENCODE_|XDG_)/i.test(key)))
  child = spawn(ASSIGNED_CLI, ["serve", "--hostname", "127.0.0.1", "--port", "0", "--print-logs"],
    { cwd: isolated.root, env: environment, windowsHide: true })
  closed = new Promise(resolve => child.once("close", resolve))
  child.once("error", error => { startupError = error })
  for (const stream of [child.stdout, child.stderr]) stream.on("data", data => { logs = (logs + data).slice(-1024 * 1024) })
  const deadline = Date.now() + 60_000
  watchdog = setTimeout(() => child.kill(), 60_000)
  watchdog.unref()
  while (!/http:\/\/127\.0\.0\.1:\d+/.test(logs)) {
    if (startupError) throw startupError
    assert(child.exitCode === null && Date.now() < deadline, "Private native startup failed")
    await delay(50)
  }
  const client = OpenCode.make({ baseUrl: logs.match(/http:\/\/127\.0\.0\.1:\d+/)[0],
    headers: { authorization: `Basic ${Buffer.from(`opencode:${environment.OPENCODE_SERVER_PASSWORD}`).toString("base64")}` } })
  const options = () => ({ signal: AbortSignal.timeout(Math.max(1, Math.min(45_000, deadline - Date.now()))) })
  const info = await client.server.info(options())
  const session = await client.session.create({ location: { directory: isolated.project }, title: "Private native admission" }, options())
  await client.plugin.list({ location: { directory: isolated.project } }, options())
  const ids = ["msg_private_prompt", "msg_private_synthetic"]
  const result = await client.rpc.call({ rpcID: "private.missions.native-adapter", method: "check", location: { directory: isolated.project },
    input: { sessionID: session.id, ids, marker: "native-graph-applied" } }, options())
  assert(!result.output.fixtureError, JSON.stringify(result.output))
  assert.deepEqual(result.output.ids, ids)
  assert.deepEqual(result.output.types, ["user", "synthetic"])
  assert.equal(result.output.marker, "native-graph-applied")
  assert.equal(result.output.checks, 3)
  assert.deepEqual(result.output.guardNegatives.map(item => item.name), ["false", "void", "async-true", "async-retired", "thenable", "omitted"])
  assert(result.output.guardNegatives.every(item => item.noEnvironmentWrite && item.noAdmission))
  const inbox = await client.session.inbox.list({ sessionID: session.id }, options())
  assert.deepEqual(inbox.map(item => item.id), ids)
  const coordinator = await client.session.create({ location: { directory: isolated.project }, title: "High-level coordinator" }, options())
  const worker = await client.session.create({ location: { directory: isolated.project }, title: "High-level worker" }, options())
  const foreignDirectory = path.join(isolated.root, "foreign")
  await mkdir(foreignDirectory)
  const foreign = await client.session.create({ location: { directory: foreignDirectory }, title: "Wrong owned identity" }, options())
  const high = await client.rpc.call({ rpcID: "private.missions.native-adapter", method: "high", location: { directory: isolated.project },
    input: { coordinatorID: coordinator.id, workerID: worker.id, foreignID: foreign.id } }, options())
  assert(!high.output.fixtureError, JSON.stringify(high.output))
  assert.equal(high.output.prompt.admissionID, "msg_highlevel_assignment")
  assert.equal(high.output.synthetic.admitted, true)
  assert.deepEqual(high.output.negatives.map(item => item.name), ["no-grant", "wrong-session", "changed-root", "wrong-profile", "async-owner-retired", "nonliteral-owner"])
  assert(high.output.negatives.every(item => item.denied && item.beforeEnvironment && item.beforePrompt))
  assert.deepEqual(high.output.signedReceipts, [{ method: "adopt", completed: true }, { method: "lifecycle", completed: true }])
  assert.equal(high.output.envCalls, 2)
  assert.equal(high.output.sendCalls, 2)
  assert.equal(high.output.marker, "highlevel-fresh")
  while (!providerRequests) { assert(Date.now() < deadline, "Private provider did not observe resume:true"); await delay(50) }
  const unknown = await client.rpc.call({ rpcID: "private.missions.native-adapter", method: "uncertain", location: { directory: isolated.project },
    input: { workerID: worker.id } }, options())
  assert(!unknown.output.fixtureError, unknown.output.fixtureError)
  assert.deepEqual(unknown.output, { admissionID: "msg_highlevel_uncertain", attempts: 1, unknownAcknowledgement: true,
    retainedStatus: "dispatching", pendingCopies: 1, replayed: false })
  const retainedInbox = await client.session.inbox.list({ sessionID: worker.id }, options())
  assert.equal(retainedInbox.filter(item => item.id === unknown.output.admissionID).length, 1)
  assert.deepEqual(await sourceHashes(), sourceInputs, "Reviewed source inputs changed during the fixture; rerun before claiming evidence")
  await writeFile(path.join(isolated.root, "results.json"), JSON.stringify({ passed: true, nativeVersion: info.version,
    backend: false, upstreamEdits: false, environmentApplied: true, promptAdmitted: true, syntheticAdmitted: true,
    lowLevelNativeAPI: result.output, highLevelAdmission: high.output, uncertainAdmission: unknown.output,
    genuineProtectedWriterProof: false, injectedWriterTrustAndGate: true, explicitWarmLocation: true,
    managedColdService: false, productionEntryActivated: false, providerRequests, executionCompletionClaimed: false, sourceInputs }, null, 2))
  console.log(`PASS native API + high-level admission (injected writer gate), ${info.version}: ${isolated.root}`)
} finally {
  clearTimeout(watchdog)
  if (child && child.exitCode === null) child.kill()
  if (closed) await closed
  if (provider) { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)) }
  for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key]
  Object.assign(process.env, original)
}
