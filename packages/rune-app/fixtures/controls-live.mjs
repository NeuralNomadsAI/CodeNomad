// Explicit real OpenCode test. Own empty project/session; deny all model tools.
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {writeFile} from 'node:fs/promises'
import {setTimeout as delay} from 'node:timers/promises'
import path from 'node:path'
import {requirePrivateCli,withNative} from './live-access.mjs'
import {launchFixture,rustOrigin} from './fixture-host.mjs'
import {createAttestedFetch,createAttestedRelay,RELAY_PLACEHOLDER_PASSWORD,stripFixtureServerSecrets} from '../../../scripts/native-fixture-http.mjs'
import {requireTestSupport,clientBinary,serverBinary} from './fixture-binaries.mjs'
requirePrivateCli();requireTestSupport()
await withNative(async native=>{
const {profile,project}=native,permissions=[{action:'*',resource:'*',effect:'deny'}]
const target={id:'alternate',providerID:'fixture',variant:'low'}
const catalogue=await native.read(`/api/model?${new URLSearchParams({'location[directory]':project})}`)
assert(catalogue.data.some(m=>m.enabled&&m.id===target.id&&m.providerID===target.providerID&&m.variants?.some(v=>v.id===target.variant)),'existing configured model capability')
const title='Rune disposable agent-controls test'
const session=(await native.read('/api/session',{method:'POST',body:JSON.stringify({title,location:{directory:project},permissions,model:{id:target.id,providerID:target.providerID}})})).data
await writeFile(path.join(profile,'session.json'),JSON.stringify({session:session.id,project,title},null,2))
assert(session?.id&&session.location.directory===project)
assert.deepEqual(session.permissions,permissions,'session must enforce deny-all before launching Rune')
const rustPassword=randomUUID()
const env={...native.runtimeEnv,CNRS_FIXTURE_URL:native.relay,CNRS_FIXTURE_PASSWORD:native.relayPassword,CNRS_SERVER_PASSWORD:rustPassword,CNRS_FIXTURE_STDIN_STOP:'1',GIT_CEILING_DIRECTORIES:profile}
const server=launchFixture(serverBinary,[project,path.join(profile,'identity.json'),'0','owned-real-controls'],{cwd:profile,env,shutdown:'shutdown\n',redact:[native.password,rustPassword]})
native.allowRelayClient(server.pid(),server.closed)
let client,result=1,observer,stream,watch,watchError=null,events=[],cleaned=false,rustFetch,rustRelay
try{
  const origin=await server.ready(rustOrigin)
  const rustPid=await server.pid()
  rustFetch=createAttestedFetch(origin,Number(new URL(origin).port),rustPid)
  rustRelay=await createAttestedRelay(origin,rustPid,{requireClientAttestation:true,substitutePassword:rustPassword,isolateSessionCookie:true})
  const login=await rustFetch(`${origin}/api/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'codenomad',password:rustPassword}),signal:AbortSignal.timeout(15000)});assert.equal(login.status,200)
  const cookie=login.headers.get('set-cookie').split(';')[0]
  const response=await rustFetch(`${origin}/api/workspaces`,{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({path:project}),signal:AbortSignal.timeout(15000)})
  assert.equal(response.status,201)
  const workspace=await response.json();assert(workspace.id&&path.resolve(workspace.path)===project)
  observer=new AbortController()
  const openTimer=setTimeout(()=>observer.abort(Error('SSE open timed out')),15000)
  try{stream=await rustFetch(`${origin}/api/events?clientId=controls-live-observer&connectionId=owned`,{headers:{cookie},signal:observer.signal})}
  finally{clearTimeout(openTimer)}
  assert.equal(stream.status,200)
  watch=(async()=>{let buffer='';const decoder=new TextDecoder();for await(const chunk of stream.body){
    buffer+=decoder.decode(chunk,{stream:true});assert(buffer.length<2*1024*1024);let index
    while((index=buffer.indexOf('\n\n'))>=0){const block=buffer.slice(0,index);buffer=buffer.slice(index+2)
      if(block.includes('event: codenomad.client.ping')){await rustFetch(`${origin}/api/client-connections/pong`,{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({clientId:'controls-live-observer',connectionId:'owned'}),signal:AbortSignal.timeout(15000)});continue}
      const raw=block.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5)).join('\n');if(!raw)continue
      const value=JSON.parse(raw);if(value.type==='instance.event'&&value.event?.data?.sessionID===session.id)events.push(value.event.type)
    }
  }})().catch(error=>{if(!observer.signal.aborted)watchError??=error})
  client=launchFixture(clientBinary,['--probe-real-controls'],{cwd:profile,env:{...stripFixtureServerSecrets(env),RUNE_BACKEND:`${rustRelay.origin}/`,RUNE_PASSWORD:RELAY_PLACEHOLDER_PASSWORD,RUNE_WORKSPACE:workspace.id,RUNE_SESSION:session.id,RUNE_EMPTY_SESSION:'1',RUNE_TEST_MODEL:JSON.stringify(target),RUNE_LOCALE:'fr'},redact:[native.password,rustPassword]})
  rustRelay.allowClientPid(client.pid(),client.closed)
  result=await Promise.race([client.closed,delay(120000,124,{ref:false})])
  if(result===124)await client.stop()
  process.stdout.write(client.output())
  if(watchError)throw watchError
  assert.equal(result,0)
  const fresh=(await native.read(`/api/session/${session.id}`)).data
  assert.deepEqual(fresh.model,target);assert.deepEqual(fresh.permissions,permissions)
  const exported=(await native.read(`/api/experimental/session/${session.id}/export`)).data
  assert(exported.messages.some(m=>m.type==='assistant'));assert.equal(events.filter(t=>t.startsWith('session.tool.')).length,0)
  assert(events.filter(t=>t==='session.text.delta').length>=2,'real streaming fragments')
  assert(events.includes('session.execution.interrupted'),'native interruption event')
  console.log(JSON.stringify({result:'real-controls-qualified',deltaEvents:events.filter(t=>t==='session.text.delta').length,toolEvents:0,rows:exported.messages.length,profile}))
}finally{
  observer?.abort();void stream?.body?.cancel?.().catch(()=>{})
  if(watch)await Promise.race([watch,delay(2000,undefined,{ref:false})])
  try{
  await client?.stop()
  const fresh=(await native.read(`/api/session/${session.id}`)).data
  assert.equal(fresh.title,title);assert.equal(fresh.location.directory,project);assert.deepEqual(fresh.permissions,permissions)
  if(fresh.time?.busy>(fresh.time?.idle??0))await native.read(`/api/session/${session.id}/interrupt`,{method:'POST',body:'{"resume":false}'})
  await native.read(`/api/session/${session.id}`,{method:'DELETE'});cleaned=true
  }finally{
  try{await Promise.allSettled([rustFetch?.close(),rustRelay?.close()])}finally{await server.stop()}
  await writeFile(path.join(profile,'proof.json'),JSON.stringify({result,events,session:session.id,project,cleaned},null,2));await writeFile(path.join(profile,'rust.log'),server.output())
  }
}
process.exitCode=result??1
})
