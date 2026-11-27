// Own backend and private OpenCode, with every tool denied.
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {writeFile} from 'node:fs/promises'
import {setTimeout as delay} from 'node:timers/promises'
import path from 'node:path'
import {prepareLive} from './live-session.mjs'
import {args,privateManifest,requirePrivateCli,withNative} from './live-access.mjs'
import {launchFixture,rustOrigin} from './fixture-host.mjs'
import {createAttestedFetch,createAttestedRelay,RELAY_PLACEHOLDER_PASSWORD} from '../../../scripts/native-fixture-http.mjs'
import {requireTestSupport,clientBinary,serverBinary} from './fixture-binaries.mjs'
requirePrivateCli();requireTestSupport()
const existing=args.indexOf('--reuse')
const manifest=existing<0?null:await privateManifest(args[existing+1])
await withNative(async native=>{
const live=manifest?{...native,sessionID:manifest.sessionID}:await prepareLive(native)
const {profile,project,sessionID}=live
const current=(await live.read(`/api/session/${sessionID}`)).data
assert.equal(current.location.directory,project)
assert.deepEqual(current.permissions,[{action:'*',resource:'*',effect:'deny'}])
const rustPassword=randomUUID()
const env={...live.runtimeEnv,CNRS_FIXTURE_URL:live.relay,CNRS_FIXTURE_PASSWORD:live.relayPassword,
  CNRS_SERVER_PASSWORD:rustPassword,CNRS_FIXTURE_STDIN_STOP:'1'}
const server=launchFixture(serverBinary,
  [path.dirname(project),path.join(profile,'backend.json'),'0','existing-opencode'],{cwd:profile,env,shutdown:'shutdown\n',redact:[live.password,rustPassword]})
live.allowRelayClient(server.pid(),server.closed)
let child
let observed,stream,observeTask,rustFetch,rustRelay
try {
  const origin=await server.ready(rustOrigin)
  const rustPid=await server.pid()
  rustFetch=createAttestedFetch(origin,Number(new URL(origin).port),rustPid)
  rustRelay=await createAttestedRelay(origin,rustPid,{requireClientAttestation:true,substitutePassword:rustPassword,isolateSessionCookie:true})
  const login=await rustFetch(`${origin}/api/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'codenomad',password:rustPassword}),signal:AbortSignal.timeout(15000)})
  assert.equal(login.status,200)
  const cookie=login.headers.get('set-cookie').split(';')[0]
  const call=(route,init={})=>rustFetch(`${origin}${route}`,{...init,headers:{cookie,'content-type':'application/json'},signal:AbortSignal.timeout(30000)})
  const opened=await call('/api/workspaces',{method:'POST',body:JSON.stringify({path:project})})
  const workspace=await opened.json();assert.equal(opened.status,201,'Disposable workspace admission')
  const abort=new AbortController()
  observed=abort
  const openTimer=setTimeout(()=>abort.abort(Error('SSE open timed out')),15000)
  try{stream=await rustFetch(`${origin}/api/events?clientId=rune-live-observer&connectionId=demo-observer`,{headers:{cookie},signal:abort.signal})}
  finally{clearTimeout(openTimer)}
  assert.equal(stream.status,200)
  const stats={turn:0,chunks:0,body:'',ids:[],tools:0}
  const observe=async()=>{
    let buffer=''
    const decoder=new TextDecoder()
    for await(const chunk of stream.body){
      buffer+=decoder.decode(chunk,{stream:true})
      assert(buffer.length<1048576,'Bounded event observer')
      let index
      while((index=buffer.indexOf('\n\n'))>=0){
        const block=buffer.slice(0,index);buffer=buffer.slice(index+2)
        if(block.includes('event: codenomad.client.ping')){await call('/api/client-connections/pong',{method:'POST',body:JSON.stringify({clientId:'rune-live-observer',connectionId:'demo-observer'})});continue}
        const data=block.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5)).join('\n')
        if(!data)continue
        const envelope=JSON.parse(data)
        if(envelope.type!=='instance.event'||envelope.instanceId!==workspace.id||envelope.event?.data?.sessionID!==sessionID)continue
        const event=envelope.event
        if(event.type==='session.step.started')stats.ids.push(event.data.assistantMessageID)
        if(event.type.startsWith('session.tool.'))stats.tools++
        if(event.type==='session.text.delta'){stats.chunks++;stats.body+=event.data.delta}
        if(event.type.startsWith('session.execution.')&&event.type!=='session.execution.started'){
          stats.turn++
          console.log(JSON.stringify({type:'RUNE_LIVE_TURN',...stats,outcome:event.type}))
          stats.chunks=0;stats.body='';stats.ids=[];stats.tools=0
        }
      }
    }
  }
  observeTask=observe().catch(error=>{if(!abort.signal.aborted&&error.name!=='AbortError')console.error(`Live observer: ${error.message}`)})
  console.log(JSON.stringify({type:'RUNE_LIVE_READY',profile,project,sessionID,workspace:workspace.id,tools:'deny-all'}))
  child=launchFixture(clientBinary,[],{cwd:profile,redact:[live.password,rustPassword],
    env:{...live.runtimeEnv,RUNE_BACKEND:`${rustRelay.origin}/`,RUNE_WORKSPACE:workspace.id,RUNE_SESSION:sessionID,
      RUNE_PASSWORD:RELAY_PLACEHOLDER_PASSWORD,RUNE_LOCALE:'fr',RUNE_EMPTY_SESSION:'1',RUNE_LIVE_TITLE:'1'}})
  rustRelay.allowClientPid(child.pid(),child.closed)
  console.log(JSON.stringify({type:'RUNE_LIVE_WINDOW',pid:await child.pid()}))
  assert.equal(await child.closed,0,child.output())
} finally {
  observed?.abort();void stream?.body?.cancel?.().catch(()=>{})
  if(observeTask)await Promise.race([observeTask,delay(2000,undefined,{ref:false})])
  try{await child?.stop()}finally{try{await Promise.allSettled([rustFetch?.close(),rustRelay?.close()])}finally{await server.stop()}}
  await writeFile(path.join(profile,'backend.log'),server.output())
}
},{profile:manifest?.profile})
