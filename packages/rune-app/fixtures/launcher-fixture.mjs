// Real CodeNomad Rust + synthetic OpenCode; no native window or user profile.
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {spawn,execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {mkdir,readFile,writeFile,rename,unlink} from 'node:fs/promises'
import {createHash,randomUUID} from 'node:crypto'
import {chromium,request} from 'playwright'
import path from 'node:path'
import {FixtureStore} from './fixture-store.mjs'
import {responseFor,textStream} from './fixture-response.mjs'
import {privateEnvironment} from './private-profile.mjs'
import {controlsFixture} from './controls-fixture.mjs'
import {pendingOpenFixture} from './pending-open-fixture.mjs'
import {requireTestSupport,clientBinary,serverBinary} from './fixture-binaries.mjs'
import {pairFixture} from '../../../scripts/rune/web-mobile.mjs'
const webMobile=process.argv.includes('--web-mobile')
const webPending=process.argv.includes('--web-pending-open'),webRestore=process.argv.includes('--web-restore')||webPending,web=process.argv.includes('--web')||webRestore||webMobile,root=path.resolve(import.meta.dirname,'../../..')
if(!web)requireTestSupport()
const here=path.resolve(import.meta.dirname,'..'),profile=path.join(web?path.join(root,'target/rune-web-tests'):path.join(here,'fixture-profile'),`launcher-${randomUUID()}`)
const project=path.join(profile,'projects','synthetic');await mkdir(project,{recursive:true})
const forbidden=path.join(profile,'forbidden');if(web)await mkdir(forbidden)
const ui=path.resolve(root,process.env.RUNE_WEB_DIR??'target/rune-web-connected')
const manifest=web?JSON.parse(await readFile(path.join(ui,'bundle-manifest.json'),'utf8')):null
if(web){assert.equal(manifest.generator,'scripts/rune/bundle-web.mjs');assert.equal(manifest.testSupport,false,'Connected qualification requires the default product bundle')}
const gitCount=Number(process.env.RUNE_TEST_GIT_COUNT??0)
if(gitCount)await promisify(execFile)('git',['init','--quiet',project],{windowsHide:true,env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'NUL'}})
const records=new Map(),stores=new Map(),streams=new Set(),requests=[]
const stats={created:0,prompts:0,lists:0}
const uncertain=process.argv.includes('--uncertain-create')
const withTools=process.argv.includes('--with-tools')
const controls=process.argv.includes('--controls')
const workspaceClaims=process.argv.includes('--workspace-claims')
const restoreState=process.argv.includes('--restore-state')
const pendingOpen=process.argv.includes('--pending-open')
const documentState=process.argv.includes('--document-state')
const filesState=process.argv.includes('--files-state')||documentState
assert(!filesState||(!web&&!controls&&!withTools&&!uncertain&&!workspaceClaims&&!restoreState&&!pendingOpen),'Files state uses its own qualification mode')
if(filesState){await mkdir(path.join(project,'src'));await writeFile(path.join(project,'initial.txt'),'initial');await writeFile(path.join(project,'src/initial.ts'),'initial')}
assert(!workspaceClaims||(!web&&!controls&&!withTools&&!uncertain),'Workspace claims use their own qualification mode')
assert(!restoreState||(!web&&!controls&&!withTools&&!uncertain&&!workspaceClaims),'Restore uses its own qualification mode')
const gates=new Map(),visibleProof=[],restoreStages=[],restorePrompts=[]
const filesStages=[],filesExpected=['reader-visible','create','rename','delete','collapsed','hidden','tabbed']
if(documentState)filesExpected.push('document-external','document-cancelled','document-race','document-conflict','document-saved')
const documentDraft='Rune saved · été 🦀\nsecond line',documentExternal='External change · 日本語',documentRace='Changed after confirmation'
const readerTexts=['initial','Reader visible · été 🦀\nsecond version','Reader hidden · 日本語\nthird version','Reader resumed · quatrième\nversion after suspension']
let filesChain=Promise.resolve(),filesProof
async function filesStage(ack) {
  assert.equal(ack.stage,filesExpected[filesStages.length]);filesStages.push(ack)
  switch(ack.stage){
    case 'reader-visible': await writeFile(path.join(project,'src/initial.ts'),readerTexts[1]);break
    case 'create': await writeFile(path.join(project,'new.txt'),'created');await writeFile(path.join(project,'src/nested.ts'),'nested');break
    case 'rename': await rename(path.join(project,'new.txt'),path.join(project,'renamed.txt'));break
    case 'delete': await unlink(path.join(project,'renamed.txt'));await unlink(path.join(project,'src/nested.ts'));break
    case 'collapsed': await writeFile(path.join(project,'src/collapsed.ts'),'collapsed');break
    case 'hidden': await writeFile(path.join(project,'hidden.txt'),'hidden');await writeFile(path.join(project,'src/initial.ts'),readerTexts[2]);break
    case 'tabbed': await writeFile(path.join(project,'tabbed.txt'),'tabbed');await writeFile(path.join(project,'src/initial.ts'),readerTexts[3]);break
    case 'document-external': await writeFile(path.join(project,'src/initial.ts'),documentExternal);break
    case 'document-cancelled': assert.equal(await readFile(path.join(project,'src/initial.ts'),'utf8'),documentExternal);break
    case 'document-race': await writeFile(path.join(project,'src/initial.ts'),documentRace);break
    case 'document-conflict': assert.equal(await readFile(path.join(project,'src/initial.ts'),'utf8'),documentRace);break
    case 'document-saved': assert.equal(await readFile(path.join(project,'src/initial.ts'),'utf8'),documentDraft);break
  }
  client.stdin.write(`${JSON.stringify({stage:ack.stage})}\n`)
}
let clientLog='',clientLines=''
function visibleGate(turn,replyID) {
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{gates.delete(turn);reject(Error(`Missing visible streaming ACK for turn ${turn}`))},10000)
    gates.set(turn,{replyID,resolve:()=>{clearTimeout(timer);gates.delete(turn);resolve()},reject:()=>{clearTimeout(timer);gates.delete(turn);reject(Error('Launcher probe ended before visible streaming ACK'))}})
  })
}
function clientOutput(chunk) {
  clientLog=(clientLog+chunk).slice(-262144);process.stdout.write(chunk)
  clientLines+=chunk
  if(clientLines.length>65536){for(const gate of gates.values())gate.reject();clientLines='';return}
  for(let at;(at=clientLines.indexOf('\n'))>=0;){
    const line=clientLines.slice(0,at);clientLines=clientLines.slice(at+1)
    let ack;try{ack=JSON.parse(line)}catch{continue}
    if(filesState&&ack.type==='files-state-stage'){filesChain=filesChain.then(()=>filesStage(ack));filesChain.catch(error=>{console.error(error);client.kill()});continue}
    if(filesState&&ack.type==='files-state-proof'){filesProof=ack;continue}
    if(restoreState&&ack.type==='window-restore-stage'){restoreStages.push(ack);continue}
    if(restoreState&&ack.type==='window-restore-stream-visible'){visibleProof.push(ack);continue}
    if(ack.type!=='launcher-stream-visible')continue
    const gate=gates.get(ack.turn)
    if(!gate||ack.assistantMessageID!==gate.replyID||ack.phase!=='Streaming'||ack.afterTool!==withTools){for(const item of gates.values())item.reject();continue}
    visibleProof.push(ack);gate.resolve()
  }
}
function add(id,title) {
  const row={id,title,projectID:'global',location:{directory:project},permissions:[{action:'*',resource:'*',effect:'deny'}],time:{created:1,busy:0,idle:1}}
  records.set(id,row);stores.set(id,new FixtureStore(0));return row
}
add('ses_existing','Existing history')
if(webMobile)for(let i=0;i<70;i++)stores.get('ses_existing').append('assistant',`Mobile history row ${i}`)
stores.get('ses_existing').append('user','Existing project history');stores.get('ses_existing').append('assistant','Existing answer')
add('ses_another','Another session')
if(withTools)stores.get('ses_existing').rows[1].content.push({type:'tool',id:'historical-read',name:'read',state:{status:'completed',input:{file:'synthetic.rs'},content:[{type:'text',text:'fn historical() {}'}]}})
const control=controls?controlsFixture({records,stores,streams,project,stats}):null
const upstream=createServer(async(req,res)=>{
  try {
    const url=new URL(req.url,'http://127.0.0.1');requests.push(`${req.method} ${url.pathname}`)
    if(filesState)assert(!(url.pathname==='/api/session'&&req.method==='POST')&&!url.pathname.endsWith('/prompt'),'Files state forbids native session creation and prompts')
    assert.equal(req.headers.authorization,`Basic ${Buffer.from('opencode:fixture-native').toString('base64')}`)
    let raw='';for await(const chunk of req){raw+=chunk;assert(raw.length<262144)}
    const json=data=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(data))}
    if(web){
      assert(!['prompt','interrupt'].some(action=>url.pathname.endsWith(`/${action}`))&&!(url.pathname==='/api/session'&&req.method==='POST'),'Read-only web fixture')
      if(url.pathname==='/api/config')return json([{type:'directory',path:project}])
      if(url.pathname==='/api/model')return json({location:{directory:project},data:[]})
      if(/^\/api\/session\/[^/]+\/(permission|form)$/.test(url.pathname))return json({data:[]})
    }
    if(control&&await control.route(req,url,raw,json,res))return
    if(url.pathname==='/api/event') {
      res.writeHead(200,{'content-type':'text/event-stream'});res.write(`data: ${JSON.stringify({id:randomUUID(),type:'server.connected',created:Date.now(),data:{}})}\n\n`)
      streams.add(res);req.on('close',()=>streams.delete(res));return
    }
    if(url.pathname==='/api/location')return json(gitCount?{directory:project,project:{id:'fixture_project',canonical:project,directory:project}}:{data:{directory:project}})
    if(gitCount&&url.pathname==='/api/worktree')return json(Array.from({length:gitCount},(_,i)=>({directory:i?path.join(profile,`absent-checkout-${i}`):project})))
    if(url.pathname==='/api/session'&&req.method==='GET') {
      stats.lists++
      let rows=[...records.values()]
      let next
      if(!url.searchParams.has('cursor')){
        assert.equal(url.searchParams.get('directory'),project);assert.equal(url.searchParams.get('limit'),'200')
        next=Buffer.from(JSON.stringify({directory:project,anchor:{id:rows[0].id,time:1,direction:'next'}})).toString('base64url')
        rows=rows.slice(0,1)
      }else{assert.equal(JSON.parse(Buffer.from(url.searchParams.get('cursor'),'base64url')).directory,project);rows=rows.slice(1)}
      return json({data:rows,cursor:next?{next}:{}})
    }
    if(url.pathname==='/api/session'&&req.method==='POST') {
      const body=JSON.parse(raw);assert.equal(body.location.directory,project)
      const created=add(`ses_created_${++stats.created}`,body.title)
      if(uncertain&&stats.created===1){res.statusCode=500;return json({error:'simulated response lost after creation'})}
      return json({data:created})
    }
    if(url.pathname==='/api/plugin')return json({location:{directory:project},data:[{id:'codenomad-session-pruning',state:{status:'active'}}]})
    if(url.pathname==='/api/rpc/codenomad.session-pruning/window'){
      const {input}=JSON.parse(raw);return json({output:stores.get(input.sessionID).window(input.target)})
    }
    if(url.pathname==='/api/rpc/codenomad.missions/scheduleCarrierRead')return json({output:{owned:false}})
    const match=url.pathname.match(/^\/api\/session\/([^/]+)(?:\/(.*))?$/)
    if(match){
      const [,id,action]=match,record=records.get(id),store=stores.get(id);assert(record,'known fixture session')
      if(!action)return json({data:record})
      if(action==='message')return json({data:store.rows.slice(-Number(url.searchParams.get('limit'))),cursor:url.searchParams.get('order')==='asc'?{next:'future-read-anchor'}:{}})
      if(action==='environment'){res.statusCode=204;res.end();return}
      if(action==='prompt'){
        const turn=++stats.prompts;assert(id.startsWith('ses_created_'),'send belongs to selected created session')
        const body=JSON.parse(raw),reply=store.append('assistant','',false)
        if(restoreState){assert.equal(id,turn===1?'ses_created_2':'ses_created_1');assert.equal(body.text,turn===1?'Bêta · 日本語 🦀\nsecond brouillon':'Alpha · été 🦀\npremier brouillon');restorePrompts.push({sessionID:id,turn,utf16Length:body.text.length})}
        // Authoritative user precedes assistant.
        store.rows.pop();store.append('user',body.text);reply.id=`reply-${id}-${turn}`;store.rows.push(reply)
        const emit=(type,data)=>{for(const stream of streams)stream.write(`data: ${JSON.stringify({id:randomUUID(),type,created:Date.now(),location:{directory:project},data:{sessionID:id,...data}})}\n\n`)}
        record.time.busy=Date.now();emit('session.step.started',{assistantMessageID:reply.id,agent:'fixture',model:{providerID:'fixture',id:'fixture'}})
        json({data:{id:`inbox-${turn}`}})
        let tool
        if(withTools){
          const preface=textStream(reply,emit);preface.append(`Preparing turn ${turn}`);preface.close()
          tool={type:'tool',id:`tool-${turn}`,name:'read',state:{status:'streaming'}};reply.content.push(tool)
          emit('session.tool.input.started',{assistantMessageID:reply.id,id:tool.id,name:'read'});await new Promise(r=>setTimeout(r,350))
          tool.state={status:'running',input:{file:'synthetic.rs'}}
          emit('session.tool.called',{assistantMessageID:reply.id,id:tool.id,input:tool.state.input,executed:true});await new Promise(r=>setTimeout(r,350))
          tool.state={...tool.state,status:'completed',content:[{type:'text',text:`Synthetic output ${turn}`}]}
          emit('session.tool.success',{assistantMessageID:reply.id,id:tool.id,content:tool.state.content,executed:true})
        }
        const characters=Array.from(responseFor(turn,body.text)),size=withTools?3:1
        const text=textStream(reply,emit,withTools?1:0)
        for(let i=0;i<characters.length;i+=size){
          const gate=!restoreState&&i<7&&i+size>=7?visibleGate(turn,reply.id):null
          text.append(characters.slice(i,i+size).join(''))
          if(gate)await gate
          await new Promise(r=>setTimeout(r,15))
        }
        text.close()
        reply.time.completed=Date.now();record.time.idle=Date.now();emit('session.execution.succeeded',{});return
      }
    }
    res.statusCode=404;json({_tag:'RpcError',type:'rpc.method_not_found',message:'Unsupported fixture route'})
  }catch(error){console.error(error);if(!res.writableEnded){res.statusCode=500;res.end('{}')}}
})
await new Promise(r=>upstream.listen(0,'127.0.0.1',r))
const env=await privateEnvironment(profile)
Object.assign(env,{CNRS_SERVER_PASSWORD:'fixture-backend',CNRS_FIXTURE_URL:`http://127.0.0.1:${upstream.address().port}/`,CNRS_FIXTURE_PASSWORD:'fixture-native',CNRS_FIXTURE_STDIN_STOP:'1',GIT_CEILING_DIRECTORIES:profile,CODENOMAD_REMOTE_CONTROL:'disabled'})
if(web)env.CNRS_FIXTURE_UI_DIR=ui
if(webMobile)Object.assign(env,{CODENOMAD_REMOTE_CONTROL:'',CNRS_HTTPS_BIND:'127.0.0.1:0',CNRS_HTTPS_NAME:'127.0.0.1',CNRS_FIXTURE_INGRESS:'1'})
const server=spawn(serverBinary,[path.dirname(project),path.join(profile,'identity.json'),'0','synthetic-only'],{cwd:profile,env,windowsHide:true,stdio:['pipe','pipe','pipe']})
let log='',client,result=1,http,staticProof,diagnostic='';server.stdout.on('data',d=>{if(log.length<1048576)log+=d});server.stderr.on('data',d=>{if(log.length<1048576)log+=d})
const exited=new Promise(resolve=>{server.once('close',resolve);server.once('error',resolve)})
try{
  let origin;for(const until=Date.now()+20000;!origin;){assert(Date.now()<until&&server.exitCode===null,'Rust startup');origin=log.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];if(!origin)await new Promise(r=>setTimeout(r,50))}
  if(web){
    http=await request.newContext({baseURL:origin,timeout:15000})
    assert.equal((await http.get('/api/workspaces')).status(),401,'Workspace inventory requires authentication')
    assert.equal((await http.post('/api/auth/login',{data:{username:'codenomad',password:'fixture-backend'}})).status(),200)
    const storage=path.join(profile,'browser-storage.json')
    let uiOrigin=origin, paired
    if(webMobile){
      uiOrigin=log.match(/^HTTPS (https:\/\/127\.0\.0\.1:\d+)\r?$/m)?.[1];assert(uiOrigin,'Rust HTTPS fixture missing')
      const issue=await http.post('/api/remote-control/pairings')
      assert.equal(issue.status(),200)
      paired=await pairFixture({origin:uiOrigin,pairingUrl:(await issue.json()).url,storage,manifest,ui})
    }else await http.storageState({path:storage})
    let workspace
    if(!webRestore){const opened=await http.post('/api/workspaces',{data:{path:project}});assert(opened.ok(),`Open isolated workspace: ${await opened.text()}`);workspace=(await opened.json()).id;assert(workspace)}
    const wasm=await http.get('/app_bg.wasm');assert.equal(wasm.status(),200)
    const sha256=createHash('sha256').update(await wasm.body()).digest('hex')
    assert.equal(sha256,manifest.files.find(file=>file.file==='app_bg.wasm').sha256)
    staticProof={sha256,testSupport:manifest.testSupport,origin,workspace,serverBinary,ui,paired}
    const runner=webRestore?'web-restore.mjs':'web-smoke.mjs'
    client=spawn(process.execPath,[path.join(root,`scripts/rune/${runner}`),'--url',`${uiOrigin}/`,...(webMobile?['--mobile']:[]),...(webPending?['--pending-open']:[]),...(webRestore?[]:['--connected','--workspace',workspace]),'--project',project,'--storage-state',storage,'--out',path.join(profile,'browser'),'--executable',chromium.executablePath()],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']})
    for(const stream of [client.stdout,client.stderr])stream.on('data',d=>{if(diagnostic.length<262144)diagnostic+=d})
  }else if(pendingOpen){
    await pendingOpenFixture({origin,profile,project,env,clientBinary});result=0
  }else if(restoreState){
    for(const stage of ['prepare','resume','verify']){
      clientLines=''
      client=spawn(clientBinary,['--probe-window-restore'],{cwd:profile,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...env,RUNE_BACKEND:`${origin}/`,RUNE_PASSWORD:'fixture-backend',RUNE_TEST_FOLDER:project,RUNE_LOCALE:'fr',RUNE_STATE_DIR:path.join(profile,'rune-state'),RUNE_TEST_RESTORE_STAGE:stage}})
      client.stdout.on('data',clientOutput);client.stderr.on('data',d=>{clientLog=(clientLog+d).slice(-262144);process.stderr.write(d)})
      const timer=setTimeout(()=>client.kill(),120000)
      try{result=await new Promise((resolve,reject)=>{client.on('exit',resolve);client.on('error',reject)})}finally{clearTimeout(timer)}
      assert.equal(result,0,`Restore stage ${stage}`)
      assert.equal(restoreStages.at(-1)?.stage,stage,'Each process publishes its stage proof')
      assert.equal(stats.created,2,'Restore must not create native sessions');assert.equal(stats.prompts,stage==='prepare'?0:2,'Only explicit resumed sends submit prompts')
    }
  }else {
    client=spawn(clientBinary,[filesState?'--probe-files-state':workspaceClaims?'--probe-workspace-claims':controls?'--probe-controls':'--probe-launcher'],{cwd:profile,windowsHide:true,stdio:[filesState?'pipe':'ignore','pipe','pipe'],env:{...env,RUNE_BACKEND:`${origin}/`,RUNE_PASSWORD:'fixture-backend',RUNE_TEST_FOLDER:project,RUNE_LOCALE:'fr',...(filesState?{RUNE_STATE_DIR:path.join(profile,'rune-state'),RUNE_TEST_DOCUMENT_STATE:documentState?'1':'0'}:{}),...(uncertain?{RUNE_TEST_CREATE_UNCERTAIN:'1'}:{}),...(withTools?{RUNE_TEST_TOOLS:'1'}:{})}})
    client.stdout.on('data',clientOutput);client.stderr.on('data',d=>{clientLog=(clientLog+d).slice(-262144);process.stderr.write(d)})
    client.on('close',()=>{for(const gate of gates.values())gate.reject()})
  }
  if(!restoreState&&!pendingOpen){
    const budget=web||filesState?300000:120000
    let expired=false
    const timer=setTimeout(()=>{expired=true;client.kill()},budget)
    try{result=await new Promise((resolve,reject)=>{client.on('exit',resolve);client.on('error',reject)})}finally{clearTimeout(timer)}
    assert(!expired,`Client probe exceeded ${budget}ms; last Files stage: ${filesStages.at(-1)?.stage??'none'}`)
  }
  assert.equal(result,0,diagnostic||undefined);if(web){assert.equal(stats.created,0);assert.equal(stats.prompts,0);if(!webRestore)assert(stats.lists>=(webMobile?6:12))}else if(workspaceClaims||pendingOpen||filesState){assert.equal(stats.created,0);assert.equal(stats.prompts,0)}else if(controls){control.done()}else{assert.equal(stats.created,restoreState?2:1);assert.equal(stats.prompts,2)}
  if(filesState){
    await filesChain;assert(filesProof);assert.deepEqual(filesStages.map(s=>s.stage),filesExpected)
    const version=text=>`"${createHash('sha256').update(text).digest('hex')}"`
    assert.deepEqual(filesProof.readerVersions.map(p=>p.text),readerTexts)
    assert.deepEqual(filesProof.readerVersions.map(p=>p.version),readerTexts.map(version))
    for(const preview of filesProof.readerVersions){assert.equal(preview.path,'src/initial.ts');assert.equal(path.resolve(preview.directory),project);assert.equal(preview.session,'ses_existing');assert(preview.workspace)}
    assert.equal(new Set(filesProof.readerVersions.map(p=>p.workspace)).size,1)
    assert.equal(filesProof.readerReplacement.path,'initial.txt');assert.equal(filesProof.readerReplacement.text,'initial');assert.equal(filesProof.readerReplacement.version,version('initial'))
    for(const key of ['readerHiddenLive','readerSuspensionRetained','readerQueuedCloseAndReplacementFenced','readerClosed'])assert.equal(filesProof[key],true)
    if(documentState)assert.deepEqual(filesProof.document,{cancelled:true,versionConflict:true,saved:documentDraft,draftRetained:true,lateEditRejected:true,discarded:true,interfaceQualified:false})
    assert(!requests.includes('POST /api/session'));assert(!requests.some(r=>r.endsWith('/prompt')))
    http=await request.newContext({baseURL:origin});assert.equal((await http.post('/api/auth/login',{data:{username:'codenomad',password:'fixture-backend'}})).status(),200);assert.deepEqual(await (await http.get('/api/workspaces')).json(),[])
  }
  if(!web&&!controls&&!workspaceClaims&&!pendingOpen&&!filesState)assert.deepEqual(visibleProof.map(p=>p.turn),[1,2],'Both distinct assistant turns must be visible before their endings')
  if(restoreState){assert.deepEqual(restoreStages.map(s=>s.stage),['prepare','resume','verify']);assert.deepEqual(restorePrompts.map(p=>p.sessionID),['ses_created_2','ses_created_1']);for(const id of ['ses_created_1','ses_created_2']){const rows=stores.get(id).rows;assert.deepEqual(rows.map(r=>r.type),['user','assistant']);assert(rows[1].time.completed)}}
  if(gitCount)assert.equal(requests.filter(r=>r==='GET /api/worktree').length,0,'root mutations must not enumerate sibling worktrees')
  console.log(JSON.stringify({fixture:'launcher',uncertain,withTools,workspaceClaims,restoreState,webRestore,filesState,documentState,...stats,profile}))
}catch(error){result=1;throw error}finally{
  control?.close()
  for(const gate of gates.values())gate.reject()
  await http?.dispose()
  if(client?.exitCode===null)client.kill();server.stdin.on('error',()=>{});server.stdin.end('shutdown\n')
  await Promise.race([exited,new Promise(r=>setTimeout(r,3000))]);if(server.exitCode===null){server.kill();await Promise.race([exited,new Promise(r=>setTimeout(r,5000))])}
  for(const stream of streams)stream.destroy();upstream.closeAllConnections();upstream.close()
  await writeFile(path.join(profile,'proof.json'),JSON.stringify({result,stats,visibleProof,restoreStages,restorePrompts,filesStages,filesProof,requests,static:staticProof,profile,project,forbidden,serverExitCode:server.exitCode},null,2));await writeFile(path.join(profile,'rust.log'),log)
  if(!web)await writeFile(path.join(profile,'client.log'),clientLog)
  if(web)await writeFile(path.join(profile,'browser-run.log'),diagnostic)
  if(result===0)assert.equal(server.exitCode,0,'Owned Rust server must exit cleanly')
}
process.exitCode=result??1
