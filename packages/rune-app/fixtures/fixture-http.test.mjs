import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {Agent,createServer,request} from 'node:http'
import {test} from 'node:test'
import {promisify} from 'node:util'
import {relayTarget,withoutFixtureProxy} from '../../../scripts/native-fixture-http.mjs'

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
