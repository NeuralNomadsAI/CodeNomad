// Own backend, real existing OpenCode service, exact disposable session with every tool denied.
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {writeFile,readFile} from 'node:fs/promises'
import path from 'node:path'
import {prepareLive} from './live-session.mjs'
import {connectNative} from './live-access.mjs'
import {privateEnvironment} from './private-profile.mjs'
import {requireTestSupport,clientBinary,serverBinary} from './fixture-binaries.mjs'
requireTestSupport()
const here=import.meta.dirname
const existing=process.argv.indexOf('--reuse')
let live
if(existing>=0) {
  const file=path.resolve(process.argv[existing+1])
  assert(file.startsWith(path.join(here,'fixture-profile')+path.sep))
  live={...await connectNative(),...JSON.parse(await readFile(file,'utf8'))}
} else live=await prepareLive()
const {profile,project,sessionID}=live
const current=(await live.read(`/api/session/${sessionID}`)).data
assert.deepEqual(current.permissions,[{action:'*',resource:'*',effect:'deny'}])
const env={...await privateEnvironment(profile),CNRS_FIXTURE_URL:live.origin,CNRS_FIXTURE_PASSWORD:live.password,
  CNRS_SERVER_PASSWORD:'rune-live-private-backend',CNRS_FIXTURE_STDIN_STOP:'1'}
const server=spawn(serverBinary,
  [path.dirname(project),path.join(profile,'backend.json'),'0','existing-opencode'],{cwd:profile,env,windowsHide:true,stdio:['pipe','pipe','pipe']})
let log=''
server.stdout.on('data',d=>log+=d);server.stderr.on('data',d=>log+=d)
let child
let observed
try {
  let origin
  for(const end=Date.now()+20000;!origin;){
    assert(Date.now()<end&&server.exitCode===null,'Private Rust server startup failed')
    origin=log.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];if(!origin)await new Promise(r=>setTimeout(r,100))
  }
  const login=await fetch(`${origin}/api/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'codenomad',password:'rune-live-private-backend'})})
  assert.equal(login.status,200)
  const cookie=login.headers.get('set-cookie').split(';')[0]
  const call=(route,init={})=>fetch(`${origin}${route}`,{...init,headers:{cookie,'content-type':'application/json'},signal:AbortSignal.timeout(30000)})
  const opened=await call('/api/workspaces',{method:'POST',body:JSON.stringify({path:project})})
  const workspace=await opened.json();assert.equal(opened.status,201,'Disposable workspace admission')
  const abort=new AbortController()
  observed=abort
  const stream=await fetch(`${origin}/api/events?clientId=rune-live-observer&connectionId=demo-observer`,{headers:{cookie},signal:abort.signal})
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
  observe().catch(error=>{if(error.name!=='AbortError')console.error(`Live observer: ${error.message}`)})
  console.log(JSON.stringify({type:'RUNE_LIVE_READY',profile,project,sessionID,workspace:workspace.id,tools:'deny-all'}))
  child=spawn(clientBinary,[],{cwd:profile,windowsHide:true,stdio:'inherit',
    env:{...await privateEnvironment(profile),RUNE_BACKEND:`${origin}/`,RUNE_WORKSPACE:workspace.id,RUNE_SESSION:sessionID,
      RUNE_PASSWORD:'rune-live-private-backend',RUNE_LOCALE:'fr',RUNE_EMPTY_SESSION:'1',RUNE_LIVE_TITLE:'1'}})
  console.log(JSON.stringify({type:'RUNE_LIVE_WINDOW',pid:child.pid}))
  await new Promise((resolve,reject)=>{child.on('exit',resolve);child.on('error',reject)})
} finally {
  observed?.abort()
  if(child?.exitCode===null)child.kill()
  server.stdin.write('shutdown\n')
  await Promise.race([new Promise(r=>server.on('exit',r)),new Promise(r=>setTimeout(r,5000))])
  if(server.exitCode===null)server.kill()
  await writeFile(path.join(profile,'backend.log'),log)
}
