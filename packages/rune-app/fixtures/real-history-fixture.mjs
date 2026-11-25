// Real Rust backend and private OpenCode; fault injection affects only this client's SSE.
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {writeFile} from 'node:fs/promises'
import {createServer,request} from 'node:http'
import {setTimeout as delay} from 'node:timers/promises'
import path from 'node:path'
import {args,privateManifest,requirePrivateCli,withNative} from './live-access.mjs'
import {createAttestedFetch,createAttestedHttpAgent,createClientPidGate,RELAY_PLACEHOLDER_PASSWORD,relayTarget} from '../../../scripts/native-fixture-http.mjs'
import {launchFixture,rustOrigin} from './fixture-host.mjs'
import {requireTestSupport,clientBinary,serverBinary} from './fixture-binaries.mjs'
requirePrivateCli();requireTestSupport()
const manifest=await privateManifest(args[0])
assert.equal(manifest.seedCount,600)
await withNative(async native=>{
assert.equal(manifest.project,native.project)
const current=(await native.read(`/api/session/${manifest.sessionID}`)).data
assert.deepEqual(current.permissions,[{action:'*',resource:'*',effect:'deny'}])
const info=await native.read('/api/info')
const stats={nativeVersion:info.version??info.data?.version,prompts:0,cuts:0,nativeFragments:0,tools:0,terminals:0,sseConnections:0,lastOutcome:null}
const rustPassword=randomUUID()
const env={...native.runtimeEnv,CNRS_FIXTURE_URL:native.relay,CNRS_FIXTURE_PASSWORD:native.relayPassword,
  CNRS_SERVER_PASSWORD:rustPassword,CNRS_FIXTURE_STDIN_STOP:'1',GIT_CEILING_DIRECTORIES:manifest.profile}
const server=launchFixture(serverBinary,
  [path.dirname(manifest.project),path.join(manifest.profile,'real-backend.json'),'0','existing-opencode'],
  {cwd:manifest.profile,env,shutdown:'shutdown\n',redact:[native.password,rustPassword]})
native.allowRelayClient(server.pid(),server.closed)
let child,proxy,clientGate,observer,stream,watchTask,proxyError=null,rustFetch,rustAgent,relaySessionCookie=null
let result=1
try{
  const origin=await server.ready(rustOrigin)
  const rustPort=Number(new URL(origin).port)
  const rustPid=await server.pid()
  rustFetch=createAttestedFetch(origin,rustPort,rustPid)
  rustAgent=createAttestedHttpAgent(rustPort,rustPid)
  const login=await rustFetch(`${origin}/api/auth/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'codenomad',password:rustPassword}),signal:AbortSignal.timeout(15000)})
  assert.equal(login.status,200)
  const cookie=login.headers.get('set-cookie').split(';')[0]
  const call=(route,init={})=>rustFetch(`${origin}${route}`,{...init,headers:{cookie,'content-type':'application/json'},signal:AbortSignal.timeout(30000)})
  const opened=await call('/api/workspaces',{method:'POST',body:JSON.stringify({path:manifest.project})})
  const workspace=await opened.json();assert.equal(opened.status,201)
  const own=value=>value.type==='instance.event'&&value.instanceId===workspace.id&&value.event?.data?.sessionID===manifest.sessionID
  observer=new AbortController()
  const openTimer=setTimeout(()=>observer.abort(Error('SSE open timed out')),15000)
  try{stream=await rustFetch(`${origin}/api/events?clientId=real-history-observer&connectionId=observer`,{headers:{cookie},signal:observer.signal})}
  finally{clearTimeout(openTimer)}
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
  watchTask=watch().catch(error=>{if(!observer.signal.aborted&&error.name!=='AbortError')proxyError??=error})
  clientGate=createClientPidGate(()=>proxy.address()?.port)
  proxy=createServer(async(req,res)=>{
    try{
      const target=relayTarget(req,res,origin)
      if(!target)return
      req.pause()
      if(!(await clientGate.verify(req.socket))){
        req.resume()
        if(!res.destroyed&&!req.socket.destroyed){res.writeHead(403,{connection:'close'});res.end('Attested client PID required')}
        return
      }
      if(target.pathname.startsWith('/__real__/')){
        req.resume()
        if(req.method!=='GET'&&req.method!=='POST'){res.writeHead(405);res.end('GET or POST required');return}
        const action=target.pathname.slice('/__real__/'.length)
        let value=stats
        if(action==='expected'){
          const transfer=(await native.read(`/api/experimental/session/${manifest.sessionID}/export`)).data
          assert(transfer.messages.length<700,'owned test history bound')
          value={rows:transfer.messages.map(row=>({id:row.id,body:row.type==='user'?row.text:(row.content??[]).filter(p=>p.type==='text').map(p=>p.text).join('\n')}))}
        }
        res.setHeader('content-type','application/json');res.end(JSON.stringify(value));return
      }
      if(req.method==='POST'&&target.pathname===`/workspaces/${workspace.id}/instance/api/session/${manifest.sessionID}/prompt`)stats.prompts++
      if(req.method==='POST'&&target.pathname==='/api/auth/login'){
        const chunks=[];let total=0
        req.resume()
        for await(const chunk of req){total+=chunk.length;assert(total<65536,'login body too large');chunks.push(chunk)}
        const payload=JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if(payload?.password===RELAY_PLACEHOLDER_PASSWORD)payload.password=rustPassword
        const body=Buffer.from(JSON.stringify(payload))
        const headers={...req.headers,host:target.host,'content-length':String(body.length)}
        delete headers['transfer-encoding']
        const up=request(target,{agent:rustAgent,method:req.method,headers},response=>{
          const outHeaders={...response.headers}
          const rawSetCookie=outHeaders['set-cookie']
          if(rawSetCookie){
            const list=Array.isArray(rawSetCookie)?rawSetCookie:[rawSetCookie]
            const pairs=[],masked=[]
            for(const item of list){
              const [pair,...attrs]=item.split(';')
              const eq=pair.indexOf('=')
              if(eq>0){
                pairs.push(pair.trim())
                masked.push([`${pair.slice(0,eq).trim()}=fixture-relay-placeholder`,...attrs].join(';'))
              }
            }
            if(pairs.length){
              relaySessionCookie=pairs.join('; ')
              outHeaders['set-cookie']=masked
            }
          }
          res.writeHead(response.statusCode,outHeaders)
          response.on('close',()=>{if(!response.complete)res.destroy()})
          response.on('error',()=>res.destroy())
          response.pipe(res)
        })
        up.on('error',()=>{if(!res.headersSent)res.writeHead(503);res.end()});res.on('close',()=>up.destroy())
        up.end(body)
        return
      }
      const forwardHeaders={...req.headers,host:target.host}
      if(relaySessionCookie)forwardHeaders.cookie=relaySessionCookie
      const up=request(target,{agent:rustAgent,method:req.method,headers:forwardHeaders},async response=>{
        res.writeHead(response.statusCode,response.headers)
        if(target.pathname!=='/api/events'){
          response.on('close',()=>{if(!response.complete)res.destroy()})
          response.on('error',()=>res.destroy())
          response.pipe(res)
          return
        }
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
      up.on('error',()=>{if(!res.headersSent)res.writeHead(503);res.end()});res.on('close',()=>up.destroy())
      if(req.readableEnded)up.end()
      else req.pipe(up)
    }catch(error){
      proxyError??=error
      if(!res.headersSent)res.writeHead(500)
      res.end()
    }
  })
  await new Promise(r=>proxy.listen(0,'127.0.0.1',r))
  const base=`http://127.0.0.1:${proxy.address().port}/`
  child=launchFixture(clientBinary,['--probe-real-history'],
    {cwd:manifest.profile,env:{...native.runtimeEnv,RUNE_BACKEND:base,
      RUNE_WORKSPACE:workspace.id,RUNE_SESSION:manifest.sessionID,RUNE_PASSWORD:RELAY_PLACEHOLDER_PASSWORD,RUNE_TEST_CONTROL:`${base}__real__/`},
      redact:[native.password,rustPassword]})
  clientGate.allow(child.pid(),child.closed)
  result=await Promise.race([child.closed,delay(120000,124,{ref:false})])
  if(result===124)await child.stop()
  process.stdout.write(child.output())
  if(proxyError)throw proxyError
  assert.equal(result,0,'real history probe failed')
  console.log(JSON.stringify({fixture:'real-rust-real-opencode-history',result:'ok',...stats}))
}finally{
  observer?.abort();void stream?.body?.cancel?.().catch(()=>{})
  if(watchTask)await Promise.race([watchTask,delay(2000,undefined,{ref:false})])
  try{await child?.stop()}finally{
    clientGate?.close()
    proxy?.closeAllConnections();proxy?.close()
    rustAgent?.destroy()
    try{await rustFetch?.close()}finally{await server.stop()}
  }
  await writeFile(path.join(manifest.profile,'real-backend.log'),server.output())
}
process.exitCode=result??1
},{profile:manifest.profile})
