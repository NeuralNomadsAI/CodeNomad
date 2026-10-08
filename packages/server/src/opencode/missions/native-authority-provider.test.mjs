// Assigned private daemon only; never activates a production entrypoint.
// node packages/server/src/opencode/missions/native-authority-provider.test.mjs
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { createServer } from "node:http"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { build } from "esbuild"
import { OpenCode } from "@opencode/client"
import { ASSIGNED_CLI, privateRoot } from "../../../../../scripts/missions-child-environment/runtime.mjs"

const original = { ...process.env }
const sourceFiles = ["opencode/missions/native-authority-provider.ts", "opencode/missions/native-authority-provider.test.mjs", "missions/recurrence-authority-store.ts",
  "missions/recurrence-authority-contract.ts", "missions/authority-protocol.ts", "missions/authority-store.ts", "missions/authority-synchronous.ts",
  "opencode/session-pruning/claim-fence.ts", "opencode/session-pruning/storage-path.ts"]
const sourceHashes = () => Promise.all(sourceFiles.map(async file => [file,
  createHash("sha256").update(await readFile(path.resolve("packages/server/src", file))).digest("hex")])).then(Object.fromEntries)
const sourceInputs = await sourceHashes()
const officialSourceInputs = {}
for (const file of ["database/database.ts", "database/drizzle/effect-sqlite/session.ts", "session/store.ts", "session/execution.ts", "kv.ts"]) {
  const url = `https://raw.githubusercontent.com/anomalyco/opencode/v2.0.24/packages/core/src/${file}`
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) })
  assert(response.ok, `Official source unavailable: ${url}`)
  officialSourceInputs[url] = createHash("sha256").update(await response.text()).digest("hex")
}
let child, closed, watchdog, logs = "", startupError, competitor, competitorClosed, provider, providerRequests = 0
try {
  const isolated = await privateRoot(ASSIGNED_CLI)
  const plugin = path.join(isolated.root, "plugin")
  await mkdir(plugin)
  const entry = path.join(plugin, "entry.mjs")
  await writeFile(entry, `import { Plugin, Rpc } from "@opencode/plugin/effect";
import { Cause, Context, Effect, Option } from "effect";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { acquireNativeRecurrenceAuthorityProvider, NATIVE_RECURRENCE_STORAGE_ID_KEY, nativeRecurrenceAnchorKey } from ${JSON.stringify(path.resolve("packages/server/src/opencode/missions/native-authority-provider.ts"))};
import { MISSION_AUTHORITY_STORAGE_PREFIX } from ${JSON.stringify(path.resolve("packages/server/src/missions/authority-store.ts"))};
import { authorityDigest, authoritySignerDigest } from ${JSON.stringify(path.resolve("packages/server/src/missions/authority-protocol.ts"))};
import { recurrenceHumanRequestID, recurrenceStandingSigningBytes, RECURRENCE_AUTHORITY_POLICY } from ${JSON.stringify(path.resolve("packages/server/src/missions/recurrence-authority-contract.ts"))};
const method={input:{type:"object"},output:{type:"object"}};
const rpc = Rpc.define({id:"private.missions.authority-provider",methods:{check:method,bump:method,claimed:method},events:{}});
const namespace="9f6f590e-271d-477f-8c02-7a6a119d63b9", storageID="private-native-storage";
export default Plugin.define({id:"codenomad.missions",effect(ctx){return Effect.gen(function*(){
 const scope={namespace,projectID:ctx.location.project.id,projectCanonical:ctx.location.project.canonical,profileID:"fixture-profile",executionHost:"fixture-host",scheduleID:"fixture_schedule",daemonStorageID:storageID};
 const guarded=effect=>effect.pipe(Effect.scoped,Effect.catchCause(cause=>Effect.succeed({fixtureError:Cause.pretty(cause)})));
 yield* ctx.rpc.register(rpc,{check:input=>guarded(Effect.gen(function*(){
  const found=yield* Effect.serviceOption(Context.Service("@opencode/storage/Database"));
  if(Option.isNone(found))return {databaseTag:false};
  const db=found.value.db;
  // Explicit private fixture provisioning, not a production signer/owner issuer.
  yield* ctx.storage.set(MISSION_AUTHORITY_STORAGE_PREFIX+"/namespace",namespace);
  yield* ctx.storage.set(NATIVE_RECURRENCE_STORAGE_ID_KEY,storageID);
  const anchor={version:1,scope,sessionID:input.sessionID,location:{directory:ctx.location.directory}};
  // Only this private fixture's explicit enrollment writes the anchor. The
  // production acquisition/mutation capability cannot enroll its own session.
  const noAnchor=yield* acquireNativeRecurrenceAuthorityProvider(ctx,input.sessionID,scope).pipe(Effect.exit);
  assert.equal(noAnchor._tag,"Failure");
  yield* ctx.storage.set(nativeRecurrenceAnchorKey(scope,input.sessionID),anchor);
  const provider=yield* acquireNativeRecurrenceAuthorityProvider(ctx,input.sessionID,scope);
  const keys=generateKeyPairSync("ed25519");
  const root={mode:"git",directory:ctx.location.directory,family:"fixture-family",checkout:ctx.location.directory};
  const execution={agent:"build",model:{providerID:"fixture",id:"fixture"}};
  const config={consigne:"Private metadata proof",clock:{time:"07:00",zone:"UTC"},profileID:scope.profileID,executionHost:scope.executionHost,
   profiles:{coordinator:execution,roles:{specialist:execution}},taskMode:"native",roots:[root],watchedConversationIDs:[],publication:{policy:"disabled",conversationIDs:[]}};
  const body={...scope,authorityID:"fixture-authority",keyID:"fixture-key",roots:[root],version:1,policy:RECURRENCE_AUTHORITY_POLICY,
    action:"authorize",scheduleRevision:0,epoch:1,expectedRevision:null,requestID:recurrenceHumanRequestID(scope.scheduleID,1,"authorize"),provisioningGeneration:"fixture-generation",
    signerDigest:authoritySignerDigest(keys.publicKey),config,configDigest:authorityDigest(config),profileSource:{profileID:scope.profileID,executionHost:scope.executionHost,configYamlPath:"/fixture/config.yaml"},budgets:{effects:2,nativeCalls:0,inboxMessages:0,publications:0}};
  const parent={body,signature:sign(null,recurrenceStandingSigningBytes(body),keys.privateKey).toString("base64")};
  const initial={version:1,scope,revision:0,parent,settledSequence:0,lastArchiveDigest:null,child:null};
  yield* Effect.promise(()=>provider.archiveParent(parent,null,()=>true));
  yield* Effect.promise(()=>provider.publish(null,initial,()=>true));
  const negatives=[];
  for(const [name,fence] of [["false",()=>false],["void",()=>undefined],["async-true",()=>Promise.resolve(true)],
   ["async-rejection",()=>Promise.reject(Error("retired"))],["thenable",()=>({then(){throw Error("assimilated")}})]]) {
   yield* Effect.promise(()=>assert.rejects(provider.publish(initial,{...initial,revision:1},fence),/policy-unqualified/));
   assert.equal((yield* Effect.promise(()=>provider.read())).revision,0);negatives.push(name);
  }
  yield* Effect.promise(()=>assert.rejects(provider.publish(initial,{...initial,revision:0},()=>true),/revision-conflict/));
  yield* Effect.promise(()=>assert.rejects(provider.publish(initial,{...initial,revision:1,scope:{...scope,daemonStorageID:"wrong"}},()=>true),/storage-invalid/));
  yield* Effect.promise(()=>assert.rejects(provider.archiveParent({...parent,signature:"A".repeat(86)+"=="},initial,()=>true),/request-conflict/));
  // The actual native transaction must also ROLLBACK if the final fence throws.
  yield* Effect.promise(()=>assert.rejects(provider.publish(initial,{...initial,revision:1},()=>{throw Error("guard fails inside native commit")}),/policy-unqualified/));
  let guardedCalls=0;
  yield* Effect.promise(()=>assert.rejects(provider.publish(initial,{...initial,revision:1},()=>{
   if(++guardedCalls===3)throw Error("retired AFTER native write, BEFORE commit");return true;
  }),/policy-unqualified/));
  assert.equal(guardedCalls,3);
  // Reproduce retirement queued after the LAST check inside each async
  // operation: only the shared final synchronous transaction hook can catch it.
  const retirementRegressions=[];
   const nextBody={...body,epoch:2,expectedRevision:0,action:"pause",requestID:recurrenceHumanRequestID(scope.scheduleID,2,"pause")};
  const nextParent={body:nextBody,signature:sign(null,recurrenceStandingSigningBytes(nextBody),keys.privateKey).toString("base64")};
  for(const api of ["publish","archiveParent"])for(const returned of ["false","rejected-promise"]){
   let retired=false,calls=0;
   const current=()=>{
    calls++;
    if(calls===3)queueMicrotask(()=>{retired=true});
    if(retired)return returned==="false"?false:Promise.reject(Error("retired in final transaction hook"));
    return true;
   };
   yield* Effect.promise(()=>assert.rejects(api==="publish"?provider.publish(initial,{...initial,revision:1},current)
    :provider.archiveParent(nextParent,initial,current),/policy-unqualified/));
   assert.equal(retired,true);assert.equal(calls,4);
   assert.equal((yield* Effect.promise(()=>provider.read())).revision,0);
   const parentKey=provider.ledgerKey.slice(0,-"/live".length)+"/parents/";
   assert.deepEqual(yield* ctx.storage.get(parentKey+"1"),parent);
   assert.equal(yield* ctx.storage.get(parentKey+"2"),undefined);
   retirementRegressions.push({api,returned,guardCalls:calls,retired:true,durableRevision:0,originalParentStable:true,nextParentAbsent:true});
  }
  assert.equal((yield* Effect.promise(()=>provider.read())).revision,0);
  const row=yield* db.$client.unsafe("SELECT value FROM kv WHERE key=?",["plugin:"+Array.from("codenomad.missions").map(c=>c.charCodeAt(0).toString(16).padStart(4,"0")).join("")+":"+provider.ledgerKey]).withoutTransform;
  assert.equal(JSON.parse(row[0].value).revision,0);
  return {databaseTag:true,transaction:typeof db.transaction==="function",sqlClient:typeof db.$client==="function",
   transactionService:Boolean(db.$client.transactionService),nativeSqliteTag:Option.isSome(yield* Effect.serviceOption(Context.Service("@opencode/core/database/SqliteNative"))),
   committedRevision:0,guardNegatives:negatives,retirementRegressions,rollback:true,afterWriteRollback:true,wrongScopeDenied:true,immutableParentDenied:true,unenrolledSessionDenied:true};
 })),bump:input=>guarded(Effect.gen(function*(){
  if(input.enroll===true)yield* ctx.storage.set(nativeRecurrenceAnchorKey(scope,input.sessionID),{version:1,scope,sessionID:input.sessionID,location:{directory:ctx.location.directory}});
  const provider=yield* acquireNativeRecurrenceAuthorityProvider(ctx,input.sessionID,scope);
  const before=yield* Effect.promise(()=>provider.read());
  const expected={...before,revision:input.revision};
  const revision=yield* Effect.promise(()=>provider.publish(expected,{...before,revision:input.revision+1},()=>true));
  return {revision};
  })),claimed:input=>guarded(Effect.gen(function*(){
   // Metadata-only CAS may observe an event-bearing/busy Session. This does
   // not qualify its native effects, which require separate call-entry proof.
   const provider=yield* acquireNativeRecurrenceAuthorityProvider(ctx,input.sessionID,scope);
   assert.equal((yield* Effect.promise(()=>provider.read())).revision,1);
   return {nativeMetadataAccepted:true};
 }))});
});}});`)
  await build({ entryPoints: [entry], outfile: path.join(plugin, "index.mjs"), bundle: true, platform: "node", format: "esm",
    nodePaths: [path.resolve("node_modules")], logLevel: "silent" })
  await writeFile(path.join(plugin, "package.json"), JSON.stringify({ type: "module", main: "index.mjs" }))
  provider = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Only a local held model, never tools. */ }
    providerRequests++
    response.setHeader("content-type", "text/event-stream")
    response.write(": private native claim fixture holds execution\n\n")
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
  const deadline = Date.now() + 75_000
  watchdog = setTimeout(() => { child.kill(); competitor?.kill() }, 75_000)
  watchdog.unref()
  while (!/http:\/\/127\.0\.0\.1:\d+/.test(logs)) {
    if (startupError) throw startupError
    assert(child.exitCode === null && Date.now() < deadline, "Private native startup failed")
    await delay(50)
  }
  const client = OpenCode.make({ baseUrl: logs.match(/http:\/\/127\.0\.0\.1:\d+/)[0],
    headers: { authorization: `Basic ${Buffer.from(`opencode:${environment.OPENCODE_SERVER_PASSWORD}`).toString("base64")}` } })
  const options = () => ({ signal: AbortSignal.timeout(Math.max(1, Math.min(20_000, deadline - Date.now()))) })
  const info = await client.server.info(options())
  assert.equal(info.version, "2.0.24", "This receipt qualifies the assigned 2.0.24 artifact only")
  const session = await client.session.create({ location: { directory: isolated.project }, title: "Private authority graph" }, options())
  await client.plugin.list({ location: { directory: isolated.project } }, options())
  const result = await client.rpc.call({ rpcID: "private.missions.authority-provider", method: "check",
    location: { directory: isolated.project }, input: { sessionID: session.id } }, options())
  assert(!result.output.fixtureError, JSON.stringify(result.output))
  const fingerprint = createHash("sha256").update(await readFile(ASSIGNED_CLI)).digest("hex")
  const nested = path.join(isolated.project, "nested")
  await mkdir(nested)
  const second = await client.session.create({ location: { directory: nested }, title: "Second native Location" }, options())
  await client.plugin.list({ location: { directory: nested } }, options())
  const bump = await client.rpc.call({ rpcID: "private.missions.authority-provider", method: "bump", location: { directory: nested },
    input: { sessionID: second.id, revision: 0, enroll: true } }, options())
  assert.deepEqual(bump.output, { revision: 1 })
  const stale = await client.rpc.call({ rpcID: "private.missions.authority-provider", method: "bump", location: { directory: isolated.project },
    input: { sessionID: session.id, revision: 0 } }, options())
  assert.match(stale.output.fixtureError, /revision-conflict/)
  // A second genuine standalone native daemon opens only this owned private DB.
  // It claims execution through Session.prompt, never fixture SQL claim writes.
  let competitorLogs = "", competitorError
  competitor = spawn(ASSIGNED_CLI, ["serve", "--hostname", "127.0.0.1", "--port", "0", "--print-logs"],
    { cwd: isolated.root, env: environment, windowsHide: true })
  competitorClosed = new Promise(resolve => competitor.once("close", resolve))
  competitor.once("error", error => { competitorError = error })
  for (const stream of [competitor.stdout, competitor.stderr]) stream.on("data", data => { competitorLogs = (competitorLogs + data).slice(-1024 * 1024) })
  while (!/http:\/\/127\.0\.0\.1:\d+/.test(competitorLogs)) {
    if (competitorError) throw competitorError
    assert(competitor.exitCode === null && Date.now() < deadline, "Private competing daemon startup failed")
    await delay(50)
  }
  const other = OpenCode.make({ baseUrl: competitorLogs.match(/http:\/\/127\.0\.0\.1:\d+/)[0],
    headers: { authorization: `Basic ${Buffer.from(`opencode:${environment.OPENCODE_SERVER_PASSWORD}`).toString("base64")}` } })
  await other.plugin.list({ location: { directory: isolated.project } }, options())
  await other.session.prompt({ sessionID: session.id, text: "Private actual native claim", delivery: "queue" }, options())
  while (!providerRequests) { assert(Date.now() < deadline, "Native execution did not reach private provider"); await delay(50) }
  const claimed = await client.rpc.call({ rpcID: "private.missions.authority-provider", method: "claimed", location: { directory: isolated.project },
    input: { sessionID: session.id } }, options())
   assert.deepEqual(claimed.output, { nativeMetadataAccepted: true })
  await other.session.interrupt({ sessionID: session.id, continue: false }, options())
  assert.deepEqual(await sourceHashes(), sourceInputs, "Source changed during native proof")
  const receipt = { nativeVersion: info.version, cliSha256: fingerprint, graph: result.output, privateRoot: isolated.root,
    sourceInputs, officialSourceInputs, twoNativeLocations: true, staleRevisionDenied: true,
     actualCompetingStandaloneMetadataReadAllowed: true, enrollmentProvisioningInjected: true, signerAuthorityClaimed: false,
    managedServiceProof: false, permanentWriterAuthority: false, wholeDatabaseRollbackProof: false, productionActivated: false }
  await writeFile(path.join(isolated.root, "results.json"), JSON.stringify(receipt, null, 2))
  console.log(JSON.stringify(receipt))
  assert.equal(result.output.databaseTag, true, "Native Database tag absent in actual request graph; stop implementation")
  assert.equal(result.output.transaction, true)
  assert.equal(result.output.sqlClient, true)
  assert.equal(result.output.transactionService, true)
} finally {
  clearTimeout(watchdog)
  if (child && child.exitCode === null) child.kill()
  if (closed) await closed
  if (competitor && competitor.exitCode === null) competitor.kill()
  if (competitorClosed) await competitorClosed
  if (provider) { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)) }
  for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key]
  Object.assign(process.env, original)
}
