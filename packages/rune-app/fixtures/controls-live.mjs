// Explicit real OpenCode test. Own empty project/session; deny all model tools.
import assert from 'node:assert/strict'
import {spawnFixtureChild as spawn} from '../../../scripts/native-fixture-guards.mjs'
import {mkdir,writeFile} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import path from 'node:path'
import {connectNative} from './live-access.mjs'
import {privateEnvironment} from './private-profile.mjs'
import {requireTestSupport,clientBinary} from './fixture-binaries.mjs'
requireTestSupport()
const here=path.resolve(import.meta.dirname,'..'),profile=path.join(here,'fixture-profile',`controls-live-${randomUUID()}`)
const project=path.join(profile,'projects','empty');await mkdir(project,{recursive:true})
const native=await connectNative(),permissions=[{action:'*',resource:'*',effect:'deny'}]
const target={id:'opus',providerID:'claude-agent',variant:'low'}
const catalogue=await native.read(`/api/model?${new URLSearchParams({'location[directory]':project})}`)
assert(catalogue.data.some(m=>m.enabled&&m.id===target.id&&m.providerID===target.providerID&&m.variants?.some(v=>v.id===target.variant)),'existing configured model capability')
const title='Rune disposable agent-controls test'
const session=(await native.read('/api/session',{method:'POST',body:JSON.stringify({title,location:{directory:project},permissions,model:{id:target.id,providerID:target.providerID}})})).data
await writeFile(path.join(profile,'session.json'),JSON.stringify({session:session.id,project,title},null,2))
assert(session?.id&&session.location.directory===project)
const env={...await privateEnvironment(profile),CNRS_FIXTURE_URL:native.origin,CNRS_FIXTURE_PASSWORD:native.password,CNRS_SERVER_PASSWORD:'fixture-controls-live',CNRS_FIXTURE_STDIN_STOP:'1',GIT_CEILING_DIRECTORIES:profile}
const server=spawn(process.env.RUNE_SERVER_EXE??path.join(here,'../server-rs/target/controls/debug/codenomad-rs.exe'),[project,path.join(profile,'identity.json'),'0','owned-real-controls'],{cwd:profile,env,windowsHide:true,stdio:['pipe','pipe','pipe']})
let log='',client,result=1,observer,watch,events=[],cleaned=false
server.stdout.on('data',d=>log+=d);server.stderr.on('data',d=>log+=d)
try{
  let origin;for(const until=Date.now()+20000;!origin;){assert(Date.now()<until&&server.exitCode===null,'owned Rust startup');origin=log.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];if(!origin)await new Promise(r=>setTimeout(r,50))}
  const login=await fetch(`${origin}/api/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'codenomad',password:'fixture-controls-live'})});assert.equal(login.status,200)
  const cookie=login.headers.get('set-cookie').split(';')[0]
  const response=await fetch(`${origin}/api/workspaces`,{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({path:project})})
  assert.equal(response.status,201)
  const workspace=await response.json();assert(workspace.id&&path.resolve(workspace.path)===project)
  observer=new AbortController()
  const stream=await fetch(`${origin}/api/events?clientId=controls-live-observer&connectionId=owned`,{headers:{cookie},signal:observer.signal});assert.equal(stream.status,200)
  watch=(async()=>{let buffer='';const decoder=new TextDecoder();for await(const chunk of stream.body){
    buffer+=decoder.decode(chunk,{stream:true});assert(buffer.length<2*1024*1024);let index
    while((index=buffer.indexOf('\n\n'))>=0){const block=buffer.slice(0,index);buffer=buffer.slice(index+2)
      if(block.includes('event: codenomad.client.ping')){await fetch(`${origin}/api/client-connections/pong`,{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({clientId:'controls-live-observer',connectionId:'owned'})});continue}
      const raw=block.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5)).join('\n');if(!raw)continue
      const value=JSON.parse(raw);if(value.type==='instance.event'&&value.event?.data?.sessionID===session.id)events.push(value.event.type)
    }
  }})().catch(error=>{if(!observer.signal.aborted)throw error})
  client=spawn(clientBinary,['--probe-real-controls'],{cwd:profile,env:{...env,RUNE_BACKEND:`${origin}/`,RUNE_PASSWORD:'fixture-controls-live',RUNE_WORKSPACE:workspace.id,RUNE_SESSION:session.id,RUNE_EMPTY_SESSION:'1',RUNE_TEST_MODEL:JSON.stringify(target),RUNE_LOCALE:'fr'},windowsHide:true,stdio:'inherit'})
  result=await new Promise((resolve,reject)=>{client.on('exit',resolve);client.on('error',reject)})
  assert.equal(result,0)
  const fresh=(await native.read(`/api/session/${session.id}`)).data
  assert.deepEqual(fresh.model,target);assert.deepEqual(fresh.permissions,permissions)
  const exported=(await native.read(`/api/experimental/session/${session.id}/export`)).data
  assert(exported.messages.some(m=>m.type==='assistant'));assert.equal(events.filter(t=>t.startsWith('session.tool.')).length,0)
  assert(events.filter(t=>t==='session.text.delta').length>=2,'real streaming fragments')
  assert(events.includes('session.execution.interrupted'),'native interruption event')
  console.log(JSON.stringify({result:'real-controls-qualified',deltaEvents:events.filter(t=>t==='session.text.delta').length,toolEvents:0,rows:exported.messages.length,profile}))
}finally{
  if(client?.exitCode===null)client.kill();observer?.abort();await watch?.catch(()=>{})
  try{
  const fresh=(await native.read(`/api/session/${session.id}`)).data
  assert.equal(fresh.title,title);assert.equal(fresh.location.directory,project);assert.deepEqual(fresh.permissions,permissions)
  if(fresh.time?.busy>(fresh.time?.idle??0))await native.read(`/api/session/${session.id}/interrupt`,{method:'POST',body:'{"resume":false}'})
  await native.read(`/api/session/${session.id}`,{method:'DELETE'});cleaned=true
  }finally{
  server.stdin.end();await Promise.race([new Promise(r=>server.on('exit',r)),new Promise(r=>setTimeout(r,3000))]);if(server.exitCode===null)server.kill()
  await writeFile(path.join(profile,'proof.json'),JSON.stringify({result,events,session:session.id,project,cleaned},null,2));await writeFile(path.join(profile,'rust.log'),log)
  }
}
process.exitCode=result??1
