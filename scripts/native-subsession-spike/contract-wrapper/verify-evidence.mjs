import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
const experiment='D:/CodeNomad/.codenomad/worktrees/missions-native-subsessions-20261003'
assert.equal(process.cwd().replaceAll('\\','/').toLowerCase(),experiment.toLowerCase())
const broadRoot=process.argv[2]??'C:/Users/Admin/AppData/Local/Temp/opencode/native-contract-wrapper-HIV7Mc'
const defaultRoot=process.argv[3]??'C:/Users/Admin/AppData/Local/Temp/opencode/native-contract-default-DAhV5u'
const read=async(root,file)=>JSON.parse(await readFile(root+'/'+file,'utf8'))
const broad=await read(broadRoot,'results.json'),defaults=await read(defaultRoot,'results.json')
assert.equal(broad.server.version,'2.0.22');assert.equal(defaults.server.version,'2.0.22')
assert.equal(broad.status,'passed');assert(broad.persistedReload);assert(broad.general.nativeRecursionDeniedByBuiltin)
assert.equal(defaults.status,'passed');assert(defaults.persistedReload??defaults.confirmed.persistedReload)
assert(broad.depth.nativeFieldsPreserved);assert.deepEqual(broad.catalog.originalOptions,broad.catalog.currentOptions)
assert(broad.denial.noChild&&broad.denial.noContractEffect);assert(broad.unadmitted.staleRevision&&broad.unadmitted.dependencyBlocked&&broad.unadmitted.pendingUnchanged)
assert.equal(broad.admissionVsCompletion.businessTaskStatus,'queued');assert(broad.continuation.foreignRejected)
const owners=broad.depth.entries.filter(e=>e.key.startsWith('private-native-contract/v1/owner/private_depth/')).map(e=>e.value).sort((a,b)=>a.depth-b.depth)
assert.deepEqual(owners.map(b=>b.depth),[1,2,3]);assert.equal(owners[1].parentID,owners[0].childID);assert.equal(owners[2].parentID,owners[1].childID)
assert.equal(new Set(broad.siblings.bindings.map(b=>b.callID)).size,2);assert.equal(new Set(broad.siblings.bindings.map(b=>b.childID)).size,2)
const requests=await read(broadRoot,'requests.json'),events=await read(broadRoot,'events.json')
assert.equal(new Set(events.map(e=>e.id)).size,events.length,'Actual native event IDs are unique')
for(const b of [...owners,...broad.siblings.bindings])assert.deepEqual(requests.find(r=>r.sessionID===b.childID&&r.kind==='primary').binding,b)
const rollback='C:/Users/Admin/AppData/Local/Temp/opencode/missions-native-rollback-V0FPSs'
const manifest=await read(rollback,'source-before.json'),mismatches=[]
for(const file of manifest){const actual=createHash('sha256').update(await readFile('D:/CodeNomad/.codenomad/worktrees/tauri-integrated-20261002-1841-b62f/'+file.path)).digest('hex');if(actual!==file.sha256)mismatches.push(file.path)}
assert.equal(manifest.length,2225);assert.deepEqual(mismatches,[],'Entire frozen candidate matches rollback byte hashes')
await mkdir(defaultRoot+'/source',{recursive:true})
const sources={}
for(const file of ['packages/server/src/missions/native-subsession-experiment/contract-wrapper.ts','scripts/native-subsession-spike/contract-wrapper/run.mjs','scripts/native-subsession-spike/contract-wrapper/default-permissions.mjs','scripts/native-subsession-spike/contract-wrapper/probe.mjs','scripts/native-subsession-spike/contract-wrapper/verify-evidence.mjs','dev-docs/MISSIONS_NATIVE_WRAPPER_EXPERIMENT.md']){
 const bytes=await readFile(experiment+'/'+file);sources[file]=createHash('sha256').update(bytes).digest('hex');await writeFile(defaultRoot+'/source/'+file.split('/').at(-1),bytes)
}
assert.equal(sources['packages/server/src/missions/native-subsession-experiment/contract-wrapper.ts'],defaults.sources['packages/server/src/missions/native-subsession-experiment/contract-wrapper.ts'],'Latest native passing proof used current implementation')
const result={status:'bounded-foreground-capabilities-qualified',broadFixtureStatus:broad.status,broadFailureRetained:broad.failure,defaultFixtureStatus:defaults.status,
 counts:{broad:broad.counts,defaults:defaults.counts},chain:owners,siblings:broad.siblings.bindings,actualNativeEventIDsUnique:true,
 frozenCandidate:{files:manifest.length,mismatches,rollbackResult:await read(rollback,'RESULT.json')},sources,
 historicalBroadFailure:await read('C:/Users/Admin/AppData/Local/Temp/opencode/native-contract-wrapper-o6U6JH','results.json').then(r=>({status:r.status,failure:r.failure,counts:r.counts})),
 qualification:'Full bounded foreground fixture PASS; not production authority/lifecycle/environment qualification'}
await writeFile(defaultRoot+'/acceptance-audit.json',JSON.stringify(result,null,2));console.log('PASS evidence and all 2225 frozen candidate byte hashes:',defaultRoot+'/acceptance-audit.json')
