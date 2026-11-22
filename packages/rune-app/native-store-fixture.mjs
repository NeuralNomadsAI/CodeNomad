// Native stored history and Rune workspace restoration; every process and Location is private.
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {randomUUID,createHash} from 'node:crypto'
import {mkdir,copyFile,readFile,writeFile} from 'node:fs/promises'
import {createServer,request} from 'node:http'
import path from 'node:path'
import {parseArgs} from 'node:util'
import {OpenCode} from '@opencode/client'
import {privateEnvironment} from './private-profile.mjs'
import {clientBinary,serverBinary,requireTestSupport} from './fixture-binaries.mjs'
import {preparePruning} from '../../scripts/perf/pruning.mjs'
import {privatePath} from '../../scripts/perf/isolation.mjs'
import {stopFixtureChild} from '../../scripts/native-fixture-guards.mjs'

const {values}=parseArgs({options:{opencode:{type:'string'}}})
assert(values.opencode&&path.isAbsolute(values.opencode),'--opencode requires an absolute private-runtime executable')
const repository=path.resolve(import.meta.dirname,'../..')
const root=privatePath(path.join(repository,'scripts/perf/run',`trial-rune-store-${randomUUID()}`))
await mkdir(root,{recursive:true})
const project=path.join(root,'project'),config=path.join(root,'opencode-config')
await mkdir(project);await mkdir(config)
const suffix=process.platform==='win32'?'.exe':''
const rune=path.join(root,`rune${suffix}`),rust=path.join(root,`codenomad-rs${suffix}`)
await copyFile(clientBinary,rune);await copyFile(serverBinary,rust)
requireTestSupport(rune)
const permissions=[{action:'*',resource:'*',effect:'deny'}]
const env={...await privateEnvironment(root),OPENCODE_TEST_HOME:path.join(root,'home'),
  OPENCODE_CONFIG_DIR:config,OPENCODE_DB:path.join(root,'opencode.db'),
  OPENCODE_CONFIG_PROJECT_DISABLE:'1',OPENCODE_DISABLE_MODELS_FETCH:'1',OPENCODE_DISABLE_FFF:'1',
  OPENCODE_SERVER_PASSWORD:randomUUID(),OPENCODE_CONFIG_CONTENT:'{}',
  ProgramData:path.join(root,'ProgramData'),npm_config_userconfig:path.join(root,'npmrc'),
  npm_config_globalconfig:path.join(root,'global-npmrc'),npm_config_cache:path.join(root,'npm-cache')}
await mkdir(env.ProgramData)
const logs={},children=[],proxies=[],ownedIDs=[],stages=[],requests=[]
const proof={root,project,opencode:values.opencode,ownedIDs,stages,requests,cleanup:[],result:'failed',
  binaries:{rune:createHash('sha256').update(await readFile(rune)).digest('hex'),rust:createHash('sha256').update(await readFile(rust)).digest('hex')}}
let pruning,native,server,client,failure,rustPassword
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
function launch(name,binary,args,childEnv){
  const child=spawn(binary,args,{cwd:root,env:childEnv,windowsHide:true,stdio:['pipe','pipe','pipe']})
  const entry={name,child,error:null,stopped:null};logs[name]=''
  entry.stopped=new Promise(resolve=>{child.once('close',resolve);child.once('error',error=>{entry.error=error;resolve()})})
  for(const pipe of [child.stdout,child.stderr])pipe.on('data',data=>{logs[name]=(logs[name]+data).slice(-1048576)})
  children.push(entry);return entry
}
async function origin(entry){
  for(const end=Date.now()+60000;;){
    if(entry.error)throw entry.error
    assert(entry.child.exitCode===null&&entry.child.signalCode===null&&Date.now()<end,`${entry.name} startup failed`)
    const url=logs[entry.name].match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]
    if(url)return url
    await sleep(25)
  }
}
const forbidden=route=>/(?:^|\/)(?:prompt|command|generate|synthetic|shell)(?:\/|$)/.test(route)
async function auditedProxy(base,lane){
  const proxy=createServer((req,res)=>{
    const url=new URL(req.url,base),row={lane,stage:proof.stage??'setup',method:req.method,path:url.pathname,query:url.search}
    requests.push(row)
    const createsNative=req.method==='POST'&&/^\/api\/session\/?$/.test(url.pathname)
    const createsViaApp=req.method==='POST'&&/^\/workspaces\/[^/]+\/instance\/api\/session\/?$/.test(url.pathname)
    if(req.method==='POST'&&(forbidden(url.pathname)||createsNative||createsViaApp)){
      row.blocked=true;res.writeHead(403);res.end('Fixture mutation denied');return
    }
    const upstream=request(url,{method:req.method,headers:{...req.headers,host:url.host}},response=>{
      row.status=response.statusCode;res.writeHead(response.statusCode,response.headers);response.pipe(res)
    })
    upstream.on('error',()=>{row.failed=true;if(!res.headersSent)res.writeHead(502);res.end()})
    req.on('aborted',()=>upstream.destroy());res.on('close',()=>upstream.destroy());req.pipe(upstream)
  })
  await new Promise((resolve,reject)=>{proxy.once('error',reject);proxy.listen(0,'127.0.0.1',resolve)})
  proxies.push(proxy);return `http://127.0.0.1:${proxy.address().port}`
}
async function assertExport(id,messages){
  const stored=await native.experimental.session.export({sessionID:id})
  assert.equal(stored.info.location.directory,project)
  assert.deepEqual(stored.info.permissions,permissions)
  assert.deepEqual(stored.messages.map(m=>({id:m.id,type:m.type,text:m.text})),messages.map(m=>({id:m.id,type:m.type,text:m.text})))
  return stored
}
try{
  pruning=await preparePruning(root,config)
  const daemon=launch('opencode',values.opencode,['serve','--hostname','127.0.0.1','--port','0','--print-logs'],env)
  const endpoint=await origin(daemon)
  const authorization=`Basic ${Buffer.from(`opencode:${env.OPENCODE_SERVER_PASSWORD}`).toString('base64')}`
  native=OpenCode.make({baseUrl:endpoint,headers:{authorization},fetch:(url,init)=>fetch(url,{...init,
    signal:AbortSignal.any([...(init?.signal?[init.signal]:[]),AbortSignal.timeout(30000)])})})
  const info=await native.server.info();assert.equal(info.pid,daemon.child.pid)
  proof.nativeVersion=info.version
  await pruning.activate({project,url:endpoint,authorization},()=>assert.equal(daemon.child.exitCode,null))
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
  const nativeProxy=await auditedProxy(endpoint,'rust-native')
  rustPassword=randomUUID()
  const rustEnv={...env,CNRS_FIXTURE_URL:nativeProxy,CNRS_FIXTURE_PASSWORD:env.OPENCODE_SERVER_PASSWORD,
    CNRS_SERVER_PASSWORD:rustPassword,CNRS_FIXTURE_STDIN_STOP:'1',CLI_CONFIG:path.join(root,'rust-config')}
  await mkdir(rustEnv.CLI_CONFIG)
  server=launch('rust',rust,[project,path.join(root,'identity.json'),'0',values.opencode],rustEnv)
  const backend=await origin(server),appProxy=await auditedProxy(backend,'rune-rust')
  const login=await fetch(`${backend}/api/auth/login`,{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({username:'codenomad',password:rustEnv.CNRS_SERVER_PASSWORD}),signal:AbortSignal.timeout(15000)})
  assert.equal(login.status,200)
  const cookie=login.headers.get('set-cookie')?.split(';')[0];assert(cookie)
  const inventory=async()=>{
    const response=await fetch(`${backend}/api/workspaces`,{headers:{cookie},signal:AbortSignal.timeout(15000)})
    assert.equal(response.status,200);return response.json()
  }
  for(const stage of ['prepare','resume','verify']){
    proof.stage=stage
    client=launch(`rune-${stage}`,rune,['--probe-native-store'],{...env,RUNE_BACKEND:`${appProxy}/`,RUNE_PASSWORD:rustEnv.CNRS_SERVER_PASSWORD,
      RUNE_TEST_FOLDER:project,RUNE_LOCALE:'fr',RUNE_STATE_DIR:path.join(root,'rune-state'),RUNE_TEST_RESTORE_STAGE:stage,
      RUNE_STORE_LONG_SESSION:long.id,RUNE_STORE_EMPTY_SESSION:empty.id,RUNE_STORE_SEED_FILE:seedFile})
    let timeout
    try{await Promise.race([client.stopped,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error(`Rune ${stage} exceeded 120s`)),120000)})])}
    finally{clearTimeout(timeout)}
    if(client.error)throw client.error
    assert.equal(client.child.exitCode,0,`Rune ${stage} failed; inspect rune-${stage}.log`)
    const receipts=logs[client.name].split(/\r?\n/).flatMap(line=>{try{return [JSON.parse(line)]}catch{return []}})
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
}catch(error){failure=error;proof.error=error.message}
finally{
  const errors=[]
  if(client&&client.child.exitCode===null&&client.child.signalCode===null)try{await stopFixtureChild(client.child,client.stopped)}catch(error){errors.push(error)}
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
  try{await pruning?.close()}catch(error){errors.push(error)}
  for(const entry of children.slice().reverse())if(entry.child.exitCode===null&&entry.child.signalCode===null)
    try{await stopFixtureChild(entry.child,entry.stopped)}catch(error){errors.push(error)}
  for(const proxy of proxies){proxy.closeAllConnections();await new Promise(resolve=>proxy.close(resolve))}
  const secrets=[env.OPENCODE_SERVER_PASSWORD,rustPassword].filter(Boolean)
  for(const [name,log]of Object.entries(logs))await writeFile(path.join(root,`${name}.log`),secrets.reduce((text,secret)=>text.replaceAll(secret,'<fixture password>'),log))
  if(errors.length){proof.result='failed';proof.cleanupErrors=errors.map(error=>error.message);failure??=new AggregateError(errors,'Owned fixture cleanup failed')}
  proof.children=children.map(({name,child})=>({name,pid:child.pid,exitCode:child.exitCode,signal:child.signalCode}))
  await writeFile(path.join(root,'proof.json'),JSON.stringify(proof,null,2)+'\n')
}
console.log(JSON.stringify({type:'native-store-fixture',result:proof.result,root,stages:stages.map(s=>s.stage),rows:600,ownedSessions:ownedIDs.length}))
if(failure)throw failure
