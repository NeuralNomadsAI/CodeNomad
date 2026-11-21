// Real, unmodified CodeNomad Rust server; only its upstream OpenCode service is synthetic.
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {spawn} from 'node:child_process'
import {mkdir, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {randomUUID} from 'node:crypto'
import {responseFor} from './fixture-response.mjs'
import {privateEnvironment} from './private-profile.mjs'
import {FixtureStore} from './fixture-store.mjs'
const here = import.meta.dirname
const profile = path.join(here,'fixture-profile',randomUUID())
const project = path.join(profile,'projects','synthetic')
await mkdir(project,{recursive:true})
const session = 'ses_rune_synthetic'
const code = 'fn main() {\n    println!("Rune · Code Nomad");\n}'
const record = {id:session,projectID:'global',location:{directory:project},time:{created:1},title:'Synthetic Rune'}
const fresh = process.argv.includes('--fresh-probe')
const store = new FixtureStore(fresh?0:10000)
const upstreamStreams = new Set()
const requests = []
let turn = 0
const upstream = createServer(async(req,res)=>{
  const url = new URL(req.url,'http://127.0.0.1')
  requests.push(`${req.method} ${url.pathname}`)
  assert.equal(req.headers.authorization,`Basic ${Buffer.from('opencode:fixture-native').toString('base64')}`)
  let raw=''; for await(const chunk of req) { raw+=chunk; assert(raw.length<262144) }
  const json = value => { res.setHeader('content-type','application/json');res.end(JSON.stringify(value)) }
  if(url.pathname==='/api/event') {
    res.writeHead(200,{'content-type':'text/event-stream'})
    res.write(`data: ${JSON.stringify({id:'connected',type:'server.connected',created:Date.now(),data:{}})}\n\n`)
    upstreamStreams.add(res);req.on('close',()=>upstreamStreams.delete(res));return
  }
  if(url.pathname==='/api/location') return json({data:{directory:project}})
  if(url.pathname===`/api/session/${session}`) return json({data:record})
  if(url.pathname===`/api/session/${session}/message`) {
    const limit=Number(url.searchParams.get('limit'));assert([1,200].includes(limit));
    return json({data:store.rows.slice(-limit),cursor:{}})
  }
  if(url.pathname==='/api/plugin') return json({location:{directory:project},data:[{id:'codenomad-session-pruning',state:{status:'active'}}]})
  if(url.pathname==='/api/rpc/codenomad.session-pruning/window') {
    assert.equal(JSON.parse(raw).input.sessionID,session)
    return json({output:store.window(JSON.parse(raw).input.target)})
  }
  if(url.pathname==='/api/rpc/codenomad.missions/scheduleCarrierRead') return json({output:{owned:false}})
  if(url.pathname===`/api/session/${session}/environment`) {
    assert.equal(req.method,'PUT');return json({data:{}})
  }
  if(url.pathname===`/api/session/${session}/prompt`) {
    assert.equal(req.method,'POST');assert.equal(typeof JSON.parse(raw).text,'string')
    assert(upstreamStreams.size>0,'Rust bridge connected')
    const emit=(type,data)=>{for(const stream of upstreamStreams)stream.write(`data: ${JSON.stringify({id:randomUUID(),type,
      created:Date.now(),location:{directory:project},data:{sessionID:session,...data}})}\n\n`)}
    const currentTurn=++turn
    const replyID=`reply-native-${currentTurn}`
    const response=responseFor(currentTurn,JSON.parse(raw).text)
    store.append('user',JSON.parse(raw).text)
    const stored=store.append('assistant','',false);stored.id=replyID
    emit('session.step.started',{assistantMessageID:replyID,agent:'fixture',model:{providerID:'fixture',id:'fixture'}})
    json({data:{id:`inbox-synthetic-${currentTurn}`}})
    for(const character of response){stored.content[0].text+=character;emit('session.text.delta',{assistantMessageID:replyID,ordinal:0,delta:character});await new Promise(r=>setTimeout(r,10))}
    stored.time.completed=Date.now()
    emit('session.execution.succeeded',{});return
  }
  res.statusCode=404;json({_tag:'RpcError',type:'rpc.method_not_found',message:'Synthetic fixture: unsupported'})
})
await new Promise(r=>upstream.listen(0,'127.0.0.1',r))
// Build a minimal child environment: user config, credentials and daemon overrides never inherit.
const env=await privateEnvironment(profile)
Object.assign(env,{CNRS_SERVER_PASSWORD:'fixture-backend',CNRS_FIXTURE_URL:`http://127.0.0.1:${upstream.address().port}/`,
  CNRS_FIXTURE_PASSWORD:'fixture-native',CNRS_FIXTURE_STDIN_STOP:'1',GIT_CEILING_DIRECTORIES:profile,
  CODENOMAD_REMOTE_CONTROL:'disabled',RUST_BACKTRACE:'1'})
const server=spawn(process.env.RUNE_SERVER_EXE??path.join(here,'../server-rs/target/debug/codenomad-rs.exe'),
  [path.dirname(project),path.join(profile,'identity.json'),'0','synthetic-only'],{cwd:profile,env,windowsHide:true,stdio:['pipe','pipe','pipe']})
let log='';server.stdout.on('data',d=>log+=d);server.stderr.on('data',d=>log+=d)
let child
let result=1
try {
  let origin
  for(const end=Date.now()+20000;!origin;){
    assert(Date.now()<end && server.exitCode===null,`Rust startup: ${log}`)
    origin=log.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];if(!origin)await new Promise(r=>setTimeout(r,100))
  }
  const login=await fetch(`${origin}/api/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'codenomad',password:'fixture-backend'})})
  assert.equal(login.status,200)
  const cookie=login.headers.get('set-cookie').split(';')[0]
  const opened=await fetch(`${origin}/api/workspaces`,{method:'POST',headers:{'content-type':'application/json',cookie},body:JSON.stringify({path:project})})
  const workspace=await opened.json();assert.equal(opened.status,201,JSON.stringify(workspace))
  for(const end=Date.now()+10000;upstreamStreams.size===0;){assert(Date.now()<end,'Rust event bridge');await new Promise(r=>setTimeout(r,50))}
  const args=process.argv.slice(2)
  const runeArgs=fresh?['--probe-fresh']:args.includes('--window')?args.filter(arg=>arg!=='--window'):args.length?args:['--probe-contract']
  child=spawn(process.env.RUNE_CLIENT_EXE || path.join(here,'target/debug/codenomad-rune-chat.exe'),runeArgs,{
    cwd:profile,windowsHide:true,stdio:'inherit',env:{...env,RUNE_BACKEND:`${origin}/`,RUNE_WORKSPACE:workspace.id,
      RUNE_SESSION:session,RUNE_PASSWORD:'fixture-backend',RUNE_LOCALE:'fr',RUNE_EMPTY_SESSION:fresh?'1':'0'},
  })
  result=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve)})
  assert.equal(result,0,'Rune client exit')
  console.log(JSON.stringify({fixture:'real-rust-server-synthetic-opencode',exitCode:result,requests},null,2))
} finally {
  if(child?.exitCode===null)child.kill()
  server.stdin.write('shutdown\n')
  await Promise.race([new Promise(r=>server.on('exit',r)),new Promise(r=>setTimeout(r,5000))])
  if(server.exitCode===null)server.kill()
  for(const stream of upstreamStreams)stream.end()
  upstream.closeAllConnections();upstream.close()
  await writeFile(path.join(profile,'server.log'),log)
}
process.exitCode=result??1
