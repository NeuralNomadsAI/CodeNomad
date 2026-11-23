// Interactive qualification against a seeded, private OpenCode database.
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {writeFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import path from 'node:path'
import {args,requirePrivateCli,withNative} from './live-access.mjs'
import {prepareRealHistory} from './real-history-prepare.mjs'
import {seedRealHistory} from './real-history-seed.mjs'
import {privateEnvironment} from './private-profile.mjs'
import {requireTestSupport,clientBinary,serverBinary} from './fixture-binaries.mjs'
requirePrivateCli();requireTestSupport()
assert.equal(args.length,0,'Usage: interactive-live.mjs --opencode <absolute executable>; external sessions are forbidden')
await withNative(async native=>{
const {profile,project:directory}=native
const source=(await seedRealHistory(native,await prepareRealHistory(native))).info
const first=await native.read(`/api/session/${source.id}/message?limit=200`)
assert.equal(first.data.length,200);assert(first.cursor?.next,'source must be a real long history')
const fork=(await native.read(`/api/session/${source.id}/fork`,{method:'POST',body:'{}'})).data
assert.equal(fork?.fork?.sessionID,source.id,'fork retains the exact real source')
assert(fork?.id&&fork.id!==source.id&&fork.location.directory.toLowerCase()===directory.toLowerCase())
const deny=[{action:'*',resource:'*',effect:'deny'}]
const suffix=path.basename(profile).slice(-8),longTitle=`Rune · reprise réelle · ${suffix}`,newTitle=`Rune · session neuve · ${suffix}`
await native.read(`/api/session/${fork.id}`,{method:'PATCH',body:JSON.stringify({title:longTitle,permissions:deny})})
const verified=(await native.read(`/api/session/${fork.id}`)).data;assert.deepEqual(verified.permissions,deny)
const copied=await native.read(`/api/session/${fork.id}/message?limit=200`);assert.equal(copied.data.length,200);assert(copied.cursor?.next)
const env={...await privateEnvironment(profile),CNRS_FIXTURE_URL:native.origin,CNRS_FIXTURE_PASSWORD:native.password,CNRS_SERVER_PASSWORD:'interactive-rune-owned-backend',CNRS_FIXTURE_STDIN_STOP:'1'}
const server=spawn(serverBinary,[directory,path.join(profile,'backend.json'),'0','existing-opencode'],{cwd:profile,env,windowsHide:true,stdio:['pipe','pipe','pipe']})
let log='',child,observer,stopped=false,newID
const stats={sourceID:source.id,longID:fork.id,longTitle,newTitle,sourceRowsInPage:first.data.length,sourceHasOlder:true,longCopiedRowsInPage:copied.data.length,newID:null,turns:[],tools:0}
server.stdout.on('data',d=>log+=d);server.stderr.on('data',d=>log+=d)
const save=()=>writeFile(path.join(profile,'proof.json'),JSON.stringify(stats,null,2))
try{
  let origin;for(const until=Date.now()+20000;!origin;){assert(Date.now()<until&&server.exitCode===null,'Rust startup');origin=log.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];if(!origin)await new Promise(r=>setTimeout(r,100))}
  const login=await fetch(`${origin}/api/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'codenomad',password:'interactive-rune-owned-backend'})});assert.equal(login.status,200)
  const cookie=login.headers.get('set-cookie').split(';')[0]
  const call=(route,init={})=>fetch(`${origin}${route}`,{...init,headers:{cookie,'content-type':'application/json'},signal:AbortSignal.timeout(30000)})
  observer=new AbortController()
  const stream=await fetch(`${origin}/api/events?clientId=rune-interactive-observer&connectionId=observer`,{headers:{cookie},signal:observer.signal});assert.equal(stream.status,200)
  const fragments=new Map()
  async function watch(){
    let buffer='';const decoder=new TextDecoder()
    for await(const chunk of stream.body){buffer+=decoder.decode(chunk,{stream:true});assert(buffer.length<2*1024*1024);let index
      while((index=buffer.indexOf('\n\n'))>=0){const block=buffer.slice(0,index);buffer=buffer.slice(index+2)
        if(block.includes('event: codenomad.client.ping')){await call('/api/client-connections/pong',{method:'POST',body:JSON.stringify({clientId:'rune-interactive-observer',connectionId:'observer'})});continue}
        const raw=block.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5)).join('\n');if(!raw)continue
        const value=JSON.parse(raw),e=value.event,id=e?.data?.sessionID
        if(value.type!=='instance.event'||![fork.id,newID].includes(id))continue
        if(e.type.startsWith('session.tool.'))stats.tools++
        if(e.type==='session.text.delta')fragments.set(id,(fragments.get(id)??0)+1)
        if(['session.execution.succeeded','session.execution.failed','session.execution.interrupted'].includes(e.type)){
          const rows=(await native.read(`/api/session/${id}/message?limit=200`)).data
          const last=rows.find(r=>r.type==='assistant'),text=(last?.content??[]).filter(p=>p.type==='text').map(p=>p.text).join('\n')
          const turn={session:id,fragments:fragments.get(id)??0,outcome:e.type,rowsInPage:rows.length,lastMessageID:last?.id,textBytes:Buffer.byteLength(text),textHash:createHash('sha256').update(text).digest('hex')}
          stats.turns.push(turn);await save();console.log(JSON.stringify({type:'INTERACTIVE_TURN',...turn,tools:stats.tools}));fragments.set(id,0)
        }
      }
    }
  }
  watch().catch(error=>{if(!stopped&&error.name!=='AbortError')console.error('observer:',error.message)})
  const guard=setInterval(async()=>{
    if(newID||stopped)return
    try{
      const rows=await native.read(`/api/session?${new URLSearchParams({directory,limit:'200'})}`)
      const found=rows.data.filter(r=>r.title===newTitle&&!r.parentID)
      if(found.length===1){
        assert.equal(found[0].location.directory.toLowerCase(),directory.toLowerCase())
        await native.read(`/api/session/${found[0].id}`,{method:'PATCH',body:JSON.stringify({permissions:deny})})
        const readback=(await native.read(`/api/session/${found[0].id}`)).data;assert.deepEqual(readback.permissions,deny)
        newID=found[0].id;stats.newID=newID;await save();console.log(JSON.stringify({type:'INTERACTIVE_NEW_SESSION_GUARDED',session:newID}))
      }
    }catch(error){console.error('guard:',error.message)}
  },1000)
  await save();await writeFile(path.join(profile,'session.json'),JSON.stringify({profile,directory,sourceID:source.id,longID:fork.id,longTitle,newTitle}))
  child=spawn(clientBinary,[],{cwd:profile,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...await privateEnvironment(profile),RUNE_BACKEND:`${origin}/`,RUNE_PASSWORD:'interactive-rune-owned-backend',RUNE_LOCALE:'fr',RUNE_LIVE_TITLE:'1'}})
  child.stdout.on('data',d=>log+=d);child.stderr.on('data',d=>{log+=d;console.error(String(d).trim())})
  console.log(JSON.stringify({type:'INTERACTIVE_READY',profile,directory,longTitle,newTitle,pid:child.pid}))
  await new Promise(r=>child.on('exit',r));clearInterval(guard)
}finally{stopped=true;observer?.abort();if(child?.exitCode===null)child.kill();server.stdin.end();await Promise.race([new Promise(r=>server.on('exit',r)),new Promise(r=>setTimeout(r,3000))]);if(server.exitCode===null)server.kill();await save();await writeFile(path.join(profile,'rust.log'),log)}
})
