// node packages/server/src/opencode/missions/native-managed-owner.test.mjs
// ONLY owned private copies/services. No production provisioning or activation.
import assert from "node:assert/strict"
import { spawn, execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { copyFile, mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { build } from "esbuild"
import { OpenCode } from "@opencode/client"
import { ASSIGNED_CLI, privateRoot } from "../../../../../scripts/missions-child-environment/runtime.mjs"

const original = { ...process.env }, children = []
const sourceFiles = ["opencode/missions/native-managed-owner.ts", "opencode/missions/native-managed-owner.test.mjs",
  "opencode/missions/native-authority-provider.ts", "workspaces/native-service-registration.ts", "host-lifetime/process-identity.ts",
  "missions/host-authority/private-files.ts", "host-lifetime/windows-storage.ts", "host-lifetime/storage.ts"]
const hash = bytes => createHash("sha256").update(bytes).digest("hex")
const hashes = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, hash(await readFile(path.resolve("packages/server/src", file)))])))
const sourceInputs = await hashes(), officialSourceInputs = {}
for (const file of ["cli/src/server-process.ts", "cli/src/services/service-registration.ts", "cli/src/services/service-config.ts",
  "server/src/server-info.ts", "util/src/global.ts", "core/src/database/database.ts"]) {
  const url = `https://raw.githubusercontent.com/anomalyco/opencode/v2.0.24/packages/${file}`
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) })
  assert(response.ok, "Official source unavailable")
  officialSourceInputs[url] = hash(await response.text())
}
let watchdog
try {
  const prepared = await privateRoot(ASSIGNED_CLI)
  // The approved Temp ancestor grants unrelated sandbox identities replacement
  // rights. Move ONLY our owned fixture; never weaken policy/change shared ACLs.
  const parent = await mkdtemp("C:/Users/Admin/AppData/Local/missions-managed-owner-")
  const root = path.join(parent, "fixture")
  await rename(prepared.root, root)
  const former = path.normalize(prepared.root)
  for (const [name, value] of Object.entries(process.env)) if (value && path.normalize(value).startsWith(former)) process.env[name] = root+path.normalize(value).slice(former.length)
  const isolated = { root, config: path.join(root,"config"), project: path.join(root,"project") }
  // Explicit fixture-only privacy provisioning, before native service creation.
  if (process.platform === "win32") {
    const sid = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value"], { encoding: "utf8", windowsHide: true }).trim()
    assert(/^S-1-5-21-/.test(sid))
    execFileSync("icacls.exe", [isolated.root, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F"],
      { windowsHide: true, stdio: "pipe" })
  }
  const copy = path.join(isolated.root, "opencode.exe")
  await copyFile(ASSIGNED_CLI, copy)
  assert.equal(hash(await readFile(copy)), hash(await readFile(ASSIGNED_CLI)))
  const plugin = path.join(isolated.root, "plugin"), enrollmentFile = path.join(isolated.root, "managed-enrollment.json")
  await mkdir(plugin)
  const entry = path.join(plugin, "entry.mjs")
  await writeFile(entry, `import { Plugin, Rpc } from "@opencode/plugin/effect";
import { Cause, Context, Effect, Option } from "effect";
import { observeNativeManagedOwner, acquireNativeManagedOwner } from ${JSON.stringify(path.resolve("packages/server/src/opencode/missions/native-managed-owner.ts"))};
import { MISSION_AUTHORITY_STORAGE_PREFIX } from ${JSON.stringify(path.resolve("packages/server/src/missions/authority-store.ts"))};
 import { acquireNativeRecurrenceAuthorityProvider } from ${JSON.stringify(path.resolve("packages/server/src/opencode/missions/native-authority-provider.ts"))};
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
const enrollmentFile=${JSON.stringify(enrollmentFile)};
const method={input:{type:"object"},output:{type:"object"}};
const rpc=Rpc.define({id:"private.missions.managed-owner",methods:{observe:method,check:method,competitor:method},events:{}});
export default Plugin.define({id:"codenomad.missions",effect(ctx){return Effect.gen(function*(){
 // Explicit owned-fixture namespace provisioning, NOT part of the producer.
 const namespace="9f6f590e-271d-477f-8c02-7a6a119d63b9";
 const prior=yield* ctx.storage.get(MISSION_AUTHORITY_STORAGE_PREFIX+"/namespace");
 if(prior===undefined)yield* ctx.storage.set(MISSION_AUTHORITY_STORAGE_PREFIX+"/namespace",namespace);
 let checkStep="start";
 yield* ctx.rpc.register(rpc,{observe:()=>Effect.gen(function*(){
  const graph={};for(const [name,tag] of [["global","@opencode/Global"],["server","@opencode/server/ServerInfo"],["database","@opencode/storage/Database"]])
   graph[name]=Option.isSome(yield* Effect.serviceOption(Context.Service(tag)));
  return yield* observeNativeManagedOwner(ctx).pipe(Effect.map(value=>({...value,graph})),Effect.catchCause(()=>Effect.succeed({denied:true,graph})));
 }).pipe(Effect.scoped),check:input=>Effect.gen(function*(){
  const enrolled=JSON.parse(readFileSync(enrollmentFile,"utf8"));
  const owner=yield* acquireNativeManagedOwner(ctx,enrollmentFile);
  checkStep="metadata-acquisition";
  const scope={namespace,projectID:ctx.location.project.id,projectCanonical:ctx.location.project.canonical,profileID:"fixture-profile",
   executionHost:"fixture-host",scheduleID:"fixture_schedule",daemonStorageID:owner.daemonStorageID};
  // Explicit fixture enrollment of a genuine idle anchor; the producer neither
  // creates sessions nor authorizes their enrollment. No signer keys are minted.
   const metadata=yield* acquireNativeRecurrenceAuthorityProvider(ctx,scope,owner);
  assert.equal(yield* Effect.promise(()=>metadata.read()),undefined);
  assert.equal(owner.assertCurrent(),true);
  const {db}=yield* Context.Service("@opencode/storage/Database");
  const proofKey=MISSION_AUTHORITY_STORAGE_PREFIX+"/recurrence/managed-owner/proof";
  const nativeKey="plugin:"+Array.from("codenomad.missions").map(c=>c.charCodeAt(0).toString(16).padStart(4,"0")).join("")+":"+proofKey;
  yield* ctx.storage.set(proofKey,0);
  const negatives=[];
  for(const mode of ["registration-removed","registration-replaced","credential-replaced","enrollment-removed","enrollment-replaced","stale-start","stale-storage"]){
   checkStep=mode;
   const registrationFile=enrolled.service.registrationFile;
   const target=mode.startsWith("registration")||mode==="credential-replaced"?registrationFile:enrollmentFile;
   const raw=readFileSync(target,"utf8"), withheld=target+".fixture-withheld";
   const configRaw=mode==="credential-replaced"?readFileSync(enrolled.service.configFile,"utf8"):undefined;
   let mutated=false,finalHookReached=false,wrote=false;
   try{
    const exit=yield* db.transaction(()=>Effect.gen(function*(){
     owner.assertCurrent();
     yield* db.$client.unsafe("UPDATE kv SET value=? WHERE key=?",["1",nativeKey]).withoutTransform;
     wrote=true;
     // Retirement/replacement AFTER the operation's inside guard, BEFORE its
     // shared final synchronous hook. The original native connection rolls back.
     yield* Effect.promise(()=>new Promise(resolve=>queueMicrotask(()=>{
      if(mode.endsWith("removed"))renameSync(target,withheld);
      else {const changed=JSON.parse(raw);if(mode==="registration-replaced")changed.id=randomUUID();
       else if(mode==="credential-replaced"){changed.password=randomUUID();writeFileSync(enrolled.service.configFile,JSON.stringify({...JSON.parse(configRaw),password:changed.password}));}
       else if(mode==="enrollment-replaced")changed.namespace=randomUUID();
       else if(mode==="stale-start")changed.service.startIdentity+="-stale";
       else changed.database.ino+="0";
       writeFileSync(target,JSON.stringify(changed));}
      mutated=true;resolve();
     })));
    }).pipe(Effect.tap(()=>Effect.sync(()=>{finalHookReached=true;return owner.assertCurrent()}))),{behavior:"immediate"}).pipe(Effect.exit);
    assert.equal(exit._tag,"Failure",mode);assert.equal(finalHookReached,true);assert.equal(wrote,true);
   }finally{if(mutated){if(mode.endsWith("removed"))renameSync(withheld,target);else writeFileSync(target,raw);
    if(configRaw!==undefined)writeFileSync(enrolled.service.configFile,configRaw);}}
   assert.equal(yield* ctx.storage.get(proofKey),0,mode+" must roll back actual native write");
   assert.equal(owner.assertCurrent(),true);
   negatives.push({mode,finalHookReached,afterWriteRollback:true});
  }
  // Positive final native IMMEDIATE transaction, fixed own-plugin metadata only.
  yield* db.transaction(()=>db.$client.unsafe("UPDATE kv SET value=? WHERE key=?",["1",nativeKey]).withoutTransform.pipe(
   Effect.tap(()=>Effect.sync(owner.assertCurrent))),{behavior:"immediate"});
  assert.equal(yield* ctx.storage.get(proofKey),1);
  return {managedOwnerQualified:true,nativeMetadataAcquired:true,fixedMetadataCommit:1,negatives,signerKeysMinted:false};
 }).pipe(Effect.scoped,Effect.catchCause(()=>Effect.succeed({checkFailed:true,checkStep}))),competitor:()=>Effect.gen(function*(){
  const {db}=yield* Context.Service("@opencode/storage/Database");
  const database=yield* db.$client.unsafe("PRAGMA database_list").withoutTransform;
  const exit=yield* acquireNativeManagedOwner(ctx,enrollmentFile).pipe(Effect.exit);
  const proof=yield* ctx.storage.get(MISSION_AUTHORITY_STORAGE_PREFIX+"/recurrence/managed-owner/proof");
  return {pid:process.pid,databaseFile:database[0].file,denied:exit._tag==="Failure",...(proof===undefined?{}:{fixedMetadataCommit:proof})};
 }).pipe(Effect.scoped)});
});}});`)
  await build({ entryPoints: [entry], outfile: path.join(plugin, "index.mjs"), bundle: true, platform: "node", format: "esm",
    nodePaths: [path.resolve("node_modules")], logLevel: "silent" })
  await writeFile(path.join(plugin, "package.json"), JSON.stringify({ type: "module", main: "index.mjs" }))
  process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ update: "disable", snapshots: false, plugins: [plugin] })
  const allowed = new Set(["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL"])
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => allowed.has(name.toUpperCase()) || /^(OPENCODE_|XDG_)/i.test(name)))
  const deadline = Date.now() + 300_000
  const launch = async managed => {
    let logs = "", error
    const child = spawn(copy, ["serve", ...(managed ? ["--service"] : []), "--hostname", "127.0.0.1", "--port", "0", "--print-logs"],
      { cwd: isolated.root, env: environment, windowsHide: true })
    const closed = new Promise(resolve => child.once("close", resolve))
    children.push({ child, closed })
    child.once("error", value => { error = value })
    for (const stream of [child.stdout, child.stderr]) stream.on("data", data => { logs = (logs + data).slice(-1024 * 1024) })
    while (!/http:\/\/127\.0\.0\.1:\d+/.test(logs)) {
      if (error) throw new Error("Owned native startup failed")
      assert(child.exitCode === null && Date.now() < deadline, "Owned native startup deadline")
      await delay(50)
    }
    const url = logs.match(/http:\/\/127\.0\.0\.1:\d+/)[0]
    let password = environment.OPENCODE_SERVER_PASSWORD
    if (managed) {
      const registration = JSON.parse(await readFile(path.join(environment.XDG_STATE_HOME, "opencode", "service.json"), "utf8"))
      assert.equal(registration.pid, child.pid); assert.equal(registration.url, url)
      password = registration.password
    }
    const client = OpenCode.make({ baseUrl: url, headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` } })
    const info = await client.server.info({ signal: AbortSignal.timeout(10_000) })
    assert.equal(info.version, "2.0.24")
    await client.plugin.list({ location: { directory: isolated.project } }, { signal: AbortSignal.timeout(20_000) })
    return { client, info, child }
  }
  watchdog = setTimeout(() => children.forEach(({ child }) => child.kill()), 300_000); watchdog.unref()
  const managed = await launch(true)
  const observed = await managed.client.rpc.call({ rpcID: "private.missions.managed-owner", method: "observe",
    location: { directory: isolated.project }, input: {} }, { signal: AbortSignal.timeout(30_000) })
  assert.equal(observed.output.storageChallengeVerified,true)
  const unenrolled = await managed.client.rpc.call({rpcID:"private.missions.managed-owner",method:"competitor",
    location:{directory:isolated.project},input:{}},{signal:AbortSignal.timeout(20_000)})
  assert.equal(unenrolled.output.denied,true)
  await assert.rejects(readFile(enrollmentFile),{code:"ENOENT"})
  // This file is the explicit HUMAN-owned fixture provisioning step. No native
  // read/producer writes it; no credentials or signer material are in the record.
  await writeFile(enrollmentFile, JSON.stringify(observed.output.enrollment), { flag:"wx", mode:0o600 })
  const competitor = await launch(false)
  const competition = await competitor.client.rpc.call({ rpcID:"private.missions.managed-owner",method:"competitor",
    location:{directory:isolated.project},input:{} }, {signal:AbortSignal.timeout(30_000)})
  assert.equal(competition.output.denied,true)
  assert.notEqual(competition.output.pid,managed.child.pid)
  assert.equal(path.normalize(competition.output.databaseFile).toLowerCase(),observed.output.enrollment.database.file)
  const session = await managed.client.session.create({location:{directory:isolated.project},title:"Private managed owner anchor"})
  const check = await managed.client.rpc.call({rpcID:"private.missions.managed-owner",method:"check",
    location:{directory:isolated.project},input:{sessionID:session.id}}, {signal:AbortSignal.timeout(180_000)})
  const sameDBReadback = await competitor.client.rpc.call({rpcID:"private.missions.managed-owner",method:"competitor",
    location:{directory:isolated.project},input:{}},{signal:AbortSignal.timeout(30_000)})
  assert.equal(sameDBReadback.output.fixedMetadataCommit,1)
  assert.equal(sameDBReadback.output.denied,true)
  // Explicit fixture-owned managed restart. Keep the SAME protected enrollment
  // and SAME database; native reincarnation is evidence, never reauthorization.
  const enrollmentBytes = await readFile(enrollmentFile)
  managed.child.kill()
  await children.find(value=>value.child===managed.child).closed
  const reincarnated = await launch(true)
  const reincarnation = await reincarnated.client.rpc.call({rpcID:"private.missions.managed-owner",method:"observe",
    location:{directory:isolated.project},input:{}},{signal:AbortSignal.timeout(30_000)})
  assert.equal(reincarnation.output.storageChallengeVerified,true)
  assert.notEqual(reincarnation.output.enrollment.service.id,observed.output.enrollment.service.id)
  assert.notEqual(reincarnation.output.enrollment.service.startIdentity,observed.output.enrollment.service.startIdentity)
  assert.deepEqual(reincarnation.output.enrollment.database,observed.output.enrollment.database)
  const staleOwner = await reincarnated.client.rpc.call({rpcID:"private.missions.managed-owner",method:"competitor",
    location:{directory:isolated.project},input:{}},{signal:AbortSignal.timeout(30_000)})
  assert.equal(staleOwner.output.denied,true)
  assert.deepEqual(await readFile(enrollmentFile),enrollmentBytes)
  assert.deepEqual(await hashes(),sourceInputs,"Source changed during native proof")
  const receipt = { privateRoot: isolated.root, nativeVersion: managed.info.version, cliSha256: hash(await readFile(copy)),
    managedGraph: observed.output, competition:competition.output,sameDBReadback:sameDBReadback.output,check:check.output,
    missingEnrollmentDenied:true,managedReincarnation:{sameProtectedEnrollment:true,sameDB:true,newServiceID:reincarnation.output.enrollment.service.id,
      newStartIdentity:reincarnation.output.enrollment.service.startIdentity,staleOwnerDenied:true},sourceInputs, officialSourceInputs,
    permanentWriterExclusion:false,independentRollbackProtection:false,restartRequalification:false,productionActivated: false }
  await writeFile(path.join(isolated.root, "results.json"), JSON.stringify(receipt, null, 2))
  console.log(JSON.stringify(receipt))
  assert.equal(check.output.managedOwnerQualified, true)
} finally {
  clearTimeout(watchdog)
  for (const { child } of children) if (child.exitCode === null) child.kill()
  await Promise.all(children.map(({ closed }) => closed))
  for (const name of Object.keys(process.env)) if (!(name in original)) delete process.env[name]
  Object.assign(process.env, original)
}
