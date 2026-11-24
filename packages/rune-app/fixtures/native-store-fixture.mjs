// Native stored history and Rune workspace restoration; every process and Location is private.
import assert from 'node:assert/strict'
import {randomUUID,createHash} from 'node:crypto'
import {mkdir,copyFile,readFile,writeFile} from 'node:fs/promises'
import path from 'node:path'
import {parseArgs} from 'node:util'
import {privateEnvironment} from './private-profile.mjs'
import {clientBinary,serverBinary,requireTestSupport} from './fixture-binaries.mjs'
import {preparePruning} from '../../../scripts/perf/pruning.mjs'
import {privatePath} from '../../../scripts/perf/isolation.mjs'
import {fixtureChildPid,spawnFixtureChild,stopFixtureChild} from '../../../scripts/native-fixture-guards.mjs'
import {assertNoSystemOpenCodeConfig,attestNative,ensurePrivateGitRepo} from './live-access.mjs'
import {createAttestedFetch,createAttestedRelay,createStreamRedactor,fixtureFetch,redactSecrets,RELAY_PLACEHOLDER_PASSWORD,resolveLocalExecutable,resolveWorktreePackage,withoutFixtureProxy} from '../../../scripts/native-fixture-http.mjs'
import {onFixtureSignal,registerFixtureChild,rustOrigin} from './fixture-host.mjs'

const {OpenCode}=await import(resolveWorktreePackage('@opencode/client'))
const {values}=parseArgs({options:{opencode:{type:'string'}}})
const opencodeExecutable=resolveLocalExecutable(values.opencode,'OpenCode binary')
await assertNoSystemOpenCodeConfig()
const repository=path.resolve(import.meta.dirname,'../../..')
const root=privatePath(path.join(repository,'scripts/perf/run',`trial-rune-store-${randomUUID()}`))
await mkdir(root,{recursive:true})
const project=path.join(root,'project'),config=path.join(root,'opencode-config')
await mkdir(project);await mkdir(config)
const suffix=process.platform==='win32'?'.exe':''
const rune=path.join(root,`rune${suffix}`),rust=path.join(root,`codenomad-rs${suffix}`)
await copyFile(resolveLocalExecutable(clientBinary,'Rune client binary'),rune)
await copyFile(resolveLocalExecutable(serverBinary,'Rust server binary'),rust)
requireTestSupport(rune)
const permissions=[{action:'*',resource:'*',effect:'deny'}]
const opencodePassword=randomUUID()
const opencodeAuthorization=`Basic ${Buffer.from(`opencode:${opencodePassword}`).toString('base64')}`
const baseEnv={...await privateEnvironment(root),OPENCODE_TEST_HOME:path.join(root,'home'),
  OPENCODE_CONFIG_DIR:config,OPENCODE_DB:path.join(root,'opencode.db'),
  OPENCODE_CONFIG_PROJECT_DISABLE:'1',OPENCODE_DISABLE_PROJECT_CONFIG:'1',OPENCODE_DISABLE_MODELS_FETCH:'1',OPENCODE_DISABLE_FFF:'1',OPENCODE_DISABLE_AUTOUPDATE:'true',
  OPENCODE_CONFIG_CONTENT:'{}',
  GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:path.join(root,'empty.gitconfig'),GIT_TEMPLATE_DIR:'',GIT_CEILING_DIRECTORIES:root,
  ProgramData:path.join(root,'ProgramData'),npm_config_userconfig:path.join(root,'npmrc'),
  npm_config_globalconfig:path.join(root,'global-npmrc'),npm_config_cache:path.join(root,'npm-cache')}
const opencodeEnv={...baseEnv,OPENCODE_SERVER_PASSWORD:opencodePassword}
await mkdir(baseEnv.ProgramData)
const logs={},stdouts={},children=[],proxies=[],ownedIDs=[],stages=[],requests=[]
const proof={root,project,opencode:values.opencode,ownedIDs,stages,requests,cleanup:[],result:'failed',
  binaries:{rune:createHash('sha256').update(await readFile(rune)).digest('hex'),rust:createHash('sha256').update(await readFile(rust)).digest('hex')}}
let pruning,native,server,client,failure,rustPassword,attested,rustFetch
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
const group=process.platform!=='win32'
function launch(name,binary,args,childEnv,cwd=root,redact=[]){
  const child=spawnFixtureChild(binary,args,{cwd,env:withoutFixtureProxy(childEnv),detached:group,windowsHide:true,stdio:['pipe','pipe','pipe']})
  const outRedactor=createStreamRedactor(redact)
  const errRedactor=createStreamRedactor(redact)
  const appendOut=chunk=>{if(chunk){stdouts[name]=(stdouts[name]+chunk).slice(-1048576);logs[name]=(logs[name]+chunk).slice(-1048576)}}
  const appendErr=chunk=>{if(chunk)logs[name]=(logs[name]+chunk).slice(-1048576)}
  const entry={name,child,error:null,stopped:null,startedBy:new Date(),currentStdout:()=>stdouts[name]+outRedactor.peek(),currentOutput:()=>logs[name]+outRedactor.peek()+errRedactor.peek()};logs[name]='';stdouts[name]=''
  entry.stopped=new Promise(resolve=>{
    child.once('close',code=>{appendOut(outRedactor.flush());appendErr(errRedactor.flush());resolve(code)})
    child.once('error',error=>{entry.error=error;resolve()})
  })
  const untrack=registerFixtureChild(()=>stopFixtureChild(child,entry.stopped,1_000,2_000,{group,startedBy:entry.startedBy}))
  void entry.stopped.finally(untrack)
  child.stdout.on('data',data=>{appendOut(outRedactor.push(data))})
  child.stderr.on('data',data=>{appendErr(errRedactor.push(data))})
  children.push(entry);return entry
}
async function origin(entry){
  for(const end=Date.now()+60000;;){
    if(entry.error)throw entry.error
    assert(entry.child.exitCode===null&&entry.child.signalCode===null&&Date.now()<end,`${entry.name} startup failed`)
    const output=entry.currentStdout()
    const url=entry.name==='opencode'?output.match(/^server listening on (http:\/\/127\.0\.0\.1:\d+)\/?\r?\n/m)?.[1]:rustOrigin(output)
    if(url)return url
    await sleep(25)
  }
}
const forbidden=route=>/(?:^|\/)(?:prompt|command|generate|synthetic|shell)(?:\/|$)/i.test(route)
const createsSession=route=>/(?:^|\/)(?:experimental\/)?session(?:\/(?:import|[^/]+\/fork))?\/?$/i.test(route)
async function auditedProxy(base,lane,targetPid,{requireClientAttestation=false,injectAuthorization}={}){
  const relay=await createAttestedRelay(base,targetPid,{
    requireClientAttestation,
    injectAuthorization,
    onRequest(req,res,url){
      const row={lane,stage:proof.stage??'setup',method:req.method,path:url.pathname,query:url.search}
      requests.push(row)
      let decoded=null
      try{decoded=decodeURIComponent(url.pathname)}catch{}
      if(req.method==='POST'&&(decoded===null||forbidden(url.pathname)||forbidden(decoded)||createsSession(url.pathname)||createsSession(decoded))){
        row.blocked=true;res.writeHead(403);res.end('Fixture mutation denied');return false
      }
      res.once('finish',()=>{row.status=res.statusCode})
    },
  })
  proxies.push(relay);return relay
}
async function assertExport(id,messages){
  const stored=await native.experimental.session.export({sessionID:id})
  assert.equal(stored.info.location.directory,project)
  assert.deepEqual(stored.info.permissions,permissions)
  assert.deepEqual(stored.messages.map(m=>({id:m.id,type:m.type,text:m.text})),messages.map(m=>({id:m.id,type:m.type,text:m.text})))
  return stored
}
const untrackSignalCleanup=onFixtureSignal(async()=>{
  const cleanupSignal=AbortSignal.timeout(5000)
  if(native)for(const sessionID of ownedIDs.splice(0).reverse()){
    try{await native.session.remove({sessionID},{signal:cleanupSignal});proof.cleanup.push({sessionID,removed:true})}
    catch{proof.cleanup.push({sessionID,removed:false})}
  }
},undefined,{beforeChildren:true})
try{
  await ensurePrivateGitRepo(project,root,baseEnv)
  pruning=await preparePruning(root,config,baseEnv)
  const daemon=launch('opencode',opencodeExecutable,['serve','--hostname','127.0.0.1','--port','0','--print-logs'],opencodeEnv,project,[opencodePassword])
  const endpoint=await origin(daemon)
  const opencodePid=await fixtureChildPid(daemon.child)
  attested=await attestNative(endpoint,daemon.child,opencodeAuthorization,fixtureFetch,opencodePid)
  const {send}=attested
  native=OpenCode.make({baseUrl:endpoint,fetch:(url,init)=>send(new Request(url,init))})
  const info=await native.server.info()
  proof.nativeVersion=info.version
  await pruning.activate({project,url:endpoint,authorization:opencodeAuthorization,send},()=>assert.equal(daemon.child.exitCode,null))
  const create=async title=>{
    const session=await native.session.create({title,location:{directory:project},permissions})
    ownedIDs.push(session.id);assert.equal(session.location.directory,project);assert.deepEqual(session.permissions,permissions)
    return session
  }
  const template=await create('Rune import envelope')
  const exported=await native.experimental.session.export({sessionID:template.id})
  assert.equal(exported.messages.length,0)
  const now=Date.now(),prefix=randomUUID().replaceAll('-','').slice(0,18)
  const messages=Array.from({length:600},(_,i)=>({id:`msg_${prefix}${i.toString(16).padStart(8,'0')}`,type:'user',
    time:{created:now-60000+i},text:`Archive de test ${String(i).padStart(4,'0')}\nDonnée factice sans action à effectuer.`}))
  const importedID=`ses_${randomUUID().replaceAll('-','').slice(0,26)}`
  // Record the intended import identity before mutation, so ambiguous receipts retain exact cleanup rights.
  ownedIDs.push(importedID)
  const long=await native.experimental.session.import({info:{...exported.info,id:importedID,title:'Rune native stored-history test',
    permissions,time:{...exported.info.time,idle:now}},messages,location:{directory:project}})
  assert.equal(long.id,importedID);await assertExport(long.id,messages)
  await pruning.window(long.id)
  const empty=await create('Rune native empty-session test')
  for(let i=0;i<201;i++)await create(`Rune newer empty session ${String(i).padStart(3,'0')}`)
  const first=await native.session.list({directory:project,limit:200})
  assert.equal(first.data.length,200);assert(!first.data.some(s=>s.id===long.id),'Saved long session must be outside the actual first page')
  proof.firstPage={count:first.data.length,longAbsent:true,ids:first.data.map(s=>s.id)}
  proof.longSession=long.id;proof.emptySession=empty.id;proof.seedIDs=messages.map(m=>m.id)
  const seedFile=path.join(root,'seed.json')
  await writeFile(seedFile,JSON.stringify(messages.map(({id,text})=>({id,text})))+'\n')
  const nativeProxy=await auditedProxy(endpoint,'rust-native',opencodePid,{requireClientAttestation:true,injectAuthorization:opencodeAuthorization})
  rustPassword=randomUUID()
  const rustEnv={...baseEnv,CNRS_FIXTURE_URL:nativeProxy.origin,CNRS_FIXTURE_PASSWORD:RELAY_PLACEHOLDER_PASSWORD,
    CNRS_SERVER_PASSWORD:rustPassword,CNRS_FIXTURE_STDIN_STOP:'1',CLI_CONFIG:path.join(root,'rust-config')}
  await mkdir(rustEnv.CLI_CONFIG)
  server=launch('rust',rust,[project,path.join(root,'identity.json'),'0',values.opencode],rustEnv,root,[opencodePassword,rustPassword])
  nativeProxy.allowClientPid(fixtureChildPid(server.child),server.stopped)
  const backend=await origin(server)
  const rustPid=await fixtureChildPid(server.child)
  const appProxy=await auditedProxy(backend,'rune-rust',rustPid,{requireClientAttestation:true})
  rustFetch=createAttestedFetch(backend,Number(new URL(backend).port),rustPid)
  const login=await rustFetch(`${backend}/api/auth/login`,{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({username:'codenomad',password:rustEnv.CNRS_SERVER_PASSWORD}),signal:AbortSignal.timeout(15000)})
  assert.equal(login.status,200)
  const cookie=login.headers.get('set-cookie')?.split(';')[0];assert(cookie)
  const inventory=async()=>{
    const response=await rustFetch(`${backend}/api/workspaces`,{headers:{cookie},signal:AbortSignal.timeout(15000)})
    assert.equal(response.status,200);return response.json()
  }
  for(const stage of ['prepare','resume','verify']){
    proof.stage=stage
    client=launch(`rune-${stage}`,rune,['--probe-native-store'],{...baseEnv,RUNE_BACKEND:`${appProxy.origin}/`,RUNE_PASSWORD:rustEnv.CNRS_SERVER_PASSWORD,
      RUNE_TEST_FOLDER:project,RUNE_LOCALE:'fr',RUNE_STATE_DIR:path.join(root,'rune-state'),RUNE_TEST_RESTORE_STAGE:stage,
      RUNE_STORE_LONG_SESSION:long.id,RUNE_STORE_EMPTY_SESSION:empty.id,RUNE_STORE_SEED_FILE:seedFile},root,[opencodePassword,rustPassword])
    appProxy.allowClientPid(fixtureChildPid(client.child),client.stopped)
    let timeout
    try{await Promise.race([client.stopped,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error(`Rune ${stage} exceeded 120s`)),120000)})])}
    finally{clearTimeout(timeout)}
    if(client.error)throw client.error
    assert.equal(client.child.exitCode,0,`Rune ${stage} failed; inspect rune-${stage}.log`)
    const receipts=stdouts[client.name].split(/\r?\n/).flatMap(line=>{try{return [JSON.parse(line)]}catch{return []}})
      .filter(value=>value.type==='native-store-stage')
    assert.equal(receipts.length,1);assert.equal(receipts[0].stage,stage);stages.push(receipts[0])
    assert.deepEqual(await inventory(),[],'Each Rune boot releases its owned logical records')
    await assertExport(long.id,messages)
  }
  const target=`/instance/api/session/${long.id}`
  proof.targetedReads={}
  for(const stage of ['resume','verify']){
    const reads=requests.filter(r=>r.stage===stage&&r.lane==='rune-rust'&&r.method==='GET'&&r.path.endsWith(target)).length
    proof.targetedReads[stage]=reads
    // Session controls also point-read metadata; those reads share the legitimate route.
    assert(reads>=1,`${stage} must target the saved session outside the first catalogue page`)
    assert(!requests.some(r=>r.stage===stage&&r.lane==='rune-rust'&&/\/instance\/api\/session\/?$/.test(r.path)
      &&new URLSearchParams(r.query).has('cursor')),'Restoration must not traverse historical catalogue cursors')
  }
  assert(!requests.some(r=>r.blocked),'No generation, tool dispatch or native session creation during app restoration')
  proof.result='ok'
}catch(error){failure=error;proof.error=redactSecrets(error?.message??String(error),[opencodePassword,rustPassword])}
finally{
  untrackSignalCleanup()
  const errors=[]
  if(client&&client.child.exitCode===null&&client.child.signalCode===null)try{await stopFixtureChild(client.child,client.stopped,1_000,2_000,{group,startedBy:client.startedBy})}catch(error){errors.push(error)}
  // Keep native alive while exact test-owned session cleanup runs.
  const cleanupSignal=AbortSignal.timeout(30000)
  if(native)for(const sessionID of ownedIDs.slice().reverse()){
    try{await native.session.remove({sessionID},{signal:cleanupSignal});proof.cleanup.push({sessionID,removed:true})}
    catch(error){proof.cleanup.push({sessionID,removed:false});errors.push(error)}
  }
  if(server&&server.child.exitCode===null&&server.child.signalCode===null){
    server.child.stdin.on('error',()=>{});server.child.stdin.end('shutdown\n')
    await Promise.race([server.stopped,sleep(5000)])
    proof.rustGraceful=server.child.exitCode===0
    if(!proof.rustGraceful)errors.push(Error('Owned Rust server did not exit cleanly after shutdown'))
  }
  for(const relay of proxies)await relay.close()
  try{await rustFetch?.close()}catch(error){errors.push(error)}
  try{await attested?.close()}catch(error){errors.push(error)}
  try{await pruning?.close()}catch(error){errors.push(error)}
  for(const entry of children.slice().reverse())if(group||entry.child.exitCode===null&&entry.child.signalCode===null)
    try{await stopFixtureChild(entry.child,entry.stopped,1_000,2_000,{group,startedBy:entry.startedBy})}catch(error){errors.push(error)}
  const secrets=[opencodePassword,rustPassword].filter(Boolean)
  for(const [name,log]of Object.entries(logs))await writeFile(path.join(root,`${name}.log`),redactSecrets(log,secrets))
  if(proof.error)proof.error=redactSecrets(proof.error,secrets)
  if(errors.length){proof.result='failed';proof.cleanupErrors=errors.map(error=>redactSecrets(error.message,secrets));failure??=Error(`Owned fixture cleanup failed: ${proof.cleanupErrors.join('; ')}`)}
  proof.children=await Promise.all(children.map(async ({name,child})=>({name,pid:await fixtureChildPid(child),exitCode:child.exitCode,signal:child.signalCode})))
  await writeFile(path.join(root,'proof.json'),JSON.stringify(proof,null,2)+'\n')
}
console.log(JSON.stringify({type:'native-store-fixture',result:proof.result,root,stages:stages.map(s=>s.stage),rows:600,ownedSessions:ownedIDs.length}))
if(failure)throw Error(redactSecrets(failure.message??String(failure),[opencodePassword,rustPassword]))
