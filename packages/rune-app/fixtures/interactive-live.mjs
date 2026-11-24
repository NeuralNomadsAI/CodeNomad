// Interactive qualification against a seeded, private OpenCode database.
import assert from 'node:assert/strict'
import {writeFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {setTimeout as delay} from 'node:timers/promises'
import path from 'node:path'
import {args,requirePrivateCli,withNative} from './live-access.mjs'
import {launchFixture,rustOrigin} from './fixture-host.mjs'
import {fixtureFetch} from '../../../scripts/native-fixture-http.mjs'
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
const server=launchFixture(serverBinary,[directory,path.join(profile,'backend.json'),'0','existing-opencode'],{cwd:profile,env,shutdown:'shutdown\n',redact:[native.password,'interactive-rune-owned-backend']})
let child,observer,stream,watchTask,guardTask,stopped=false,newID
const guarded=new Set([source.id,fork.id])
const stats={sourceID:source.id,longID:fork.id,longTitle,newTitle,sourceRowsInPage:first.data.length,sourceHasOlder:true,longCopiedRowsInPage:copied.data.length,newID:null,turns:[],tools:0}
const save=()=>writeFile(path.join(profile,'proof.json'),JSON.stringify(stats,null,2))
try{
  const origin=await server.ready(rustOrigin)
  const login=await fixtureFetch(`${origin}/api/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'codenomad',password:'interactive-rune-owned-backend'})});assert.equal(login.status,200)
  const cookie=login.headers.get('set-cookie').split(';')[0]
  const call=(route,init={})=>fixtureFetch(`${origin}${route}`,{...init,headers:{cookie,'content-type':'application/json'},signal:AbortSignal.timeout(30000)})
  observer=new AbortController()
  stream=await fixtureFetch(`${origin}/api/events?clientId=rune-interactive-observer&connectionId=observer`,{headers:{cookie},signal:observer.signal});assert.equal(stream.status,200)
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
  watchTask=watch().catch(error=>{if(!stopped&&error.name!=='AbortError')console.error('observer:',error.message)})
  guardTask=(async()=>{
    while(!stopped){
      try{
        const rows=await native.read(`/api/session?${new URLSearchParams({directory,limit:'200'})}`,{signal:observer.signal})
        for(const row of rows.data.filter(r=>!r.parentID&&!guarded.has(r.id))){
          assert.equal(row.location.directory.toLowerCase(),directory.toLowerCase())
          await native.read(`/api/session/${row.id}`,{method:'PATCH',body:JSON.stringify({permissions:deny}),signal:observer.signal})
          const readback=(await native.read(`/api/session/${row.id}`,{signal:observer.signal})).data;assert.deepEqual(readback.permissions,deny)
          guarded.add(row.id)
          if(row.title===newTitle&&!newID){newID=row.id;stats.newID=newID;await save();console.log(JSON.stringify({type:'INTERACTIVE_NEW_SESSION_GUARDED',session:newID}))}
        }
      }catch(error){if(!stopped&&error.name!=='AbortError')console.error('guard:',error.message)}
      try{await delay(1000,undefined,{signal:observer.signal})}catch{break}
    }
  })()
  await save();await writeFile(path.join(profile,'session.json'),JSON.stringify({profile,directory,sourceID:source.id,longID:fork.id,longTitle,newTitle}))
  child=launchFixture(clientBinary,[],{cwd:profile,redact:[native.password,'interactive-rune-owned-backend'],env:{...await privateEnvironment(profile),RUNE_BACKEND:`${origin}/`,RUNE_PASSWORD:'interactive-rune-owned-backend',RUNE_LOCALE:'fr',RUNE_LIVE_TITLE:'1'}})
  child.child.stderr.on('data',d=>console.error(String(d).trim()))
  console.log(JSON.stringify({type:'INTERACTIVE_READY',profile,directory,longTitle,newTitle,pid:await child.pid()}))
  assert.equal(await child.closed,0,child.output())
}finally{
  stopped=true;observer?.abort();void stream?.body?.cancel?.().catch(()=>{})
  await Promise.race([Promise.allSettled([watchTask,guardTask].filter(Boolean)),delay(2000,undefined,{ref:false})])
  try{await child?.stop()}finally{await server.stop()}
  await save();await writeFile(path.join(profile,'rust.log'),server.output())
}
},{denyAllTools:true})
