// Real Rust backend and real existing OpenCode service; fault injection affects only this client's SSE.
import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import {createServer,request} from 'node:http'
import {spawn} from 'node:child_process'
import path from 'node:path'
import {connectNative} from './live-access.mjs'
import {privateEnvironment} from './private-profile.mjs'
import {requireTestSupport,clientBinary,serverBinary} from './fixture-binaries.mjs'
requireTestSupport()
const here=import.meta.dirname
const file=path.resolve(process.argv[2]??'')
assert(file.startsWith(path.join(here,'fixture-profile')+path.sep),'owned manifest required')
const manifest=JSON.parse(await readFile(file,'utf8'))
assert.equal(manifest.seedCount,600)
const native=await connectNative()
const current=(await native.read(`/api/session/${manifest.sessionID}`)).data
assert.deepEqual(current.permissions,[{action:'*',resource:'*',effect:'deny'}])
const info=await native.read('/api/info')
const stats={nativeVersion:info.version??info.data?.version,prompts:0,cuts:0,nativeFragments:0,tools:0,terminals:0,sseConnections:0,lastOutcome:null}
const env={...await privateEnvironment(manifest.profile),CNRS_FIXTURE_URL:native.origin,CNRS_FIXTURE_PASSWORD:native.password,
  CNRS_SERVER_PASSWORD:'real-history-private-backend',CNRS_FIXTURE_STDIN_STOP:'1',GIT_CEILING_DIRECTORIES:manifest.profile}
const server=spawn(serverBinary,
  [path.dirname(manifest.project),path.join(manifest.profile,'real-backend.json'),'0','existing-opencode'],
  {cwd:manifest.profile,env,windowsHide:true,stdio:['pipe','pipe','pipe']})
let log='',child,proxy,observer
server.stdout.on('data',d=>log+=d);server.stderr.on('data',d=>log+=d)
let result=1
try{
  let origin
  for(const end=Date.now()+20000;!origin;){assert(Date.now()<end&&server.exitCode===null,'Rust startup');origin=log.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];if(!origin)await new Promise(r=>setTimeout(r,100))}
  const login=await fetch(`${origin}/api/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'codenomad',password:'real-history-private-backend'})})
  assert.equal(login.status,200)
  const cookie=login.headers.get('set-cookie').split(';')[0]
  const call=(route,init={})=>fetch(`${origin}${route}`,{...init,headers:{cookie,'content-type':'application/json'},signal:AbortSignal.timeout(30000)})
  const opened=await call('/api/workspaces',{method:'POST',body:JSON.stringify({path:manifest.project})})
  const workspace=await opened.json();assert.equal(opened.status,201)
  const own=value=>value.type==='instance.event'&&value.instanceId===workspace.id&&value.event?.data?.sessionID===manifest.sessionID
  observer=new AbortController()
  const stream=await fetch(`${origin}/api/events?clientId=real-history-observer&connectionId=observer`,{headers:{cookie},signal:observer.signal})
  assert.equal(stream.status,200)
  async function watch(){
    let buffer='';const decoder=new TextDecoder()
    for await(const chunk of stream.body){buffer+=decoder.decode(chunk,{stream:true});let index
      while((index=buffer.indexOf('\n\n'))>=0){
        const block=buffer.slice(0,index);buffer=buffer.slice(index+2)
        if(block.includes('event: codenomad.client.ping')){await call('/api/client-connections/pong',{method:'POST',body:JSON.stringify({clientId:'real-history-observer',connectionId:'observer'})});continue}
        const raw=block.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5)).join('\n');if(!raw)continue
        const value=JSON.parse(raw);if(!own(value))continue
        const type=value.event.type
        if(type==='session.text.delta')stats.nativeFragments++
        if(type.startsWith('session.tool.'))stats.tools++
        if(['session.execution.succeeded','session.execution.failed','session.execution.interrupted'].includes(type)){
          stats.terminals++;stats.lastOutcome=type;console.log(JSON.stringify({type:'REAL_HISTORY_TERMINAL',...stats}))
        }
      }
    }
  }
  watch().catch(error=>{if(error.name!=='AbortError')console.error(`observer: ${error.message}`)})
  proxy=createServer(async(req,res)=>{
    if(req.url.startsWith('/__real__/')){
      const action=req.url.slice('/__real__/'.length)
      let value=stats
      if(action==='expected'){
        const transfer=(await native.read(`/api/experimental/session/${manifest.sessionID}/export`)).data
        assert(transfer.messages.length<700,'owned test history bound')
        value={rows:transfer.messages.map(row=>({id:row.id,body:row.type==='user'?row.text:(row.content??[]).filter(p=>p.type==='text').map(p=>p.text).join('\n')}))}
      }
      res.setHeader('content-type','application/json');res.end(JSON.stringify(value));return
    }
    if(req.method==='POST'&&req.url===`/workspaces/${workspace.id}/instance/api/session/${manifest.sessionID}/prompt`)stats.prompts++
    const target=new URL(req.url,origin)
    const up=request(target,{method:req.method,headers:{...req.headers,host:target.host}},async response=>{
      res.writeHead(response.statusCode,response.headers)
      if(!req.url.startsWith('/api/events?')){response.pipe(res);return}
      stats.sseConnections++;let buffer='',delivered=0;const decoder=new TextDecoder()
      try{
        for await(const chunk of response){buffer+=decoder.decode(chunk,{stream:true});let index
          while((index=buffer.indexOf('\n\n'))>=0){
            const block=buffer.slice(0,index);buffer=buffer.slice(index+2)
            res.write(`${block}\n\n`)
            const raw=block.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5)).join('\n')
            if(raw){const value=JSON.parse(raw);if(own(value)&&value.event.type==='session.text.delta')delivered++}
            if(stats.cuts===0&&delivered>=2){
              stats.cuts++;console.log(JSON.stringify({type:'REAL_HISTORY_CLIENT_SSE_CUT',deliveredFragments:delivered,terminalSeen:stats.terminals}))
              // Let the two delivered frames flush; close only the owned Rune subscriber.
              await new Promise(r=>setTimeout(r,20));res.destroy();up.destroy();return
            }
          }
        }
        res.end()
      }catch{res.destroy()}
    })
    up.on('error',()=>{if(!res.headersSent)res.writeHead(503);res.end()});res.on('close',()=>up.destroy());req.pipe(up)
  })
  await new Promise(r=>proxy.listen(0,'127.0.0.1',r))
  const base=`http://127.0.0.1:${proxy.address().port}/`
  child=spawn(clientBinary,['--probe-real-history'],
    {cwd:manifest.profile,windowsHide:true,stdio:'inherit',env:{...await privateEnvironment(manifest.profile),RUNE_BACKEND:base,
      RUNE_WORKSPACE:workspace.id,RUNE_SESSION:manifest.sessionID,RUNE_PASSWORD:'real-history-private-backend',RUNE_TEST_CONTROL:`${base}__real__/`}})
  result=await new Promise((resolve,reject)=>{child.on('exit',resolve);child.on('error',reject)})
  assert.equal(result,0,'real history probe failed')
  console.log(JSON.stringify({fixture:'real-rust-real-opencode-history',result:'ok',...stats}))
}finally{
  observer?.abort();if(child?.exitCode===null)child.kill()
  proxy?.closeAllConnections();proxy?.close()
  server.stdin.write('shutdown\n')
  await Promise.race([new Promise(r=>server.on('exit',r)),new Promise(r=>setTimeout(r,5000))])
  if(server.exitCode===null)server.kill()
  await writeFile(path.join(manifest.profile,'real-backend.log'),log)
}
process.exitCode=result??1
