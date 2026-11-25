import assert from 'node:assert/strict'
import {execFile,spawn} from 'node:child_process'
import {Agent,createServer,request} from 'node:http'
import net from 'node:net'
import {test} from 'node:test'
import {promisify} from 'node:util'
import {createAttestedFetch,createAttestedHttpAgent,createAttestedRelay,createAttestedTcpRelay,createStreamRedactor,fixtureFetch,relayTarget,verifyLoopbackConnectionPeer,withoutFixtureProxy} from '../../../scripts/native-fixture-http.mjs'
import {sseReader} from '../../../scripts/perf/lib.mjs'

async function listen(t,handler){
  const server=createServer(handler)
  t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve))})
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)})
  return {server,origin:`http://127.0.0.1:${server.address().port}`}
}

test('absolute foreign and blob targets receive a 403 without contacting the upstream',{timeout:15000},async t=>{
  let forwarded=0
  const base='http://127.0.0.1:42395'
  const {origin}=await listen(t,(req,res)=>{
    if(!relayTarget(req,res,base))return
    forwarded++;res.end('allowed')
  })
  const agent=new Agent()
  t.after(()=>agent.destroy())
  const status=target=>new Promise((resolve,reject)=>{
    const req=request(origin,{path:target,agent,signal:AbortSignal.timeout(10000)},res=>{res.resume();resolve(res.statusCode)})
    req.once('error',reject);req.end()
  })
  assert.equal(await status('http://foreign.invalid/private'),403)
  // Node's HTTP parser may reject non-HTTP request targets before the relay sees them.
  // Exercise the actual relay guard as well: a blob URL reports the same origin as base.
  let refused
  assert.equal(relayTarget({url:`blob:${base}/same-origin`},{
    writeHead(code){refused=code},end(){},
  },base),null)
  assert.equal(refused,403)
  assert.equal(forwarded,0)
  assert.equal(await status('/api/info'),200)
  assert.equal(forwarded,1)
})

test('an active environment proxy cannot see fixture authentication or redirects',{timeout:20000},async t=>{
  let proxyHits=0, targetHits=0
  const proxy=await listen(t,(_req,res)=>{proxyHits++;res.end('proxy')})
  proxy.server.on('connect',(_req,socket)=>{proxyHits++;socket.end('HTTP/1.1 502 Refused\r\n\r\n')})
  const target=await listen(t,(req,res)=>{
    targetHits++
    if(req.url==='/redirect'){res.writeHead(302,{location:proxy.origin});res.end();return}
    res.end(req.headers.authorization??'')
  })
  const source=new URL('../../../scripts/native-fixture-http.mjs',import.meta.url).href
  const code=`
    import assert from 'node:assert/strict'
    import {request} from 'node:http'
    import {fixtureFetch,fixtureHttpAgent} from ${JSON.stringify(source)}
    const [target,proxy]=process.argv.slice(1)
    const hit=(url,options)=>new Promise((resolve,reject)=>{
      const req=request(url,options,res=>{
        let text='';res.setEncoding('utf8');res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve(text))
      });req.on('error',reject);req.end()
    })
    assert.equal(await hit(target,{}),'proxy','Control: the global agent honours the environment')
    const headers={authorization:'fixture-only'}
    assert.equal(await hit(target,{headers,agent:fixtureHttpAgent}),'fixture-only')
    assert.equal(await (await fixtureFetch(new Request(target,{headers}))).text(),'fixture-only')
    await assert.rejects(fixtureFetch(target+'/redirect',{headers}))
  `
  await promisify(execFile)(process.execPath,['--use-env-proxy','--input-type=module','-e',code,target.origin,proxy.origin],{
    env:{...withoutFixtureProxy(process.env),HTTP_PROXY:proxy.origin,HTTPS_PROXY:proxy.origin,NO_PROXY:''},
    windowsHide:true,timeout:15000,
  })
  assert.equal(proxyHits,1)
  assert.equal(targetHits,3)
  assert.deepEqual(withoutFixtureProxy({Path:'x',http_proxy:'a',HTTPS_PROXY:'b',No_Proxy:'c',ALL_PROXY:'d',NODE_USE_ENV_PROXY:'1'}),{Path:'x'})
})

test('sseReader bounds silent opens and cancels an idle open SSE body cleanly',{timeout:15000},async t=>{
  const silent=await listen(t,(_req,_res)=>{})
  const sendSilent=(route,init)=>fixtureFetch(new URL(route,silent.origin),init)
  await assert.rejects(sseReader(sendSilent,()=>{},250),/AbortError|SSE open timed out/)

  let received=0,gotFrame,serverClosed
  const firstFrame=new Promise(resolve=>{gotFrame=resolve})
  const closed=new Promise(resolve=>{serverClosed=resolve})
  const idle=await listen(t,(req,res)=>{
    req.on('close',serverClosed)
    res.on('close',serverClosed)
    res.writeHead(200,{'content-type':'text/event-stream'})
    res.write('data: {"type":"server.connected"}\n\n')
  })
  const sendIdle=(route,init)=>fixtureFetch(new URL(route,idle.origin),init)
  const stop=await sseReader(sendIdle,()=>{received++;gotFrame()},5000)
  await Promise.race([firstFrame,new Promise((_,reject)=>setTimeout(()=>reject(Error('missing SSE frame')),3000))])
  assert.equal(received,1)
  await stop()
  await Promise.race([closed,new Promise((_,reject)=>setTimeout(()=>reject(Error('SSE socket did not close on server')),3000))])
})

test('createAttestedFetch serves concurrent POST while an SSE stream stays open and closes immediately',{timeout:15000},async t=>{
  let ownerChecks=0,peerChecks=0,markSseClosed
  const sseClosedOnServer=new Promise(resolve=>{markSseClosed=resolve})
  const srv=await listen(t,(req,res)=>{
    if(req.url==='/api/event'){
      req.on('close',markSseClosed)
      res.on('close',markSseClosed)
      res.writeHead(200,{'content-type':'text/event-stream'})
      res.write('data: {"type":"server.connected"}\n\n')
      return
    }
    if(req.method==='POST'&&req.url==='/api/session'){
      res.writeHead(200,{'content-type':'application/json'})
      res.end(JSON.stringify({id:'ses_concurrent'}))
      return
    }
    res.writeHead(404);res.end()
  })
  const port=Number(new URL(srv.origin).port)
  const bound=createAttestedFetch(srv.origin,port,process.pid,async()=>{ownerChecks++},async(localPort,remotePort,pid)=>{
    peerChecks++
    await verifyLoopbackConnectionPeer(localPort,remotePort,pid)
  })
  try{
    const sse=await bound(new URL('/api/event',srv.origin),{signal:AbortSignal.timeout(5000)})
    assert.equal(sse.status,200)
    const post=await bound(new URL('/api/session',srv.origin),{method:'POST',body:'{}',signal:AbortSignal.timeout(5000)})
    assert.equal(post.status,200)
    assert.deepEqual(await post.json(),{id:'ses_concurrent'})
    assert(ownerChecks>=2,'each opened socket must verify listener ownership before connect')
    assert(peerChecks>=2,'each opened socket must verify peer ownership after connect')
    const closingAt=Date.now()
    await bound.close()
    await Promise.race([sseClosedOnServer,new Promise((_,reject)=>setTimeout(()=>reject(Error('SSE socket did not close promptly on server')),1000))])
    assert(Date.now()-closingAt<1000,'bound.close() must terminate active SSE sockets immediately')
  }finally{await bound.close()}
})

test('verifyLoopbackConnectionPeer rejects live foreign and dead PIDs, and attested pool/agent/relay close cleanly',{timeout:15000},async t=>{
  const srv=await listen(t,(_req,res)=>{res.writeHead(200);res.end('ok')})
  const port=Number(new URL(srv.origin).port)
  const socket=net.createConnection({host:'127.0.0.1',port})
  t.after(()=>socket.destroy())
  await new Promise((resolve,reject)=>{socket.once('connect',resolve);socket.once('error',reject)})
  await verifyLoopbackConnectionPeer(socket.localPort,port,process.pid)
  // Live foreign process: exercises actual /proc/<pid>/fd mismatch on Linux as well as Windows/macOS.
  const foreign=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true})
  t.after(()=>{try{foreign.kill('SIGKILL')}catch{}})
  await new Promise((resolve,reject)=>{foreign.once('spawn',resolve);foreign.once('error',reject)})
  await assert.rejects(verifyLoopbackConnectionPeer(socket.localPort,port,foreign.pid),/not owned by fixture PID/)
  foreign.kill('SIGKILL')
  await new Promise(resolve=>foreign.once('close',resolve))
  // Dead PID: Linux must also convert missing /proc/<pid>/fd into the same ownership error.
  await assert.rejects(verifyLoopbackConnectionPeer(socket.localPort,port,foreign.pid),/not owned by fixture PID/)

  let peerEntered,releasePeer
  const inPeer=new Promise(resolve=>{peerEntered=resolve})
  const peerGate=new Promise(resolve=>{releasePeer=resolve})
  const bound=createAttestedFetch(srv.origin,port,process.pid,async()=>{},async()=>{peerEntered();await peerGate})
  const pending=bound(new URL('/',srv.origin))
  await inPeer
  await bound.close()
  releasePeer()
  await assert.rejects(pending,error=>/closed|destroyed|Attested/i.test(error?.cause?.message??error?.message??''))

  // Attested HTTP agent settles pending callbacks when destroyed mid-attestation.
  let agentEntered,releaseAgent
  const agentInPeer=new Promise(resolve=>{agentEntered=resolve})
  const agentGate=new Promise(resolve=>{releaseAgent=resolve})
  const agent=createAttestedHttpAgent(port,process.pid,async()=>{},async()=>{agentEntered();await agentGate})
  const agentReq=new Promise((resolve,reject)=>{
    const req=request(srv.origin,{agent},res=>{res.resume();resolve(res.statusCode)})
    req.once('error',reject)
    req.end()
  })
  await agentInPeer
  agent.destroy()
  releaseAgent()
  await assert.rejects(agentReq,/closed|Attested|hang up/i)

  // Attested relay validates relay token, injects real Authorization, refuses 3xx redirects, propagates upstream aborts, and closes cleanly.
  let relayMode='ok'
  let seenAuth=null
  const relayTargetSrv=await listen(t,(req,res)=>{
    seenAuth=req.headers.authorization??null
    if(relayMode==='redirect'){res.writeHead(302,{location:'http://127.0.0.1:4096/secret'});res.end();return}
    if(relayMode==='abort'){res.writeHead(200,{'content-length':'100'});res.write('partial',()=>setTimeout(()=>req.socket.destroy(),10));return}
    res.writeHead(200);res.end('ok')
  })
  const relay=await createAttestedRelay(relayTargetSrv.origin,process.pid,{
    expectAuthorization:'Basic relay-token',
    injectAuthorization:'Basic real-upstream-secret',
  })
  try{
    const unauth=await fixtureFetch(new URL('/hello',relay.origin),{signal:AbortSignal.timeout(5000)})
    assert.equal(unauth.status,401)
    assert.equal(seenAuth,null)
    const res=await fixtureFetch(new URL('/hello',relay.origin),{headers:{authorization:'Basic relay-token'},signal:AbortSignal.timeout(5000)})
    assert.equal(res.status,200)
    assert.equal(await res.text(),'ok')
    assert.equal(seenAuth,'Basic real-upstream-secret')
    relayMode='redirect'
    const redirected=await fixtureFetch(new URL('/redirect',relay.origin),{headers:{authorization:'Basic relay-token'},signal:AbortSignal.timeout(5000)})
    assert.equal(redirected.status,502)
    relayMode='abort'
    await assert.rejects(
      fixtureFetch(new URL('/abort',relay.origin),{headers:{authorization:'Basic relay-token'},signal:AbortSignal.timeout(5000)}).then(r=>r.text()),
    )
  }finally{await relay.close()}
})

test('resolveWorktreePackage refuses parent or external node_modules',{timeout:15000},async t=>{
  const {mkdtemp,mkdir,rm,writeFile}=await import('node:fs/promises')
  const os=await import('node:os')
  const path=await import('node:path')
  const {resolveWorktreePackage}=await import('../../../scripts/native-fixture-http.mjs')
  const external=await mkdtemp(path.join(os.tmpdir(),'codenomad-ext-nm-'))
  t.after(()=>rm(external,{recursive:true,force:true}))
  const extNm=path.join(external,'node_modules')
  await mkdir(path.join(extNm,'fake-pkg'),{recursive:true})
  await writeFile(path.join(extNm,'fake-pkg','package.json'),JSON.stringify({name:'fake-pkg',main:'index.js'}))
  await writeFile(path.join(extNm,'fake-pkg','index.js'),'module.exports={}')
  assert.throws(()=>resolveWorktreePackage('fake-pkg',extNm),/outside repository boundary/)
})

test('acquireProfileLock serializes concurrent stale recovery and reclaims aged empty locks',{timeout:15000},async t=>{
  const {mkdtemp,rm,unlink,utimes,writeFile}=await import('node:fs/promises')
  const os=await import('node:os')
  const path=await import('node:path')
  const {acquireProfileLock}=await import('./live-access.mjs')
  const dir=await mkdtemp(path.join(os.tmpdir(),'codenomad-lock-test-'))
  t.after(()=>rm(dir,{recursive:true,force:true}))
  const lockPath=path.join(dir,'running.lock')
  // Stale lock owned by a dead process: two concurrent contenders must produce exactly one winner.
  await writeFile(lockPath,JSON.stringify({pid:999999999,startedAt:Date.now()-60_000}))
  const results=await Promise.allSettled([acquireProfileLock(lockPath),acquireProfileLock(lockPath)])
  const winners=results.filter(r=>r.status==='fulfilled')
  const losers=results.filter(r=>r.status==='rejected')
  assert.equal(winners.length,1,'exactly one concurrent contender may reclaim a stale lock')
  assert.equal(losers.length,1,'second contender must fail while the reclaimed lock is held')
  await winners[0].value.close()
  await unlink(lockPath)
  // Aged empty lock (crash between file creation and write): must be reclaimed once older than 2s.
  await writeFile(lockPath,'')
  const old=new Date(Date.now()-5000)
  await utimes(lockPath,old,old)
  const reclaimed=await acquireProfileLock(lockPath)
  await reclaimed.close()
  await unlink(lockPath)
  // Dead launcher PID with a still-alive daemon PID must block takeover until daemon exits.
  const survivor=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true})
  t.after(()=>{try{survivor.kill('SIGKILL')}catch{}})
  await new Promise((resolve,reject)=>{survivor.once('spawn',resolve);survivor.once('error',reject)})
  await writeFile(lockPath,JSON.stringify({pid:999999999,daemonPid:survivor.pid,nonce:'stale-launcher'}))
  await assert.rejects(acquireProfileLock(lockPath),error=>error.code==='EEXIST')
  survivor.kill('SIGKILL')
  await new Promise(resolve=>survivor.once('close',resolve))
  const afterDaemonExit=await acquireProfileLock(lockPath)
  await afterDaemonExit.close()
  await unlink(lockPath)
})

test('createStreamRedactor redacts split secrets and never leaks partial secret prefixes via peek',{timeout:10000},()=>{
  const secret='fixture-secret-value-9876'
  const basic=Buffer.from(`opencode:${secret}`).toString('base64')
  const r=createStreamRedactor([secret])
  let out=''
  out+=r.push('server listening on http://127.0.0.1:54321\n')
  assert.equal((out+r.peek()).includes('server listening on http://127.0.0.1:54321\n'),true)
  out+=r.push('auth=fixture-secret-')
  const peeked=out+r.peek()
  assert.equal(peeked.includes('fixture-secret-'),false,'peek must not leak a partial secret prefix')
  out+=r.push('value-9876 next ')
  out+=r.push(basic.slice(0,12))
  assert.equal((out+r.peek()).includes(basic.slice(0,12)),false,'peek must not leak a partial base64 credential prefix')
  out+=r.push(basic.slice(12))
  out+=r.flush()
  assert.equal(out.includes(secret),false)
  assert.equal(out.includes(basic),false)
  assert.equal(out.split('<fixture password>').length-1,2)
  // Truncated stream ending mid-secret must not leak the partial prefix on flush().
  const truncated=createStreamRedactor([secret])
  let tOut=truncated.push('cut=fixture-secret-val')
  tOut+=truncated.flush()
  assert.equal(tOut.includes('fixture-secret'),false,'flush must redact truncated trailing secret prefix')
  assert.equal(tOut.includes('<truncated>'),true)
})

test('createAttestedRelay client PID attestation, revocation, and createAttestedTcpRelay enforce OS peer identity',{timeout:20000},async t=>{
  let seenAuth=null
  const target=await listen(t,(req,res)=>{seenAuth=req.headers.authorization??null;res.end('ok')})
  const relay=await createAttestedRelay(target.origin,process.pid,{
    requireClientAttestation:true,
    injectAuthorization:'Basic real-secret',
  })
  t.after(()=>relay.close())
  // Without allowing process.pid (empty allowlist), the relay rejects with 403 before touching upstream.
  const deniedEmpty=await fixtureFetch(new URL('/denied-empty',relay.origin),{signal:AbortSignal.timeout(5000)})
  assert.equal(deniedEmpty.status,403)
  assert.equal(seenAuth,null)
  // With a non-empty foreign allowlist, process.pid is still rejected with 403.
  relay.allowClientPid(999999999)
  const deniedForeign=await fixtureFetch(new URL('/denied-foreign',relay.origin),{signal:AbortSignal.timeout(5000)})
  assert.equal(deniedForeign.status,403)
  assert.equal(seenAuth,null)
  // Allow process.pid tied to a lifecycle exit promise; verify allowed then revoked on exit.
  const clientExit=Promise.withResolvers()
  relay.allowClientPid(process.pid,clientExit.promise)
  const allowed=await fixtureFetch(new URL('/allowed',relay.origin),{signal:AbortSignal.timeout(5000)})
  assert.equal(allowed.status,200)
  assert.equal(await allowed.text(),'ok')
  assert.equal(seenAuth,'Basic real-secret')
  seenAuth=null
  clientExit.resolve()
  await new Promise(resolve=>setTimeout(resolve,50))
  const revoked=await fixtureFetch(new URL('/after-exit',relay.origin),{signal:AbortSignal.timeout(5000)})
  assert.equal(revoked.status,403)
  assert.equal(seenAuth,null)
  // TCP relay with client PID attestation rejects foreign clients and admits process.pid.
  const tcpDenied=await createAttestedTcpRelay(target.server.address().port,process.pid,{
    requireClientAttestation:true,
    allowedClientPids:[999999999],
  })
  t.after(()=>tcpDenied.close())
  await assert.rejects(fixtureFetch(`http://127.0.0.1:${tcpDenied.port}/tcp-denied`,{signal:AbortSignal.timeout(5000)}))
  const tcpRelay=await createAttestedTcpRelay(target.server.address().port,process.pid,{
    requireClientAttestation:true,
    allowedClientPids:[process.pid],
  })
  t.after(()=>tcpRelay.close())
  const viaTcp=await fixtureFetch(`http://127.0.0.1:${tcpRelay.port}/tcp`,{signal:AbortSignal.timeout(5000)})
  assert.equal(viaTcp.status,200)
  assert.equal(await viaTcp.text(),'ok')
})

test('createAttestedRelay isolates cookies strictly to placeholder headers and clientGate fences in-flight allow after close',{timeout:15000},async t=>{
  const {createClientPidGate}=await import('../../../scripts/native-fixture-http.mjs')
  const seenCookies=[]
  const target=await listen(t,(req,res)=>{
    seenCookies.push(req.headers.cookie??null)
    if(req.url==='/login')res.setHeader('set-cookie','codenomad_session=real-secret-token; Path=/; HttpOnly')
    res.end('ok')
  })
  const relay=await createAttestedRelay(target.origin,process.pid,{
    requireClientAttestation:true,
    isolateSessionCookie:true,
  })
  t.after(()=>relay.close())
  relay.allowClientPid(process.pid)
  const loginRes=await fixtureFetch(new URL('/login',relay.origin),{signal:AbortSignal.timeout(5000)})
  assert.equal(loginRes.status,200)
  assert.match(loginRes.headers.get('set-cookie')??'',/codenomad_session=fixture-relay-placeholder/)
  // Unauthenticated request (no Cookie header) must NOT receive the real session cookie.
  const noCookieRes=await fixtureFetch(new URL('/unauth',relay.origin),{signal:AbortSignal.timeout(5000)})
  assert.equal(noCookieRes.status,200)
  assert.equal(seenCookies.at(-1),null)
  // Request carrying the placeholder cookie receives the real session cookie upstream.
  const withPlaceholder=await fixtureFetch(new URL('/auth',relay.origin),{
    headers:{cookie:'codenomad_session=fixture-relay-placeholder'},
    signal:AbortSignal.timeout(5000),
  })
  assert.equal(withPlaceholder.status,200)
  assert.equal(seenCookies.at(-1),'codenomad_session=real-secret-token')
  // 1) Closing clientGate invalidates an in-flight allow() and refuses sockets.
  const net=await import('node:net')
  const probeServer=net.createServer()
  await new Promise(resolve=>probeServer.listen(0,'127.0.0.1',resolve))
  const openSockets=[]
  t.after(async()=>{
    for(const s of openSockets){try{s.destroy()}catch{}}
    await new Promise(resolve=>probeServer.close(resolve))
  })
  const accepted=new Promise(resolve=>probeServer.once('connection',resolve))
  const clientSock=net.createConnection({host:'127.0.0.1',port:probeServer.address().port})
  const serverSock=await accepted
  openSockets.push(clientSock,serverSock)
  const gate=createClientPidGate(()=>probeServer.address().port)
  const deferredPid=Promise.withResolvers()
  const allowTask=gate.allow(deferredPid.promise)
  gate.close()
  deferredPid.resolve(process.pid)
  await allowTask
  assert.equal(await gate.verify(serverSock),false)

  // 2) An active verified socket is torn down when exitPromise rejects (and produces no unhandled rejection).
  const gate2=createClientPidGate(()=>probeServer.address().port)
  t.after(()=>gate2.close())
  const exitDeferred=Promise.withResolvers()
  await gate2.allow(process.pid,exitDeferred.promise)
  assert.equal(await gate2.verify(serverSock),true)
  const destroyed=new Promise(resolve=>serverSock.once('close',resolve))
  exitDeferred.reject(new Error('expected exit rejection'))
  await destroyed
  assert.equal(await gate2.verify(serverSock),false)

  // 3) Recycled PID (new OS startId on fresh probe) is rejected on new socket admission.
  let fakeStartId='incarnation-1'
  const gate3=createClientPidGate(()=>probeServer.address().port,undefined,{
    probeIdentity:async()=>({status:'ok',identity:{ppid:process.ppid,startId:fakeStartId,createdAt:1n}}),
  })
  t.after(()=>gate3.close())
  await gate3.allow(process.pid)
  const accepted2=new Promise(resolve=>probeServer.once('connection',resolve))
  const clientSock2=net.createConnection({host:'127.0.0.1',port:probeServer.address().port})
  const serverSock2=await accepted2
  openSockets.push(clientSock2,serverSock2)
  assert.equal(await gate3.verify(serverSock2),true)
  fakeStartId='incarnation-2'
  const accepted3=new Promise(resolve=>probeServer.once('connection',resolve))
  const clientSock3=net.createConnection({host:'127.0.0.1',port:probeServer.address().port})
  const serverSock3=await accepted3
  openSockets.push(clientSock3,serverSock3)
  assert.equal(await gate3.verify(serverSock3),false)
})

test('createAttestedTcpRelay rotates between valid targets, parseWindowsCommandLine handles quoting, and provenance + worktree checks enforce exact boundaries',{timeout:20000},async t=>{
  const {mkdir,mkdtemp,rm,writeFile}=await import('node:fs/promises')
  const os=await import('node:os')
  const path=await import('node:path')
  const {
    parseWindowsCommandLine,
    sameWorktreeRepoAndManifests,
    verifyPrivateFixtureServer,
  }=await import('../../../scripts/native-fixture-http.mjs')

  // parseWindowsCommandLine: spaces, quotes, escaped quotes, backslashes, Unicode.
  assert.deepEqual(
    parseWindowsCommandLine('"C:\\Program Files\\node.exe" --config "D:\\tmp\\café dir\\config.yaml" --arg "a\\"b\\\\" plain'),
    ['C:\\Program Files\\node.exe','--config','D:\\tmp\\café dir\\config.yaml','--arg','a"b\\','plain'],
  )

  // createAttestedTcpRelay: rotate from one valid server PID to a second valid server PID.
  const targetA=await listen(t,(_req,res)=>{res.end('from-A')})
  const targetPort=Number(new URL(targetA.origin).port)
  let activeOwner=process.pid
  const relay=await createAttestedTcpRelay(targetPort,process.pid,{
    verifyOwner:async(port,pid)=>{assert.equal(port,targetPort);assert.equal(pid,activeOwner)},
    verifyPeer:async(_local,remote,pid)=>{assert.equal(remote,targetPort);assert.equal(pid,activeOwner)},
  })
  t.after(()=>relay.close())
  const resA=await fixtureFetch(`http://127.0.0.1:${relay.port}/a`,{signal:AbortSignal.timeout(5000)})
  assert.equal(resA.status,200)
  assert.equal(await resA.text(),'from-A')
  // Rotating to a mismatched PID fails; rotating to a second valid PID succeeds.
  relay.setTargetPid(999999999)
  await assert.rejects(fixtureFetch(`http://127.0.0.1:${relay.port}/mismatch`,{signal:AbortSignal.timeout(3000)}))
  activeOwner=424242
  relay.setTargetPid(activeOwner)
  const resB=await fixtureFetch(`http://127.0.0.1:${relay.port}/b`,{signal:AbortSignal.timeout(5000)})
  assert.equal(resB.status,200)
  assert.equal(await resB.text(),'from-A')
  await relay.close()
  await relay.close() // idempotent close

  // verifyPrivateFixtureServer: positive child with canonical --config and --workspace-root vs neighbor prefix & unrelated arg.
  const tmpRoot=await mkdtemp(path.join(os.tmpdir(),'codenomad-prov-'))
  t.after(()=>rm(tmpRoot,{recursive:true,force:true}))
  const profile=path.join(tmpRoot,'launcher-café 1')
  const neighbor=path.join(tmpRoot,'launcher-café 1-neighbor')
  await mkdir(path.join(profile,'workspace'),{recursive:true})
  await mkdir(path.join(neighbor,'workspace'),{recursive:true})
  const dummyScript=path.join(tmpRoot,'dummy-server.mjs')
  await writeFile(dummyScript,'console.log("READY"); setInterval(() => {}, 1000)\n')
  const spawnDummy=args=>new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[dummyScript,...args],{stdio:['ignore','pipe','pipe'],windowsHide:true})
    child.once('error',reject)
    child.stdout.once('data',()=>resolve(child))
  })
  const good=await spawnDummy(['--config',path.join(profile,'config.yaml'),'--workspace-root',path.join(profile,'workspace')])
  const badNeighbor=await spawnDummy(['--config',path.join(neighbor,'config.yaml'),'--workspace-root',path.join(neighbor,'workspace')])
  const badUnrelated=await spawnDummy(['--note',profile])
  t.after(()=>{good.kill();badNeighbor.kill();badUnrelated.kill()})
  const verified=await verifyPrivateFixtureServer({targetPid:good.pid,launcherPid:process.pid,profile})
  assert.equal(verified.targetPid,good.pid)
  assert(verified.targetStartId)
  await assert.rejects(verifyPrivateFixtureServer({targetPid:badNeighbor.pid,launcherPid:process.pid,profile}),/canonically confined/i)
  await assert.rejects(verifyPrivateFixtureServer({targetPid:badUnrelated.pid,launcherPid:process.pid,profile}),/canonically confined/i)
  await assert.rejects(verifyPrivateFixtureServer({targetPid:good.pid,launcherPid:999999999,profile}),/direct descendant|launcher/i)

  // sameWorktreeRepoAndManifests: rejects a sibling directory borrowing .git without reciprocal gitdir backlink.
  const fakeGitCommon=path.join(tmpRoot,'repo.git')
  const wtA=path.join(tmpRoot,'wt-a'),wtB=path.join(tmpRoot,'wt-b'),wtSpoof=path.join(tmpRoot,'wt-spoof')
  const metaA=path.join(fakeGitCommon,'worktrees','wt-a'),metaB=path.join(fakeGitCommon,'worktrees','wt-b')
  for(const dir of [wtA,wtB,wtSpoof]){
    await mkdir(path.join(dir,'packages','server'),{recursive:true})
    await writeFile(path.join(dir,'package-lock.json'),'{"lockfileVersion":3}\n')
    await writeFile(path.join(dir,'package.json'),'{"name":"root"}\n')
    await writeFile(path.join(dir,'packages','server','package.json'),'{"name":"server"}\n')
  }
  await mkdir(metaA,{recursive:true});await mkdir(metaB,{recursive:true})
  await writeFile(path.join(wtA,'.git'),`gitdir: ${metaA}\n`)
  await writeFile(path.join(wtB,'.git'),`gitdir: ${metaB}\n`)
  await writeFile(path.join(wtSpoof,'.git'),`gitdir: ${metaB}\n`)
  await writeFile(path.join(metaA,'commondir'),'../..\n')
  await writeFile(path.join(metaB,'commondir'),'../..\n')
  await writeFile(path.join(metaA,'gitdir'),`${path.join(wtA,'.git')}\n`)
  await writeFile(path.join(metaB,'gitdir'),`${path.join(wtB,'.git')}\n`)
  assert.equal(sameWorktreeRepoAndManifests(wtA,wtB),true)
  assert.equal(sameWorktreeRepoAndManifests(wtA,wtSpoof),false)
})

test('originGuardProxy attests HTTPS CONNECT tunnels, rejects foreign authorities, and tears down on setTargetPid',{timeout:15000},async t=>{
  const net=await import('node:net')
  const {originGuardProxy}=await import('../../../scripts/native-fixture-http.mjs')
  const echo=net.createServer(socket=>{socket.on('data',chunk=>socket.write(chunk))})
  await new Promise(resolve=>echo.listen(0,'127.0.0.1',resolve))
  t.after(()=>new Promise(resolve=>{echo.closeAllConnections?.();echo.close(resolve)}))
  const targetPort=echo.address().port
  const guard=await originGuardProxy(`https://127.0.0.1:${targetPort}`,process.pid,{
    requireClientAttestation:true,
    allowedClientPids:[process.pid],
  })
  t.after(()=>guard.close())
  const connectTo=(authority)=>new Promise((resolve,reject)=>{
    const sock=net.createConnection({host:'127.0.0.1',port:guard.port})
    let buf=''
    sock.on('error',reject)
    sock.once('connect',()=>sock.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`))
    sock.on('data',chunk=>{
      buf+=chunk.toString('utf8')
      if(buf.includes('\r\n\r\n'))resolve({statusLine:buf.split('\r\n')[0],socket:sock})
    })
  })
  const foreign=await connectTo(`127.0.0.1:${targetPort+1}`)
  assert.match(foreign.statusLine,/^HTTP\/1\.1 403 /)
  foreign.socket.destroy()
  const ok=await connectTo(`127.0.0.1:${targetPort}`)
  assert.match(ok.statusLine,/^HTTP\/1\.1 200 /)
  const closed=new Promise(resolve=>ok.socket.once('close',resolve))
  guard.setTargetPid(999999999)
  await closed
  const afterPidChange=await connectTo(`127.0.0.1:${targetPort}`)
  assert.match(afterPidChange.statusLine,/^HTTP\/1\.1 502 /)
  afterPidChange.socket.destroy()
})

test('acquireProfileLock enforces cross-process SQLite exclusion and live daemon_pid blocking',{timeout:20000},async t=>{
  const {mkdtemp,rm,unlink}=await import('node:fs/promises')
  const os=await import('node:os')
  const path=await import('node:path')
  const {acquireProfileLock}=await import('./live-access.mjs')
  const dir=await mkdtemp(path.join(os.tmpdir(),'codenomad-xproc-lock-'))
  t.after(()=>rm(dir,{recursive:true,force:true}))
  const lockPath=path.join(dir,'running.lock')
  const liveAccessUrl=new URL('./live-access.mjs',import.meta.url).href
  const script=`
    import {acquireProfileLock} from ${JSON.stringify(liveAccessUrl)}
    const [lockPath, holdMs, daemonPid] = process.argv.slice(1)
    try {
      const lock = await acquireProfileLock(lockPath)
      if (daemonPid) await lock.setDaemonPid(Number(daemonPid))
      console.log('ACQUIRED')
      if (Number(holdMs) > 0) {
        await new Promise(resolve => setTimeout(resolve, Number(holdMs)))
        await lock.close()
      }
      process.exit(0)
    } catch (error) {
      if (error?.code === 'EEXIST') process.exit(42)
      console.error(error)
      process.exit(1)
    }
  `
  const runChild=(holdMs,daemonPid='')=>new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['--input-type=module','-e',script,lockPath,String(holdMs),String(daemonPid)],{
      stdio:['ignore','pipe','pipe'],windowsHide:true,
    })
    let stdout='',stderr=''
    child.stdout.on('data',d=>{stdout+=d})
    child.stderr.on('data',d=>{stderr+=d})
    child.once('error',reject)
    child.once('close',code=>resolve({code,stdout,stderr}))
  })
  // Two separate Node processes race for the same lock; exactly one acquires, the other exits 42 (EEXIST).
  const [a,b]=await Promise.all([runChild(600),runChild(600)])
  const codes=[a.code,b.code].sort((x,y)=>x-y)
  assert.deepEqual(codes,[0,42],`Expected one winner (0) and one EEXIST loser (42), got: ${JSON.stringify({a,b})}`)
  // Child acquires lock, records a live survivor daemon_pid in SQLite, then exits without closing (simulating crash).
  const survivor=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true})
  t.after(()=>{try{survivor.kill('SIGKILL')}catch{}})
  await new Promise((resolve,reject)=>{survivor.once('spawn',resolve);survivor.once('error',reject)})
  const crashed=await runChild(0,survivor.pid)
  assert.equal(crashed.code,0)
  // Remove running.lock JSON so the test proves SQLite daemon_pid alone blocks takeover.
  await unlink(lockPath)
  const blocked=await runChild(0)
  assert.equal(blocked.code,42,'live daemon_pid in SQLite must block takeover after launcher crash')
  survivor.kill('SIGKILL')
  await new Promise(resolve=>survivor.once('close',resolve))
  const reclaimed=await acquireProfileLock(lockPath)
  await reclaimed.close()
  await unlink(lockPath)
})

test('originGuardProxy and signInFixture refuse missing target PID without unattested fallback',async()=>{
  const {originGuardProxy}=await import('../../../scripts/native-fixture-http.mjs')
  const {signInFixture}=await import('./fixture-host.mjs')
  await assert.rejects(originGuardProxy('http://127.0.0.1:1',undefined),/target PID/i)
  await assert.rejects(originGuardProxy('http://127.0.0.1:1',0),/target PID/i)
  await assert.rejects(signInFixture('http://127.0.0.1:1','secret',undefined),/target PID/i)
  await assert.rejects(signInFixture('http://127.0.0.1:1','secret',null),/target PID/i)
})
