// Proof of existing primitives and their composition gaps, NOT a production gate.
// node packages/server/src/opencode/missions/native-protected-checkpoint.test.mjs
import assert from "node:assert/strict"
import { spawn, execFileSync } from "node:child_process"
import { createHash, generateKeyPairSync, sign } from "node:crypto"
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import { build } from "esbuild"
import { OpenCode } from "@opencode/client"
import { ASSIGNED_CLI, privateRoot } from "../../../../../scripts/missions-child-environment/runtime.mjs"
const original = { ...process.env }, children = [], src = file => path.resolve("packages/server/src",file)
const hash = value => createHash("sha256").update(value).digest("hex")
const files = ["opencode/missions/native-protected-checkpoint.test.mjs","opencode/missions/native-managed-owner.ts","opencode/missions/native-authority-provider.ts",
  "missions/host-authority/private-files.ts","missions/host-authority/store.ts","missions/host-authority/model.ts","missions/host-authority/qualification.ts",
  "host-lifetime/storage.ts","workspaces/family-authority-claim.ts","workspaces/git-common-directory.ts","workspaces/git-process.ts",
  "missions/authority-protocol.ts","missions/authority-synchronous.ts","missions/recurrence-authority-contract.ts","missions/recurrence-authority-store.ts","missions/recurrence-store.ts"]
const fingerprints = async () => Object.fromEntries(await Promise.all(files.map(async file=>[file,hash(await readFile(src(file)))])))
const sourceInputs = await fingerprints()
let watchdog
try {
  const prepared = await privateRoot(ASSIGNED_CLI), parent = await mkdtemp("C:/Users/Admin/AppData/Local/missions-protected-proof-")
  const root = path.join(parent,"fixture"), former = path.normalize(prepared.root)
  await rename(prepared.root,root)
  for(const [name,value] of Object.entries(process.env))if(value&&path.normalize(value).startsWith(former))process.env[name]=root+path.normalize(value).slice(former.length)
  const project=path.join(root,"project"), profile=path.join(root,"profile"), protectedRoot=path.join(root,"protected")
  for(const directory of [profile,protectedRoot])await mkdir(directory)
  const sid=execFileSync("powershell.exe",["-NoProfile","-NonInteractive","-Command","[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value"],{encoding:"utf8",windowsHide:true}).trim()
  assert(/^S-1-5-21-/.test(sid))
  execFileSync("icacls.exe",[root,"/inheritance:r","/grant:r",`*${sid}:(OI)(CI)F`,"*S-1-5-18:(OI)(CI)F"],{windowsHide:true,stdio:"pipe"})
  const copy=path.join(root,"opencode.exe");await copyFile(ASSIGNED_CLI,copy)
  const enrollmentFile=path.join(root,"managed.json"), snapshot=path.join(root,"lower-valid.db"), plugin=path.join(root,"plugin")
  await mkdir(plugin)
  // Main-process HUMAN fixture provisioner only. Private keys never enter the
  // plugin package, any file/RPC, errors, results or a due passage.
  const provisioner=path.join(root,"provisioner.mjs")
  await build({stdin:{contents:`export {HostStorage} from ${JSON.stringify(src("host-lifetime/storage.ts"))};
export {canonicalScope} from ${JSON.stringify(src("host-lifetime/protocol.ts"))};
export {authorityDigest,authoritySignerDigest} from ${JSON.stringify(src("missions/authority-protocol.ts"))};
export * from ${JSON.stringify(src("missions/recurrence-authority-contract.ts"))};
export {physical} from ${JSON.stringify(src("missions/host-authority/private-files.ts"))};`,resolveDir:process.cwd()},outfile:provisioner,bundle:true,platform:"node",format:"esm",logLevel:"silent"})
  const p=await import(pathToFileURL(provisioner).href), storageScope=p.canonicalScope("proof",path.join(profile,"config.yaml"),root,root)
  const storage=new p.HostStorage(protectedRoot,storageScope);await storage.initialize()
  const publicFile=path.join(storage.directory,"standing.json"), familyRoot=path.join(root,"families");await mkdir(familyRoot)
  // Its self-contained worker serializes workerMain.toString(). Preserve the
  // literal require inside that function in this owned CJS helper bundle; an
  // ESM __require closure is a fixture-packaging error, not a native API gate.
  const familyReader=path.join(plugin,"family-reader.cjs"),familyURI=pathToFileURL(familyReader).href
  await build({stdin:{contents:`export {readFamilyAuthorityIdentity} from ${JSON.stringify(src("workspaces/family-authority-claim.ts"))};
export {runWorktreeGit} from ${JSON.stringify(src("workspaces/git-process.ts"))};`,resolveDir:process.cwd()},outfile:familyReader,bundle:true,platform:"node",format:"cjs",logLevel:"silent"})
  const entry=path.join(plugin,"entry.mjs")
  await writeFile(entry,`import {Plugin,Rpc} from "@opencode/plugin/effect";
import {Cause,Context,Effect} from "effect";import assert from "node:assert/strict";
import {createPublicKey,verify} from "node:crypto";import {openSync,closeSync,fstatSync,lstatSync,readSync,realpathSync,readFileSync,writeFileSync,renameSync,unlinkSync} from "node:fs";
import {HostStorage} from ${JSON.stringify(src("host-lifetime/storage.ts"))};
import {ProtectedAuthorityFiles,physical,verifyPrivateSync} from ${JSON.stringify(src("missions/host-authority/private-files.ts"))};
import {FamilyAuthorityStore} from ${JSON.stringify(src("workspaces/family-authority-claim.ts"))};
import {readFamilyAuthorityIdentity,runWorktreeGit} from ${JSON.stringify(familyURI)};
import {authorityDigest,authoritySignerDigest,canonicalAuthority} from ${JSON.stringify(src("missions/authority-protocol.ts"))};
import {assertSynchronousAuthorityGuard} from ${JSON.stringify(src("missions/authority-synchronous.ts"))};
import {MISSION_AUTHORITY_STORAGE_PREFIX} from ${JSON.stringify(src("missions/authority-store.ts"))};
import {signedRecurrenceStandingIntentSchema,recurrenceStandingSigningBytes,recurrenceEffectID,assertRecurrenceChild} from ${JSON.stringify(src("missions/recurrence-authority-contract.ts"))};
import {recurrenceAuthorityDocumentSchema} from ${JSON.stringify(src("missions/recurrence-authority-store.ts"))};
import {observeNativeManagedOwner,acquireNativeManagedOwner} from ${JSON.stringify(src("opencode/missions/native-managed-owner.ts"))};
import {acquireNativeRecurrenceAuthorityProvider,NATIVE_RECURRENCE_STORAGE_ID_KEY,nativeRecurrenceAnchorKey} from ${JSON.stringify(src("opencode/missions/native-authority-provider.ts"))};
const enrollmentFile=${JSON.stringify(enrollmentFile)},publicFile=${JSON.stringify(publicFile)},snapshot=${JSON.stringify(snapshot)};
const storageScope=${JSON.stringify(storageScope)},protectedRoot=${JSON.stringify(protectedRoot)},familyRoot=${JSON.stringify(familyRoot)};
const method={input:{type:"object"},output:{type:"object"}},rpc=Rpc.define({id:"private.missions.protected-proof",methods:{observe:method,seed:method,tear:method,recheck:method},events:{}});
const same=(a,b)=>canonicalAuthority(a)===canonicalAuthority(b);
// PRIVATE PROBE reader, not a new public CAS/authority framework. Default real
// privacy policy; no substitution, qualification flag, private key or signer fallback.
function readProtected(){verifyPrivateSync(publicFile,false);const fd=openSync(publicFile,"r");try{
 const stat=fstatSync(fd),named=lstatSync(publicFile);assert(stat.isFile()&&stat.nlink===1&&stat.ino===named.ino&&stat.dev===named.dev&&stat.size<=65536);
 const bytes=Buffer.alloc(65537);let size=0;while(size<bytes.length){const n=readSync(fd,bytes,size,bytes.length-size,size);if(!n)break;size+=n;}assert(size<=65536);
 const value=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes.subarray(0,size)));
 const signed=signedRecurrenceStandingIntentSchema.parse(value.parent),key=createPublicKey({key:Buffer.from(value.publicKey,"base64"),format:"der",type:"spki"});
 assert.equal(key.type,"public");assert.equal(key.asymmetricKeyType,"ed25519");assert.equal(key.export({format:"der",type:"spki"}).toString("base64"),value.publicKey);
 assert.equal(authoritySignerDigest(key),signed.body.signerDigest,"protected public signer digest mismatch");
 const signature=Buffer.from(signed.signature,"base64");assert.equal(signature.toString("base64"),signed.signature);
 assert.equal(verify(null,recurrenceStandingSigningBytes(signed.body),key,signature),true,"protected standing signature invalid");
 assert.equal(value.provisioningGeneration,signed.body.provisioningGeneration);assert.equal(value.parentDigest,authorityDigest(signed));
 assert.equal(value.checkpoint.epoch,signed.body.epoch);assert.equal(value.checkpoint.daemonStorageID,signed.body.daemonStorageID);
 assert(same(value.scope,Object.fromEntries(Object.keys(value.scope).map(k=>[k,signed.body[k]]))));
 assert.equal(physical(realpathSync(signed.body.projectCanonical)),physical(signed.body.projectCanonical));
 for(const root of signed.body.roots){assert.equal(root.mode,"git");assert.equal(physical(realpathSync(root.directory)),root.checkout);assert.equal(physical(realpathSync(root.family)),root.family);}
 return {value,identity:{dev:String(stat.dev),ino:String(stat.ino)},key};
}finally{closeSync(fd)}}
function checkpoint(doc,record){assert(same(doc.scope,record.scope));assert.equal(doc.parent.body.epoch,record.checkpoint.epoch,"protected checkpoint epoch mismatch");
 assert.equal(doc.revision,record.checkpoint.revision,"protected checkpoint revision mismatch");assert.equal(authorityDigest(doc),record.checkpoint.headDigest,"protected checkpoint head mismatch");}
export default Plugin.define({id:"codenomad.missions",effect(ctx){return Effect.gen(function*(){
 const namespace="9f6f590e-271d-477f-8c02-7a6a119d63b9";if((yield*ctx.storage.get(MISSION_AUTHORITY_STORAGE_PREFIX+"/namespace"))===undefined)yield*ctx.storage.set(MISSION_AUTHORITY_STORAGE_PREFIX+"/namespace",namespace);
 const families=new FamilyAuthorityStore({root:familyRoot,profileKey:storageScope.key,executionHostKey:"fixture-host"});let heldFamily;
 const get=Effect.fn(function*(sessionID){stage="get-owner";const owner=yield*acquireNativeManagedOwner(ctx,enrollmentFile);stage="get-trust";const trust=readProtected();
  stage="get-scope";const scope=trust.value.scope;assert.equal(scope.daemonStorageID,owner.daemonStorageID);assert.equal(scope.namespace,owner.namespace);
  stage="get-family";
  const family=yield*Effect.promise(()=>readFamilyAuthorityIdentity(ctx.location.directory));
  assert.equal(family,trust.value.parent.body.roots[0].family);
  stage="get-metadata";const provider=yield*acquireNativeRecurrenceAuthorityProvider(ctx,sessionID,scope);return{owner,provider,trust};});
 let stage="start",familyFinalChecks=0;const safely=e=>e.pipe(Effect.scoped,Effect.catchCause(c=>Effect.succeed({failed:true,stage,assertion:Cause.pretty(c).includes("AssertionError"),
  typeError:Cause.pretty(c).match(/TypeError:[^\\r\\n]*/)?.[0]??null})));
 yield*ctx.rpc.register(rpc,{observe:()=>safely(observeNativeManagedOwner(ctx).pipe(Effect.map(value=>({...value,location:{directory:ctx.location.directory,project:{id:ctx.location.project.id,canonical:ctx.location.project.canonical}}})))),
 seed:input=>safely(Effect.gen(function*(){stage="explicit-human-seed";
  const owner=yield*acquireNativeManagedOwner(ctx,enrollmentFile),trust=readProtected(),scope=trust.value.scope;
  assert.equal(scope.daemonStorageID,owner.daemonStorageID);heldFamily=yield*Effect.promise(()=>families.acquire(trust.value.parent.body.roots[0].family));
  yield*Effect.promise(()=>heldFamily.assertCurrent());yield*ctx.storage.set(NATIVE_RECURRENCE_STORAGE_ID_KEY,owner.daemonStorageID);
  yield*ctx.storage.set(nativeRecurrenceAnchorKey(scope,input.sessionID),{version:1,scope,sessionID:input.sessionID,location:{directory:ctx.location.directory}});
  const provider=yield*acquireNativeRecurrenceAuthorityProvider(ctx,input.sessionID,scope),initial=recurrenceAuthorityDocumentSchema.parse(input.initial),lower=recurrenceAuthorityDocumentSchema.parse(input.lower);
  checkpoint(initial,trust.value);assert(same(initial.parent,trust.value.parent));assertRecurrenceChild(lower.child.parent,lower.child.grant);
  const familyReader=yield*Effect.promise(()=>readFamilyAuthorityIdentity(ctx.location.directory)).pipe(Effect.exit);
  const workerProbe=yield*Effect.promise(()=>runWorktreeGit(ctx.location.directory,["rev-parse","--path-format=absolute","--git-common-dir"],10000)).pipe(
   Effect.as({available:true}),Effect.catchCause(c=>Effect.succeed({available:false,
    failure:Cause.pretty(c).split("\\n")[0].slice(0,240)})));
  yield*Effect.promise(()=>provider.archiveParent(initial.parent,null,owner.assertCurrent));yield*Effect.promise(()=>provider.publish(null,initial,owner.assertCurrent));
  yield*Effect.promise(()=>provider.publish(initial,lower,owner.assertCurrent));
  const {db}=yield*Context.Service("@opencode/storage/Database");yield*db.$client.unsafe("VACUUM INTO ?",[snapshot]).withoutTransform;
  const descriptor={scope:storageScope,physicalProfile:physical(${JSON.stringify(profile)}),executionHost:"fixture-host"};
  const incompatible=new ProtectedAuthorityFiles(protectedRoot,descriptor);
  yield*Effect.promise(()=>assert.rejects(incompatible.cas(null,async()=>({...trust.value,v:1,revision:1,revoked:false,mirror:null}),owner.assertCurrent,true),/storage-invalid/));
  return {nativeRevision:1,validNativeSnapshot:true,publicOnlyCASRejected:true,actualFamilyClaimHeld:true,existingFamilyReaderAvailable:familyReader._tag==="Success",workerProbe};
 })),tear:input=>safely(Effect.gen(function*(){stage=input.when;
  const {owner,provider,trust}=yield*get(input.sessionID),before=yield*Effect.promise(()=>provider.read()),next=recurrenceAuthorityDocumentSchema.parse(input.next);
  checkpoint(next,trust.value);assert.equal(trust.value.pending.operationID,next.child.effects[0].operationID);
  if(input.when==="evidence-after"){checkpoint(before,trust.value);owner.assertCurrent();assert.equal(before.child.effects[0].receipt,null);assert.equal(familyFinalChecks,4);
   return {nativeRevision:2,lostRpcAckAfterCommit:true,protectedReservationUnchanged:true,asyncFamilyFinalFenceRejected:true,finalFamilyGuardCalls:familyFinalChecks,effectsExecuted:0,automaticReplay:false};}
  assert.equal(before.revision,1);
  assert.equal(next.child.effects[0].receipt,null);assert.equal(next.child.effects[0].operationID,recurrenceEffectID(next.child.grant,next.child.effects[0].effect));
  stage="tear-guard";const guard=()=>{owner.assertCurrent();const fresh=readProtected();assert(same(fresh.value,trust.value)&&same(fresh.identity,trust.identity));return true;};
  if(input.when==="before-native"){
   const raw=readFileSync(publicFile),withheld=publicFile+".fixture-withheld",trustNegatives=[];
   for(const mode of ["absent","same-bytes-replaced"]){
    renameSync(publicFile,withheld);try{
     if(mode!=="absent")writeFileSync(publicFile,raw);
     assert.throws(guard);trustNegatives.push(mode);
    }finally{if(mode!=="absent")unlinkSync(publicFile);renameSync(withheld,publicFile);}
    guard();assert(same(readProtected().value.pending,trust.value.pending));
   }
   // Keep the SAME inode and consistent parent digest so neither replacement
   // detection nor an unrelated content comparison can satisfy crypto negatives.
   for(const mode of ["invalid-signature","wrong-public-signer"]){const changed=JSON.parse(raw);
    if(mode==="invalid-signature"){changed.parent.signature=(changed.parent.signature[0]==="A"?"B":"A")+changed.parent.signature.slice(1);changed.parentDigest=authorityDigest(changed.parent);}
    else changed.publicKey=input.otherPublicKey;
    try{writeFileSync(publicFile,JSON.stringify(changed));assert.throws(readProtected,mode==="invalid-signature"?/protected standing signature invalid/:/protected public signer digest mismatch/);trustNegatives.push(mode);}
    finally{writeFileSync(publicFile,raw);}guard();
   }
   let checks=0;yield*Effect.promise(()=>assert.rejects(provider.publish(before,next,()=>{guard();if(++checks===4)throw Error("owned fixture final-hook tear");return true;}),/policy-unqualified/));
   assert.equal((yield*Effect.promise(()=>provider.read())).revision,1);assert(same(readProtected().value.pending,trust.value.pending));
   return {nativeRolledBack:true,protectedReservationUnchanged:true,trustNegatives,automaticReplay:false};
  }
  // The genuine existing family reference has only an async current API. It
  // cannot be passed off as the final synchronous literal-true native gate.
  yield*Effect.promise(()=>assert.rejects(provider.publish(before,next,()=>{guard();if(++familyFinalChecks===4)return heldFamily.assertCurrent().then(()=>true);return true;}),/policy-unqualified/));
  assert.equal(familyFinalChecks,4);assert.equal((yield*Effect.promise(()=>provider.read())).revision,1);
  yield*Effect.promise(()=>heldFamily.assertCurrent());
  yield*Effect.promise(()=>provider.publish(before,next,guard)); // probe metadata only; NOT family-qualified due execution
  const saved=yield*Effect.promise(()=>provider.read());checkpoint(saved,trust.value);
  assert(same(readProtected().value.pending,trust.value.pending));assert.equal(saved.child.effects[0].receipt,null);
  // Marker contains no authority/credential data. The caller aborts its genuine
  // HTTP request while the response is withheld, then performs evidence-only read.
  console.log("PRIVATE_PROTECTED_METADATA_COMMITTED");yield*Effect.sleep(60000);
  return {unexpectedAck:true};
 })),recheck:input=>safely(Effect.gen(function*(){stage="restored-valid-native-bytes";
  const {owner,provider,trust}=yield*get(input.sessionID),doc=yield*Effect.promise(()=>provider.read());owner.assertCurrent();
  assert.equal(doc.revision,1);assertRecurrenceChild(doc.child.parent,doc.child.grant);
  if(input.kind==="epoch-denial"){assert.equal(doc.parent.body.epoch,1);assert.equal(trust.value.parent.body.epoch,2);assert.equal(trust.value.parent.body.action,"pause");
   assert.equal(verify(null,recurrenceStandingSigningBytes(doc.parent.body),trust.key,Buffer.from(doc.parent.signature,"base64")),true);
   assert.throws(()=>checkpoint(doc,trust.value),/protected checkpoint epoch mismatch/);assert.equal(trust.value.pending.operationID,input.operationID);
   return {validLowerEpoch:1,protectedEpoch:2,readSideEpochDenial:true,originalUncertainOperationUnchanged:true,automaticReplay:false};}
  assert(same(doc.parent,trust.value.parent));
  assert.throws(()=>checkpoint(doc,trust.value),/protected checkpoint revision mismatch/);
  assert.equal(trust.value.pending.operationID,input.operationID);assert.equal(trust.value.pending.state,"uncertain");
  return {validLowerNativeRevision:1,protectedRevision:2,rollbackRejectedByCheckpoint:true,originalOperationID:trust.value.pending.operationID,
   unchangedUncertainReservation:true,automaticReplay:false,cryptographicParentVerified:true,currentManagedOwnerVerified:true};
 }))});
});}});`)
  await build({entryPoints:[entry],outfile:path.join(plugin,"index.mjs"),bundle:true,platform:"node",format:"esm",external:[familyURI],nodePaths:[path.resolve("node_modules")],logLevel:"silent"})
  await writeFile(path.join(plugin,"package.json"),JSON.stringify({type:"module",main:"index.mjs"}))
  process.env.OPENCODE_CONFIG_CONTENT=JSON.stringify({update:"disable",snapshots:false,plugins:[plugin]})
  const allowed=new Set(["PATH","PATHEXT","SYSTEMROOT","WINDIR","COMSPEC","TEMP","TMP","HOME","USERPROFILE","APPDATA","LOCALAPPDATA","GIT_CONFIG_NOSYSTEM","GIT_CONFIG_GLOBAL"])
  const environment=Object.fromEntries(Object.entries(process.env).filter(([name])=>allowed.has(name.toUpperCase())||/^(OPENCODE_|XDG_)/i.test(name)))
  const deadline=Date.now()+480000,options=()=>({signal:AbortSignal.timeout(Math.max(1,Math.min(180000,deadline-Date.now())))})
  const launch=async()=>{let logs="",notifyCommit;const committed=new Promise(resolve=>{notifyCommit=resolve});const child=spawn(copy,["serve","--service","--hostname","127.0.0.1","--port","0","--print-logs"],{cwd:root,env:environment,windowsHide:true});
    const closed=new Promise(resolve=>child.once("close",resolve));children.push({child,closed});for(const stream of [child.stdout,child.stderr])stream.on("data",bytes=>{logs=(logs+bytes).slice(-1024*1024);if(logs.includes("PRIVATE_PROTECTED_METADATA_COMMITTED"))notifyCommit()});
    while(!/http:\/\/127\.0\.0\.1:\d+/.test(logs)){assert(child.exitCode===null&&Date.now()<deadline,"Owned native startup failed");await delay(50)}
    const record=JSON.parse(await readFile(path.join(environment.XDG_STATE_HOME,"opencode","service.json"),"utf8"));assert.equal(record.pid,child.pid);
    const client=OpenCode.make({baseUrl:record.url,headers:{authorization:`Basic ${Buffer.from(`opencode:${record.password}`).toString("base64")}`}});
    const info=await client.server.info(options());assert.equal(info.version,"2.0.24");await client.plugin.list({location:{directory:project}},options());
    return {child,closed,client,info,committed};}
  watchdog=setTimeout(()=>children.forEach(({child})=>child.kill()),480000);watchdog.unref()
  const call=(service,method,input={},requestOptions=options())=>service.client.rpc.call({rpcID:"private.missions.protected-proof",method,location:{directory:project},input},requestOptions).then(result=>result.output)
  const service=await launch(),observed=await call(service,"observe");assert.equal(observed.storageChallengeVerified,true)
  await writeFile(enrollmentFile,JSON.stringify(observed.enrollment),{flag:"wx",mode:0o600})
  const session=await service.client.session.create({location:{directory:project},title:"Private protected checkpoint anchor"},options())
  const family=p.physical(execFileSync("git",["-C",project,"rev-parse","--path-format=absolute","--git-common-dir"],{encoding:"utf8",windowsHide:true}).trim())
  const rootIdentity={mode:"git",directory:observed.location.directory,family,checkout:p.physical(project)}
  const scope={namespace:observed.enrollment.namespace,projectID:observed.location.project.id,projectCanonical:observed.location.project.canonical,
    profileID:storageScope.key,executionHost:"fixture-host",scheduleID:"protected_probe",daemonStorageID:observed.enrollment.daemonStorageID}
  const execution={agent:"build",model:{providerID:"fixture",id:"fixture"}},config={consigne:"Owned protected checkpoint proof",clock:{time:"07:00",zone:"UTC"},
    profileID:scope.profileID,executionHost:scope.executionHost,profiles:{coordinator:execution,roles:{specialist:execution}},taskMode:"native",roots:[rootIdentity],watchedConversationIDs:[],publication:{policy:"disabled",conversationIDs:[]}}
  const keys=generateKeyPairSync("ed25519"),body={...scope,authorityID:"fixture-authority",keyID:"fixture-public-key",roots:[rootIdentity],version:1,policy:p.RECURRENCE_AUTHORITY_POLICY,
    scheduleRevision:0,epoch:1,expectedRevision:null,provisioningGeneration:"human-fixture-generation",signerDigest:p.authoritySignerDigest(keys.publicKey),action:"authorize",configDigest:p.authorityDigest(config),config,budgets:{effects:2,nativeCalls:0,inboxMessages:0,publications:0}}
  const signed={body,signature:sign(null,p.recurrenceStandingSigningBytes(body),keys.privateKey).toString("base64")}
  const initial={version:1,scope,revision:0,parent:signed,settledSequence:0,lastArchiveDigest:null,child:null}
  const checkpoint=doc=>({daemonStorageID:scope.daemonStorageID,epoch:doc.parent.body.epoch,revision:doc.revision,headDigest:p.authorityDigest(doc)})
  const publicRecord={version:1,scope,publicKey:keys.publicKey.export({format:"der",type:"spki"}).toString("base64"),provisioningGeneration:body.provisioningGeneration,
    parent:signed,parentDigest:p.authorityDigest(signed),checkpoint:checkpoint(initial),pending:null}
  await storage.atomic("standing.json",publicRecord)
  // Genuine recurrence grant/effect identity, no receipt fabrication or effect.
  const {NativeMissionRecurrenceStore}=await import(pathToFileURL(await(async()=>{const file=path.join(root,"recurrence-store.mjs");await build({stdin:{contents:`export {NativeMissionRecurrenceStore} from ${JSON.stringify(src("missions/recurrence-store.ts"))};`,resolveDir:process.cwd()},outfile:file,bundle:true,platform:"node",format:"esm",logLevel:"silent"});return file})()).href)
  const values=new Map(),recurrence=new NativeMissionRecurrenceStore({get:async key=>values.get(key),set:async(key,value)=>values.set(key,value),scan:async()=>({entries:[]})},scope.projectID,scope.projectCanonical)
  // Pure local fixture descriptor construction, NOT an ownership/consent proof.
  const schedule=await recurrence.create(scope.scheduleID,config,1,()=>true)
  await recurrence.reserve(scope.scheduleID,schedule.revision,{kind:"manual",requestID:"private_request",expectedRevision:schedule.revision,at:2},2,()=>true)
  const current=await recurrence.read(scope.scheduleID),grant=p.deriveRecurrenceChild(signed,current,1)
  const lower={...initial,revision:1,child:{parent:signed,grant,effects:[]}}
  const effect={kind:"create"},operationID=p.recurrenceEffectID(grant,effect),next={...lower,revision:2,child:{...lower.child,effects:[{operationID,effect,receipt:null}]}}
  const seed=await call(service,"seed",{sessionID:session.id,initial,lower});assert.equal(seed.nativeRevision,1,JSON.stringify(seed))
  const pending={state:"uncertain",operationID,expectedRevision:1,expectedHead:p.authorityDigest(lower),nextHead:p.authorityDigest(next)}
  // EXPLICIT fixture staging, not an invented production CAS. Future floor and
  // original operation survive BOTH tears. No autonomous acknowledgment clears it.
  await storage.atomic("standing.json",{...publicRecord,checkpoint:checkpoint(next),pending})
  const protectedBytes=await readFile(publicFile)
  const otherPublicKey=generateKeyPairSync("ed25519").publicKey.export({format:"der",type:"spki"}).toString("base64")
  const beforeTear=await call(service,"tear",{when:"before-native",sessionID:session.id,next,otherPublicKey});assert.equal(beforeTear.nativeRolledBack,true,JSON.stringify(beforeTear))
  assert.deepEqual(await readFile(publicFile),protectedBytes)
  const cancelReply=new AbortController(),unknownAdmission=call(service,"tear",{when:"after-native",sessionID:session.id,next},{signal:AbortSignal.any([cancelReply.signal,options().signal])})
  await Promise.race([service.committed,unknownAdmission.then(()=>assert.fail("Native reply arrived before commit marker"))])
  cancelReply.abort();await assert.rejects(unknownAdmission)
  const afterTear=await call(service,"tear",{when:"evidence-after",sessionID:session.id,next});assert.equal(afterTear.nativeRevision,2,JSON.stringify(afterTear))
  assert.deepEqual(await readFile(publicFile),protectedBytes)
  service.child.kill();await service.closed
  // Restore REAL complete valid SQLite bytes only after the owned daemon exits.
  // Truncating the same fixture file retains its physical identity. No external DB opens.
  for(const suffix of ["-wal","-shm"])await rm(environment.OPENCODE_DB+suffix,{force:true})
  await copyFile(snapshot,environment.OPENCODE_DB)
  const restored=await launch(),restoredOwner=await call(restored,"observe")
  assert.equal(restoredOwner.enrollment.daemonStorageID,scope.daemonStorageID)
  // HUMAN fixture enrollment for this new incarnation, NOT autonomous takeover or
  // production restart acceptance. Signer/standing/checkpoint are NOT changed.
  await writeFile(enrollmentFile,JSON.stringify(restoredOwner.enrollment),{mode:0o600})
  const rollback=await call(restored,"recheck",{sessionID:session.id,operationID});assert.equal(rollback.rollbackRejectedByCheckpoint,true,JSON.stringify(rollback))
  assert.deepEqual(await readFile(publicFile),protectedBytes)
  // Separate explicit HUMAN Pause, not signing/re-enrolling in a due passage.
  // Read-side denial is monotonic; the missing authoritative write-side CAS is
  // NOT claimed solved by this fixture's one sequential atomic staging write.
  const pauseBody={...body,epoch:2,expectedRevision:2,action:"pause"},pauseParent={body:pauseBody,signature:sign(null,p.recurrenceStandingSigningBytes(pauseBody),keys.privateKey).toString("base64")}
  const pausedHead={...next,revision:3,parent:pauseParent},denialRecord={...publicRecord,parent:pauseParent,parentDigest:p.authorityDigest(pauseParent),checkpoint:checkpoint(pausedHead),pending}
  await storage.atomic("standing.json",denialRecord);const denialBytes=await readFile(publicFile)
  const epochDenial=await call(restored,"recheck",{kind:"epoch-denial",sessionID:session.id,operationID});assert.equal(epochDenial.readSideEpochDenial,true,JSON.stringify(epochDenial))
  assert.deepEqual(await readFile(publicFile),denialBytes);assert.deepEqual(JSON.parse(denialBytes).pending,JSON.parse(protectedBytes).pending);assert.deepEqual(await fingerprints(),sourceInputs)
  const receipt={nativeVersion:service.info.version,cliSha256:hash(await readFile(copy)),privateRoot:root,seed,beforeTear,afterTear,rollback,epochDenial,
    lowerValidDatabaseSnapshotSha256:hash(await readFile(snapshot)),protectedRecordSha256:hash(protectedBytes),explicitHumanDenialRecordSha256:hash(denialBytes),sourceInputs,
    fixturePluginSha256:hash(await readFile(entry)),fixturePluginBundleSha256:hash(await readFile(path.join(plugin,"index.mjs"))),
    fixtureFamilyReaderBundleSha256:hash(await readFile(familyReader)),
    privateKeysExported:false,signingDuringNativePassage:false,backendAttached:false,
    primitiveGaps:["ProtectedAuthorityFiles.cas requires secret-bearing one-shot HostDocument, not public recurrence reservation/checkpoint",
      "HostStorage.atomic is not a current protected-record CAS spanning native commit; no pending accept/park contract",
      "FamilyAuthorityClaim.assertCurrent is async, not a native final synchronous literal-true ownership fence",
      "Existing host signer qualification depends on backend/private bridge; it is not native signer provenance"],
    nativeHumanAdmissionImplemented:false,authoritativeCrossResourceCASQualified:false,arbitraryWriterExclusion:false,powerLossDurabilityQualified:false,productionActivated:false}
  await writeFile(path.join(root,"results.json"),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt))
}finally{clearTimeout(watchdog);for(const {child}of children)if(child.exitCode===null)child.kill();await Promise.all(children.map(({closed})=>closed));
  for(const name of Object.keys(process.env))if(!(name in original))delete process.env[name];Object.assign(process.env,original)}
