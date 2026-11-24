// Isolated real Rust backend + synthetic OpenCode storage/events + loopback fault proxy.
import assert from 'node:assert/strict'
import {createServer,request} from 'node:http'
import {spawnFixtureChild as spawn} from '../../../scripts/native-fixture-guards.mjs'
import {mkdir,writeFile} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import path from 'node:path'
import {FixtureStore} from './fixture-store.mjs'
import {textStream} from './fixture-response.mjs'
import {privateEnvironment} from './private-profile.mjs'
import {requireTestSupport,clientBinary,serverBinary} from './fixture-binaries.mjs'
requireTestSupport()
const suspend=process.argv.includes('--suspend')
const here=path.resolve(import.meta.dirname,'..')
const profile=path.join(here,'fixture-profile',`recovery-${randomUUID()}`)
const project=path.join(profile,'projects','synthetic')
await mkdir(project,{recursive:true})
const session='ses_recovery_synthetic'
const store=new FixtureStore(600)
if(suspend)store.rows[410].content.push({type:'tool',id:'reveal',name:'read',state:{
  status:'completed',input:{filePath:'reveal.txt'},output:'Output retained after eviction',
}})
const nativeStreams=new Set(),proxyStreams=new Set()
const stats={pages:0,latestReads:0,prompts:0,transportConnections:0,nativeConnections:0,blockedPages:0,stalePages:0}
let blockOlder=false,staleOlder=false,holdWindow=false,hiddenPermission=false,recoveredPermission=false,afterCutsPermission=false,hiddenQuestion=false,liveRow,liveText,busy=0,idle=1
const permission={id:'permission-suspended',sessionID:session,action:'read',resources:['synthetic.txt'],message:'Permission sent while hidden'}
const form={id:'form-suspended',sessionID:session,title:'Question received while hidden',fields:[{key:'hidden-answer',type:'string'}]}
if(suspend)Object.assign(stats,{heldReadStarted:0,heldReadCancelled:0,aroundReads:0,gapPermissionReads:0})
const record=()=>({id:session,projectID:'global',location:{directory:project},time:{created:1,busy,idle}})
const emit=(type,data)=>{
  const event={id:randomUUID(),type,created:Date.now(),location:{directory:project},data:{sessionID:session,...data}}
  for(const stream of nativeStreams)stream.write(`data: ${JSON.stringify(event)}\n\n`)
}
function cutTransport(){for(const item of proxyStreams){item.res.destroy();item.up.destroy()}}
const native=createServer(async(req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1')
  assert.equal(req.headers.authorization,`Basic ${Buffer.from('opencode:fixture-native').toString('base64')}`)
  let raw='';for await(const chunk of req){raw+=chunk;assert(raw.length<262144)}
  const json=value=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(value))}
  if(url.pathname==='/api/event'){
    stats.nativeConnections++
    res.writeHead(200,{'content-type':'text/event-stream'})
    res.write(`data: ${JSON.stringify({id:randomUUID(),type:'server.connected',created:Date.now(),data:{}})}\n\n`)
    nativeStreams.add(res);res.on('close',()=>nativeStreams.delete(res));return
  }
  if(url.pathname==='/api/location')return json({data:{directory:project}})
  if(url.pathname===`/api/session/${session}`)return json({data:record()})
  if(suspend&&url.pathname===`/api/session/${session}/permission`){
    if(recoveredPermission&&stats.nativeConnections>=2)stats.gapPermissionReads++
    return json({data:[...(hiddenPermission?[permission]:[]),...(recoveredPermission?[{...permission,id:'permission-during-gap'}]:[]),
      ...(afterCutsPermission?[{...permission,id:'permission-after-reopens'}]:[])]})
  }
  if(suspend&&url.pathname===`/api/session/${session}/form`)return json({data:hiddenQuestion?[form]:[]})
  if(suspend&&url.pathname==='/api/model')return json({data:[]})
  if(url.pathname==='/api/plugin')return json({location:{directory:project},data:[{id:'codenomad-session-pruning',state:{status:'active'}}]})
  if(['/api/rpc/codenomad.session-pruning/window','/api/rpc/codenomad.session-pruning/windowUserFilesV1'].includes(url.pathname)){
    const {input}=JSON.parse(raw);assert.equal(input.sessionID,session)
    stats.pages++;if(input.target.kind==='latest')stats.latestReads++
    if(suspend&&input.target.kind==='around'){stats.aroundReads++;stats.resumedAnchor=input.target.messageID}
    if(input.target.kind==='before'&&blockOlder){blockOlder=false;stats.blockedPages++;return json({output:{status:'blocked',reason:'anchor_missing'}})}
    const snapshot=store.window(input.target)
    if(url.pathname.endsWith('windowUserFilesV1')&&snapshot.status==='window')snapshot.userFiles='reference-v1'
    if(input.target.kind==='before'&&staleOlder){
      staleOlder=false;stats.stalePages++
      store.rows[250].content[0].text='edited during stale page\nété 🦀\nthird line'
      cutTransport();await new Promise(r=>setTimeout(r,250))
    }
    return json({output:snapshot})
  }
  if(url.pathname==='/api/rpc/codenomad.missions/scheduleCarrierRead')return json({output:{owned:false}})
  if(url.pathname===`/api/session/${session}/environment`)return json({data:{}})
  if(url.pathname===`/api/session/${session}/prompt`){
    assert.equal(req.method,'POST');assert.equal(JSON.parse(raw).text,'Recovery synthetic prompt')
    stats.prompts++;busy=Date.now();store.append('user',JSON.parse(raw).text)
    liveRow=store.append('assistant','',false)
    emit('session.step.started',{assistantMessageID:liveRow.id,agent:'fixture',model:{providerID:'fixture',id:'fixture'}})
    liveText=textStream(liveRow,emit);liveText.append('début')
    return json({data:{id:'inbox-recovery'}})
  }
  res.statusCode=404;return json({_tag:'RpcError',type:'rpc.method_not_found',message:'Synthetic method unavailable'})
})
await new Promise(r=>native.listen(0,'127.0.0.1',r))
const env={...await privateEnvironment(profile),CNRS_SERVER_PASSWORD:'fixture-backend',CNRS_FIXTURE_URL:`http://127.0.0.1:${native.address().port}/`,
  CNRS_FIXTURE_PASSWORD:'fixture-native',CNRS_FIXTURE_STDIN_STOP:'1',GIT_CEILING_DIRECTORIES:profile,CODENOMAD_REMOTE_CONTROL:'disabled'}
const server=spawn(serverBinary,
  [path.dirname(project),path.join(profile,'identity.json'),'0','synthetic-only'],{cwd:profile,env,windowsHide:true,stdio:['pipe','pipe','pipe']})
let log='',child,proxy
server.stdout.on('data',d=>log+=d);server.stderr.on('data',d=>log+=d)
let result=1
try{
  let origin
  for(const end=Date.now()+20000;!origin;){
    assert(Date.now()<end&&server.exitCode===null,'Rust startup')
    origin=log.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];if(!origin)await new Promise(r=>setTimeout(r,100))
  }
  proxy=createServer(async(req,res)=>{
    if(req.url.startsWith('/__test__/')){
      const action=req.url.slice('/__test__/'.length)
      if(action==='block-older')blockOlder=true
      if(action==='hold-window')holdWindow=true
      if(action==='permission-while-hidden'){
        hiddenPermission=true
        emit('permission.asked',{permissionID:permission.id,action:permission.action,resources:permission.resources})
      }
      if(action==='question-while-hidden'){
        hiddenQuestion=true
        emit('form.created',{form})
      }
      if(action==='permission-during-gap'){
        for(const stream of nativeStreams)stream.destroy()
        recoveredPermission=true
      }
      if(action==='cut-observer')cutTransport()
      if(action==='step-while-hidden'){
        busy=Date.now()
        emit('session.step.started',{assistantMessageID:'message-00600',agent:'fixture',model:{providerID:'fixture',id:'fixture'}})
      }
      if(action==='finish-hidden-step'){
        idle=Date.now()+1
        emit('session.execution.succeeded',{})
      }
      if(action==='permission-after-reopens'){
        afterCutsPermission=true
        emit('permission.asked',{permissionID:'permission-after-reopens',action:permission.action,resources:permission.resources})
      }
      if(action==='stale-older')staleOlder=true
      if(action==='revert-in-history'){
        store.rows[598].content[0].text='authoritative after revert'
        emit('session.revert.committed',{to:'message-00599'})
      }
      if(action==='transport-cut'){
        cutTransport()
        liveText.append(' · milieu 🦀 · fin');liveText.close();liveRow.time.completed=Date.now();idle=Date.now()
        store.append('user','missed question');store.append('assistant','missed answer')
        emit('session.execution.succeeded',{})
      }
      if(action==='replay'){
        emit('session.step.started',{assistantMessageID:liveRow.id,agent:'fixture',model:{providerID:'fixture',id:'fixture'}})
        emit('session.text.delta',{assistantMessageID:liveRow.id,ordinal:0,delta:' · milieu 🦀 · fin'})
        emit('session.text.delta',{assistantMessageID:liveRow.id,ordinal:0,delta:' · milieu 🦀 · fin'})
      }
      if(action==='upstream-cut'){
        store.rows[410].content[0].text='changed across upstream generation\nsecond line\nthird line'
        store.append('user','upstream gap question');store.append('assistant','upstream gap answer')
        for(const stream of nativeStreams)stream.destroy()
      }
      if(action==='remove-anchor'){store.rows.splice(400,1);cutTransport()}
      res.setHeader('content-type','application/json')
      res.end(JSON.stringify(action==='expected'?store.rows.map(row=>({id:row.id,body:row.type==='user'?row.text:row.content.map(p=>p.text).join('\n')})):stats));return
    }
    if(holdWindow&&req.url.includes('/session-history/window')){
      holdWindow=false
      stats.heldReadStarted++
      res.on('close',()=>{if(!res.writableEnded)stats.heldReadCancelled++})
      res.writeHead(200,{'content-type':'application/json'})
      res.write('{"status":')
      req.resume()
      return
    }
    const target=new URL(req.url,origin)
    const up=request(target,{method:req.method,headers:{...req.headers,host:target.host}},response=>{
      res.writeHead(response.statusCode,response.headers);response.pipe(res)
    })
    if(req.url.startsWith('/api/events?')){
      stats.transportConnections++;const item={res,up};proxyStreams.add(item)
      res.on('close',()=>{proxyStreams.delete(item);up.destroy()})
    }
    up.on('error',()=>{if(!res.headersSent)res.writeHead(503);res.end()})
    req.pipe(up)
  })
  await new Promise(r=>proxy.listen(0,'127.0.0.1',r))
  const base=`http://127.0.0.1:${proxy.address().port}`
  const login=await fetch(`${base}/api/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'codenomad',password:'fixture-backend'})})
  assert.equal(login.status,200)
  const cookie=login.headers.get('set-cookie').split(';')[0]
  const opened=await fetch(`${base}/api/workspaces`,{method:'POST',headers:{'content-type':'application/json',cookie},body:JSON.stringify({path:project})})
  const workspace=await opened.json();assert.equal(opened.status,201)
  for(const end=Date.now()+10000;nativeStreams.size===0;){assert(Date.now()<end);await new Promise(r=>setTimeout(r,25))}
  child=spawn(clientBinary,[suspend?'--probe-suspend':'--probe-recovery'],{cwd:profile,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...env,
    RUNE_BACKEND:`${base}/`,RUNE_WORKSPACE:workspace.id,RUNE_SESSION:session,RUNE_PASSWORD:'fixture-backend',RUNE_LOCALE:'fr',RUNE_TEST_CONTROL:`${base}/__test__/`}})
  let clientLog=''
  child.stdout.on('data',chunk=>clientLog+=chunk)
  child.stderr.on('data',chunk=>clientLog+=chunk)
  result=await new Promise((resolve,reject)=>{child.on('close',resolve);child.on('error',reject)})
  await writeFile(path.join(profile,'client.log'),clientLog)
  console.log(clientLog)
  assert.equal(result,0,'Headless Rune recovery probe')
  if(suspend){
    assert.equal(stats.heldReadStarted,1);assert.equal(stats.heldReadCancelled,1)
    assert.equal(stats.aroundReads,1);assert.equal(stats.prompts,0)
    assert.equal(stats.transportConnections,8)
    assert(stats.nativeConnections>=2)
  }else{
    assert.equal(stats.blockedPages,1);assert.equal(stats.stalePages,1)
    assert(stats.transportConnections>=4);assert(stats.nativeConnections>=2)
  }
  console.log(JSON.stringify({fixture:'real-rust-recovery-synthetic-opencode',result:'ok',stats}))
}finally{
  console.log(JSON.stringify({type:'recovery-fixture-stats',...stats}))
  if(child?.exitCode===null)child.kill()
  for(const item of proxyStreams){item.res.destroy();item.up.destroy()}
  proxy?.closeAllConnections();proxy?.close()
  server.stdin.write('shutdown\n')
  await Promise.race([new Promise(r=>server.on('exit',r)),new Promise(r=>setTimeout(r,5000))])
  if(server.exitCode===null)server.kill()
  for(const stream of nativeStreams)stream.destroy()
  native.closeAllConnections();native.close()
  await writeFile(path.join(profile,'server.log'),log)
}
process.exitCode=result??1
