// Real, unmodified CodeNomad Rust server; only its upstream OpenCode service is synthetic.
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {execFileSync} from 'node:child_process'
import {fixtureChildPid,spawnFixtureChild as spawn,stopFixtureChild} from '../../../scripts/native-fixture-guards.mjs'
import {createAttestedFetch,createAttestedRelay,RELAY_PLACEHOLDER_PASSWORD,stripFixtureServerSecrets,verifyLoopbackListenerOwner} from '../../../scripts/native-fixture-http.mjs'
import {mkdir, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {createHash,randomUUID} from 'node:crypto'
import {responseFor,textStream} from './fixture-response.mjs'
import {privateEnvironment} from './private-profile.mjs'
import {FixtureStore} from './fixture-store.mjs'
import {requireTestSupport,clientBinary,serverBinary} from './fixture-binaries.mjs'
requireTestSupport()
const here = path.resolve(import.meta.dirname,'..')
const artifacts = process.env.RUNE_FIXTURE_ARTIFACTS ?? path.join(here,'fixture-profile')
assert(path.isAbsolute(artifacts),'Fixture artifacts directory must be absolute')
const profile = path.join(artifacts,randomUUID())
const project = path.join(profile,'projects','synthetic')
await mkdir(project,{recursive:true})
const env=await privateEnvironment(profile)
const history = process.argv.includes('--prompt-history')
const linked = process.argv.includes('--history-worktree') ? path.join(path.dirname(project),'linked checkout') : null
if(linked) {
  assert(history)
  const gitEnv={...env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:path.join(profile,'empty.gitconfig'),GIT_TEMPLATE_DIR:''}
  const git = (...args) => execFileSync('git',['-c','core.hooksPath=',...args],{cwd:project,env:gitEnv,windowsHide:true,timeout:30000})
  git('init','--quiet','--template=')
  git('-c','user.name=Fixture','-c','user.email=fixture@invalid','commit','--quiet','--allow-empty','-m','fixture')
  git('worktree','add','--quiet','--detach',linked,'HEAD')
}
const directory = linked ?? project
const session = 'ses_rune_synthetic'
const code = 'fn main() {\n    println!("Rune · Code Nomad");\n}'
const record = {id:session,projectID:linked?'fixture-project':'global',location:{directory},time:{created:1},title:'Synthetic Rune'}
const fresh = process.argv.includes('--fresh-probe')
const slash = !linked && (history || process.argv.includes('--probe-slash'))
const historyText = linked ? 'Historique lié 🦀' : '/review résumé 🦀'
const attachments = process.argv.includes('--probe-attachments')
const bytes = Buffer.from('Rune attachment fixture 🦀\r\n')
const capture = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aN0AAAAASUVORK5CYII=','base64')
const sha = bytes=>createHash('sha256').update(bytes).digest('hex')
if(attachments) {
  for(const file of [path.join(project,'sample.txt'),path.join(profile,'selected.txt'),path.join(profile,'dropped.txt'),path.join(profile,'pasted.txt')])
    await writeFile(file,bytes)
  await writeFile(path.join(profile,'capture.png'),capture)
}
const store = new FixtureStore(fresh||slash||history||attachments?0:10000)
const upstreamStreams = new Set()
const requests = []
const commands = []
let attachmentPrompts=0, attachmentReads=0, projectionReads=0
let turn = 0
const backendPassword=randomUUID(),nativePassword=randomUUID()
const upstream = createServer(async(req,res)=>{
  const url = new URL(req.url,'http://127.0.0.1')
  requests.push(`${req.method} ${url.pathname}`)
  assert.equal(req.headers.authorization,`Basic ${Buffer.from(`opencode:${nativePassword}`).toString('base64')}`)
  let raw=''; for await(const chunk of req) { raw+=chunk; assert(raw.length<262144) }
  const json = value => { res.setHeader('content-type','application/json');res.end(JSON.stringify(value)) }
  if(url.pathname==='/api/event') {
    res.writeHead(200,{'content-type':'text/event-stream'})
    res.write(`data: ${JSON.stringify({id:'connected',type:'server.connected',created:Date.now(),data:{}})}\n\n`)
    upstreamStreams.add(res);req.on('close',()=>upstreamStreams.delete(res));return
  }
  if(url.pathname==='/api/location') {
    if(!linked) return json({data:{directory:project}})
    const found=url.searchParams.get('location[directory]')??project
    return json({directory:found,project:{id:'fixture-project',canonical:project,directory:found}})
  }
  if(linked&&url.pathname==='/api/worktree') return json([{directory:project},{directory:linked}])
  if(linked&&url.pathname==='/api/model') return json({location:{directory},data:[]})
  if(linked&&[ `/api/session/${session}/permission`, `/api/session/${session}/form` ].includes(url.pathname)) return json({data:[]})
  if(slash&&url.pathname==='/api/command') {
    assert.equal(req.method,'GET')
    return json({location:{directory},data:[{name:'review',description:'Review changes'}]})
  }
  if(url.pathname===`/api/session/${session}`) return json({data:record})
  if(url.pathname===`/api/session/${session}/message`) {
    const limit=Number(url.searchParams.get('limit'));assert([1,200].includes(limit));
    return json({data:store.rows.slice(-limit),cursor:{}})
  }
  if(url.pathname==='/api/plugin') return json({location:{directory:url.searchParams.get('location[directory]')??project},data:[{id:'codenomad-session-pruning',state:{status:'active'}}]})
  if(['/api/rpc/codenomad.session-pruning/window','/api/rpc/codenomad.session-pruning/windowUserFilesV1'].includes(url.pathname)) {
    assert.equal(JSON.parse(raw).input.sessionID,session)
    const window=store.window(JSON.parse(raw).input.target)
    if(url.pathname.endsWith('windowUserFilesV1')&&window.status==='window') {
      window.userFiles='reference-v1'
      projectionReads++
    }
    return json({output:window})
  }
  if(attachments&&url.pathname==='/api/rpc/codenomad.session-pruning/sessionAttachment') {
    const {input}=JSON.parse(raw)
    assert.equal(input.sessionID,session)
    assert.equal(input.messageID,store.rows[0]?.id)
    assert(Number.isInteger(input.fileIndex)&&input.fileIndex>=0&&input.fileIndex<5)
    const content=input.fileIndex===4?capture:bytes
    assert.equal(input.sha256,sha(content))
    if(input.confirm) return json({output:{status:'current'}})
    attachmentReads++
    return json({output:{status:'file',data:content.toString('base64')}})
  }
  if(url.pathname==='/api/rpc/codenomad.missions/scheduleCarrierRead') return json({output:{owned:false}})
  if(url.pathname===`/api/session/${session}/environment`) {
    assert.equal(req.method,'PUT');return json({data:{}})
  }
  if(slash&&url.pathname===`/api/session/${session}/command`) {
    assert.equal(req.method,'POST')
    commands.push(JSON.parse(raw))
    res.writeHead(204);res.end();return
  }
  if(url.pathname===`/api/session/${session}/prompt`) {
    assert.equal(req.method,'POST');assert.equal(typeof JSON.parse(raw).text,'string')
    assert(upstreamStreams.size>0,'Rust bridge connected')
    const emit=(type,data)=>{for(const stream of upstreamStreams)stream.write(`data: ${JSON.stringify({id:randomUUID(),type,
      created:Date.now(),location:{directory},data:{sessionID:session,...data}})}\n\n`)}
    if(linked) {
      const input = JSON.parse(raw)
      assert.equal(input.text,historyText)
      const row = store.append('user',input.text)
      row.id = input.id
      return json({data:{id:input.id,sessionID:session,type:'user',payload:{text:input.text}}})
    }
    if(attachments) {
      const input=JSON.parse(raw)
      assert.equal(input.text,'./sample.txt')
      assert.equal(input.files.length,5)
      assert.equal(input.files[0].name,'sample.txt')
      assert.match(input.files[0].uri,/^file:\/\/\/.*\/sample\.txt$/)
      assert.deepEqual(input.files.slice(1,4),['selected.txt','dropped.txt','pasted.txt'].map(name=>({
        name,uri:`data:text/plain;base64,${bytes.toString('base64')}`
      })))
      assert.deepEqual(input.files[4],{name:'clipboard.png',uri:`data:image/png;base64,${capture.toString('base64')}`})
      attachmentPrompts++
      const row=store.append('user',input.text);row.id=input.id
      row.files=input.files.map(({name},index)=>({
        name,mime:index===4?'image/png':'text/plain',source:{type:'deferred',sha256:sha(index===4?capture:bytes)}
      }))
      const receipt={id:input.id,sessionID:session,type:'user',payload:{text:input.text,files:row.files}}
      emit('session.inbox.enqueued',{item:receipt})
      emit('session.inbox.delivered',{item:receipt})
      return json({data:receipt})
    }
    const currentTurn=++turn
    const replyID=`reply-native-${currentTurn}`
    const response=responseFor(currentTurn,JSON.parse(raw).text)
    store.append('user',JSON.parse(raw).text)
    const stored=store.append('assistant','',false);stored.id=replyID
    emit('session.step.started',{assistantMessageID:replyID,agent:'fixture',model:{providerID:'fixture',id:'fixture'}})
    json({data:{id:`inbox-synthetic-${currentTurn}`}})
    const text=textStream(stored,emit)
    for(const character of response){text.append(character);await new Promise(r=>setTimeout(r,15))}
    text.close();stored.time.completed=Date.now()
    emit('session.execution.succeeded',{});return
  }
  res.statusCode=404;json({_tag:'RpcError',type:'rpc.method_not_found',message:'Synthetic fixture: unsupported'})
})
await new Promise(r=>upstream.listen(0,'127.0.0.1',r))
// Build a minimal child environment: user config, credentials and daemon overrides never inherit.
Object.assign(env,{CNRS_SERVER_PASSWORD:backendPassword,CNRS_FIXTURE_URL:`http://127.0.0.1:${upstream.address().port}/`,
  CNRS_FIXTURE_PASSWORD:nativePassword,CNRS_FIXTURE_STDIN_STOP:'1',GIT_CEILING_DIRECTORIES:profile,
  CODENOMAD_REMOTE_CONTROL:'disabled',RUST_BACKTRACE:'1'})
const server=spawn(serverBinary,
  [path.dirname(project),path.join(profile,'identity.json'),'0','synthetic-only'],{cwd:profile,env,windowsHide:true,stdio:['pipe','pipe','pipe']})
const serverClosed=new Promise(r=>server.once('close',r))
let log='',stdoutLog='';server.stdout.on('data',d=>{stdoutLog+=d;log+=d});server.stderr.on('data',d=>log+=d)
let child,childClosed,rustFetch,rustRelay
let result=1
try {
  let origin
  for(const end=Date.now()+20000;!origin;){
    assert(Date.now()<end && server.exitCode===null,`Rust startup: ${log}`)
    origin=stdoutLog.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];if(!origin)await new Promise(r=>setTimeout(r,100))
  }
  const serverPid=await fixtureChildPid(server)
  assert(Number.isSafeInteger(serverPid)&&serverPid>0,'Owned fixture server PID unavailable')
  const serverPort=Number(new URL(origin).port)
  await verifyLoopbackListenerOwner(serverPort,serverPid)
  rustFetch=createAttestedFetch(origin,serverPort,serverPid)
  const login=await rustFetch(`${origin}/api/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'codenomad',password:backendPassword}),signal:AbortSignal.timeout(15000)})
  assert.equal(login.status,200)
  const cookie=login.headers.get('set-cookie').split(';')[0]
  const opened=await rustFetch(`${origin}/api/workspaces`,{method:'POST',headers:{'content-type':'application/json',cookie},body:JSON.stringify({path:project}),signal:AbortSignal.timeout(15000)})
  const workspace=await opened.json();assert.equal(opened.status,201,JSON.stringify(workspace))
  const rootInstance = `${origin}/api/storage/instances/${workspace.id}`
  const instance = `${origin}/api/storage/instances/${encodeURIComponent(directory)}`
  const agentModelSelections = { build: { providerId: 'fixture', modelId: 'fixture' } }
  const prior = Array.from({length:100}, (_, i) => `older ${i}`)
  if(history) {
    const seed = await rustFetch(instance, {method:'PUT', headers:{'content-type':'application/json',cookie}, body:JSON.stringify({messageHistory:prior,agentModelSelections}),signal:AbortSignal.timeout(15000)})
    assert.equal(seed.status,204)
    if(linked) {
      const inventory = await rustFetch(`${origin}/api/workspaces`, {headers:{cookie},signal:AbortSignal.timeout(15000)})
      assert.deepEqual((await inventory.json()).map(w=>w.id),[workspace.id])
      const rootData = await rustFetch(rootInstance,{headers:{cookie},signal:AbortSignal.timeout(15000)})
      assert.deepEqual(await rootData.json(),{messageHistory:[],agentModelSelections:{}})
      const foreign = path.join(path.dirname(project), 'unregistered')
      await mkdir(foreign)
      assert.equal((await rustFetch(`${origin}/api/storage/instances/${encodeURIComponent(foreign)}`, {headers:{cookie},signal:AbortSignal.timeout(15000)})).status,404)
      const client = (route, init={}) => rustFetch(`${origin}${route}`, {...init,headers:{...init.headers,cookie},signal:AbortSignal.timeout(15000)})
      const prefix = `/workspaces/${workspace.id}/instance/api`
      const sessionData = await (await client(`${prefix}/session/${session}`)).json()
      assert.equal(sessionData.data?.location?.directory, linked, JSON.stringify(sessionData))
      const window = await (await client(`/api/workspaces/${workspace.id}/session-history/window`, {
        method:'POST',headers:{'content-type':'application/json','x-codenomad-user-files':'reference-v1'},
        body:JSON.stringify({sessionID:session,target:{kind:'latest'}}),
      })).json()
      assert.equal(window.status,'window',JSON.stringify(window))
    }
  }
  for(const end=Date.now()+10000;upstreamStreams.size===0;){assert(Date.now()<end,'Rust event bridge');await new Promise(r=>setTimeout(r,50))}
  rustRelay=await createAttestedRelay(origin,serverPid,{requireClientAttestation:true,substitutePassword:backendPassword,isolateSessionCookie:true})
  const args=process.argv.slice(2)
  const runeArgs=history?['--probe-slash']:fresh?['--probe-fresh']:args.includes('--window')?args.filter(arg=>arg!=='--window'):args.length?args:['--probe-contract']
  const clientEnv=stripFixtureServerSecrets(env)
  const run = (stage = {}) => {
    child=spawn(clientBinary,runeArgs,{
      cwd:profile,windowsHide:true,stdio:['ignore','inherit','pipe'],env:{...clientEnv,RUNE_BACKEND:`${rustRelay.origin}/`,RUNE_WORKSPACE:workspace.id,
        RUNE_SESSION:session,RUNE_PASSWORD:RELAY_PLACEHOLDER_PASSWORD,RUNE_LOCALE:'fr',RUNE_EMPTY_SESSION:fresh?'1':'0',...(linked?{RUNE_HISTORY_WORKTREE:'1'}:{}),...stage},
    })
    let awaitPidLine=process.platform==='win32',stderrBuf=''
    child.stderr.on('data',chunk=>{
      if(awaitPidLine){
        stderrBuf+=chunk
        const nl=stderrBuf.indexOf('\n')
        if(nl<0)return
        awaitPidLine=false
        const first=stderrBuf.slice(0,nl+1),rest=stderrBuf.slice(nl+1)
        if(!/^CODENOMAD_FIXTURE_PID=\d+\r?\n$/.test(first))process.stderr.write(first)
        if(rest)process.stderr.write(rest)
        stderrBuf=''
        return
      }
      process.stderr.write(chunk)
    })
    childClosed=new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve)})
    rustRelay.allowClientPid(fixtureChildPid(child),childClosed)
    return childClosed
  }
  result=await run(history?{RUNE_PROMPT_HISTORY_STAGE:'write'}:{})
  if(history) {
    assert.equal(result,0)
    const stored = await rustFetch(instance, {headers:{cookie},signal:AbortSignal.timeout(15000)})
    assert.equal(stored.status,200)
    assert.deepEqual(await stored.json(), {messageHistory:[historyText, ...prior.slice(0,99)],agentModelSelections})
    if(linked) {
      const rootData = await rustFetch(rootInstance,{headers:{cookie},signal:AbortSignal.timeout(15000)})
      assert.deepEqual(await rootData.json(),{messageHistory:[],agentModelSelections:{}})
    }
    result=await run({RUNE_PROMPT_HISTORY_STAGE:'read'})
    if(linked) assert.equal(requests.filter(request=>request===`POST /api/session/${session}/prompt`).length,1)
  }
  if(attachments&&result===0) {
    result=await run({RUNE_ATTACHMENT_STAGE:'reopen'})
  }
  if(slash) {
    assert(!requests.includes(`POST /api/session/${session}/prompt`),'command must never fall back to a native prompt')
    assert.deepEqual(commands,[{name:'review',text:'résumé 🦀',delivery:'steer'}],
      'Rune command must reach native OpenCode once through the Rust relay')
  }
  if(attachments) {
    assert.equal(attachmentPrompts,1)
    assert.equal(attachmentReads,5)
    assert(projectionReads>=2,'Both Rune boots must negotiate the attachment history')
  }
  assert.equal(result,0,'Rune client exit')
  console.log(JSON.stringify({fixture:'real-rust-server-synthetic-opencode',exitCode:result,requests},null,2))
} finally {
  let cleanupError
  if(child)await stopFixtureChild(child,childClosed).catch(error=>{cleanupError??=error})
  await rustRelay?.close().catch(error=>{cleanupError??=error})
  await rustFetch?.close().catch(error=>{cleanupError??=error})
  try{server.stdin.write('shutdown\n')}catch{}
  await stopFixtureChild(server,serverClosed,5000).catch(error=>{cleanupError??=error})
  for(const stream of upstreamStreams)stream.end()
  upstream.closeAllConnections();upstream.close()
  await writeFile(path.join(profile,'server.log'),log)
  await writeFile(path.join(profile,'upstream-requests.json'),JSON.stringify(requests,null,2))
  if(cleanupError){
    result=1
    console.error(cleanupError.message)
  }
}
process.exitCode=result??1
