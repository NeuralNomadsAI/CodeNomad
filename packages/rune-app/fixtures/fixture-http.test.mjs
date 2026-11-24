import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {Agent,createServer,request} from 'node:http'
import net from 'node:net'
import {test} from 'node:test'
import {promisify} from 'node:util'
import {createAttestedFetch,fixtureFetch,relayTarget,verifyLoopbackConnectionPeer,withoutFixtureProxy} from '../../../scripts/native-fixture-http.mjs'
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

test('verifyLoopbackConnectionPeer rejects mismatched PID and pool close aborts in-flight peer checks',{timeout:15000},async t=>{
  const srv=await listen(t,(_req,res)=>{res.writeHead(200);res.end('ok')})
  const port=Number(new URL(srv.origin).port)
  const socket=net.createConnection({host:'127.0.0.1',port})
  t.after(()=>socket.destroy())
  await new Promise((resolve,reject)=>{socket.once('connect',resolve);socket.once('error',reject)})
  await verifyLoopbackConnectionPeer(socket.localPort,port,process.pid)
  await assert.rejects(verifyLoopbackConnectionPeer(socket.localPort,port,process.pid+999999),/not owned by fixture PID/)

  let peerEntered,releasePeer
  const inPeer=new Promise(resolve=>{peerEntered=resolve})
  const peerGate=new Promise(resolve=>{releasePeer=resolve})
  const bound=createAttestedFetch(srv.origin,port,process.pid,async()=>{},async()=>{peerEntered();await peerGate})
  const pending=bound(new URL('/',srv.origin))
  await inPeer
  await bound.close()
  releasePeer()
  await assert.rejects(pending,error=>/closed|destroyed|Attested/i.test(error?.cause?.message??error?.message??''))
})
