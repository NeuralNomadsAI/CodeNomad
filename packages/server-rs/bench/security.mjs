// TLS and pairing: the same checks on Rust's HTTPS listener and on the TS remote surface (server pairing,
// Host and Origin, throttling, single use, revocation closing a live SSE), then Rust's certificate reuse,
// provided chain and SAN rotation across restarts. `node security.mjs <opencode executable>`
import assert from "node:assert/strict"
import { randomUUID, X509Certificate } from "node:crypto"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { brotliCompressSync } from "node:zlib"
import http from "node:http"
import https from "node:https"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { assertPrivateOpenCodeExecutable } from "./private-profile.mjs"

const rawExe = process.argv[2]
assert(path.isAbsolute(rawExe ?? ""), "usage: node security.mjs <absolute opencode executable>")
const exe = await assertPrivateOpenCodeExecutable(rawExe)
const { withProductRuntime } = await import("../../../scripts/native-product-fixture.mjs")
const { fixtureChildPid, spawnFixtureChild: spawn, stopFixtureChild } = await import("../../../scripts/native-fixture-guards.mjs")
const { dist, dropRegistration, fromDist, rustBinary, useBenchTemp, writeJson } = await import("./fixtures.mjs")
const bin=rustBinary()
await useBenchTemp()
const { isHtmlBundlePath } = await fromDist("remote-control/gate.js")
assert(isHtmlBundlePath?.("/index.html.br"),
  `Rebuild the TypeScript reference at ${dist.href}: its remote gate must protect precompressed HTML`)
// The TS test surface with a real connection manager, so that revocation closes live streams.
const surface=new URL("remote-control/test-support/surface.js",dist)
const wired=new URL("surface-bench.mjs",surface)
const before=await readFile(surface,"utf8"), marker="clientConnectionManager: stub,", create="const server = createHttpServer"
assert.equal(before.split(marker).length,2)
assert.equal(before.split(create).length,2)
await writeFile(wired,`import { ClientConnectionManager } from "../../clients/connection-manager.js";\n${before.replace(marker,"clientConnectionManager: connections,").replace(create,`const connections = new ClientConnectionManager(serverLogger); t.after(()=>connections.shutdown());\n    ${create}`)}`)
const {startRemoteSurface, FAKE_TUNNEL_HOST}=await import(wired)
await rm(wired)
const reports=[]
const result={binary:bin,reports,tls:{},expiry:{}}
const json=body=>({headers:{"content-type":"application/json"},body:JSON.stringify(body)})
const output=(value)=>{try{return JSON.parse(value)}catch{return value}}
function send(url, {method="GET",headers={},body,ca,stream=false,servername}={}) {
  return new Promise((resolve,reject)=>{
    const request=(url.startsWith("https:")?https:http).request(url,{method,headers,ca,servername,agent:false,timeout:5500},res=>{
      if (stream) { resolve({status:res.statusCode,headers:res.headers,response:res, request}); return }
      let text=""
      res.setEncoding("utf8")
      res.on("data",chunk=>text+=chunk)
      res.on("end",()=>resolve({status:res.statusCode,body:output(text),headers:res.headers}))
      res.on("error",reject)
    })
    request.on("error",reject)
    request.on("timeout",()=>request.destroy(Error("Request timed out")))
    request.end(body)
  })
}
async function pairingNavigation(title, targets, rootHeaders={}) {
  const headers={accept:"text/html",referer:"https://outside.invalid/link","sec-fetch-site":"cross-site","sec-fetch-mode":"navigate"}
  for (const method of ["GET","HEAD"]) {
    const roots=await Promise.all(targets.map(target=>target({url:"/",method,headers:{...headers,...rootHeaders}})))
    assert.deepEqual(roots.map(r=>[r.status,r.headers.location]),[[302,"/remote-pair"],[302,"/remote-pair"]],title)
    const pages=await Promise.all(targets.map((target,i)=>target({url:roots[i].headers.location,method,headers})))
    assert.deepEqual(pages.map(r=>[r.status,r.headers["referrer-policy"]]),[[200,"no-referrer"],[200,"no-referrer"]],title)
    if(method==="HEAD") assert(pages.every(r=>r.body===""),title)
    reports.push({title:`${title}: ${method}`,statuses:pages.map(r=>r.status),rootStatuses:roots.map(r=>r.status)})
  }
}
const scriptPath="/assets/solid-fixture.js"
const script="export const solid = true;\n".repeat(64)
async function solidAssets(dir) {
  await mkdir(path.join(dir,"assets"),{recursive:true})
  const index=`<!doctype html><title>Solid fixture</title><script type="module" src="${scriptPath}"></script>`
  await writeFile(path.join(dir,"index.html"),index)
  await writeFile(path.join(dir,"index.html.br"),brotliCompressSync(index))
  await writeFile(path.join(dir,"manifest.webmanifest"),JSON.stringify({name:"CodeNomad"}))
  await writeFile(path.join(dir,scriptPath),script)
  await writeFile(path.join(dir,`${scriptPath}.br`),brotliCompressSync(script))
}
async function checkSolid(title, targets, origins, issue) {
  for (const [index, target] of targets.entries()) {
    const origin=origins[index]
    const publicAsset=await target({url:"/manifest.webmanifest"})
    assert.equal(publicAsset.status,200,title)
    assert.equal(publicAsset.body.name,"CodeNomad")
    const backend=index===0?"TypeScript":"Rust"
    for(const url of ["/index.html","/index.html.br"])
      assert.equal((await target({url})).status,index===0&&title==="direct"?302:401,`${backend}: unpaired ${title} ${url}`)
    if(title==="ingress"){
      const unpairedPage=await target({url:"/index.html",headers:{accept:"text/html"}})
      assert.equal(unpairedPage.status,302)
      assert.equal(unpairedPage.headers.location,"/remote-pair")
    }
    const pairing=await target({url:"/api/remote-control/pair",method:"POST",...json({code:await issue[index]()}),
      headers:{"content-type":"application/json",origin}})
    assert.equal(pairing.status,200,`${title}: ${JSON.stringify(pairing.body)}`)
    const cookie=pairing.headers["set-cookie"][0].split(";",1)[0]
    const headers={cookie,accept:"text/html"}
    const page=await target({url:"/",headers})
    assert.equal(page.status,200)
    assert.equal(page.headers["cache-control"],"no-store")
    assert.match(page.body,/Solid fixture/)
    assert.equal((await target({url:"/",method:"HEAD",headers})).body,"")
    const deepPage=await target({url:"/settings",method:"HEAD",headers:{...headers,"accept-encoding":"br"}})
    assert.equal(deepPage.status,200)
    assert.equal(deepPage.headers["cache-control"],"no-store")
    assert.equal(deepPage.headers["content-encoding"],"br")
    const resource=await target({url:scriptPath,headers:{cookie}})
    assert.equal(resource.status,200)
    assert.match(resource.headers["content-type"],/javascript/)
    assert.equal(resource.body,script)
    const compressed=await target({url:scriptPath,method:"HEAD",headers:{cookie,"accept-encoding":"br, gzip"}})
    assert.equal(compressed.status,200)
    assert.equal(compressed.headers["content-encoding"],"br")
    assert.match(compressed.headers.vary,/Accept-Encoding/i)
    assert.equal(compressed.body,"")
    assert.equal((await target({url:"/api/solid-fixture-missing.js",headers:{cookie}})).status,404)
  }
  reports.push({title:`Solid app shell and assets (${title})`})
}
async function query(rust,ts) {
  const pairs=[ts,rust]
  const check=async (title, target, make, expected)=>{
    const observed=await Promise.all(pairs.map(host=>host[target](make(host))))
    reports.push({title,statuses:observed.map(o=>o.status)})
    assert.deepEqual(observed.map(o=>o.status),[expected,expected],title)
    return observed
  }
  const pair=(method,url,options={})=>({method,url,...options})
  const serverPair=host=>"x-codenomad-server-pairing"
  await check("server pairing refused on the local listener","local",()=>pair("POST","/api/remote-control/server-pair",json({})),404)
  const [firstTs,firstRs]=await Promise.all(pairs.map(host=>host.issue()))
  const codes=[firstTs,firstRs]
  const redeem=(host,code,extra={})=>pair("POST","/api/remote-control/server-pair",{
    ...json({code,hostName:"Fixture"}),headers:{"content-type":"application/json",[serverPair(host)]:"1",...extra},
  })
  const good=host=>codes[pairs.indexOf(host)]
  await check("wrong Host is misdirected","remote",()=>pair("GET","/api/auth/status",{
    headers:{Host:"other.invalid"},servername:"localhost"
  }),421)
  await pairingNavigation("External ingress navigation",pairs.map(host=>host.remote))
  await check("external pairing navigation still rejects an opaque Origin","remote",
    ()=>pair("GET","/remote-pair",{headers:{origin:"null",referer:"https://outside.invalid/link"}}),403)
  await check("wrong Origin with valid code","remote",host=>redeem(host,good(host),{origin:"https://other.invalid"}),403)
  await check("empty browser metadata with valid code","remote",host=>redeem(host,good(host),{"sec-fetch-site":""}),403)
  for(let i=0;i<11;i++) await check(`incorrect attempt ${i+1}`,"remote",host=>redeem(host,"z".repeat(32)),i===10?429:401)
  const paired=await check("valid code still accepted in failure bucket","remote",host=>redeem(host,good(host)),200)
  await check("single use, reused code after throttle","remote",host=>redeem(host,good(host)),429)
  pairs.forEach((host,i)=>{
    host.identity=paired[i].body.device
    host.cookie=`__Host-codenomad_device=${paired[i].body.credential}`
    assert.match(paired[i].body.credential,/^[A-Za-z0-9_-]{43}$/)
    assert.equal(paired[i].headers["set-cookie"],undefined)
    assert.equal(paired[i].headers["cache-control"],"no-store")
  })
  await check("stolen browser cookie from another origin (mutation)","remote",host=>pair("POST","/api/client-connections/pong",{
    ...json({clientId:"foreign",connectionId:"foreign"}),headers:{"content-type":"application/json",cookie:host.cookie,origin:"https://other.invalid"}
  }),403)
  const auth=host=>({cookie:host.cookie,"x-codenomad-server-request":"1"})
  await check("paired auth status","remote",host=>pair("GET","/api/auth/status",{headers:auth(host)}),200)
  await check("nested relay denied","remote",host=>pair("GET","/api/backends/other/api/meta",{headers:auth(host)}),404)
  await check("method outside catalog","remote",host=>pair("PATCH","/api/events",{headers:auth(host)}),404)
  await check("SideCar management in the catalog","remote",host=>pair("GET","/api/sidecars",{headers:auth(host)}),200)
  await check("SideCar content stays host-only","remote",host=>pair("GET","/sidecars/fixture/",{headers:auth(host)}),404)
  const sockets=await check("live SSE","remote",host=>pair("GET","/api/events?clientId=fixture&connectionId=revocation",{
    headers:{...auth(host),accept:"text/event-stream"},stream:true
  }),200)
  const closures=sockets.map(({response})=>new Promise(resolve=>{response.on("close",resolve);response.resume()}))
  for(const host of pairs) assert.equal((await host.revoke(host.identity.id)).status,204)
  let deadline
  try { await Promise.race([Promise.all(closures),new Promise((_,reject)=>{deadline=setTimeout(()=>reject(Error("SSE remained open")),2500)})]) }
  finally {clearTimeout(deadline)}
  reports.push({title:"revocation closes live SSE"})
  await check("revoked device receives 401","remote",host=>pair("GET","/api/meta",{headers:auth(host)}),401)
  const states=await check("revoked auth status requires pairing","remote",host=>pair("GET","/api/auth/status",{headers:auth(host)}),200)
  for (const state of states) assert.deepEqual(state.body,{authenticated:false,pairingRequired:true})
}
await withProductRuntime(exe,async()=>({}),async ({root:home,env,connection})=>{
  const password=randomUUID()
  const projects=path.join(home,"projects")
  await mkdir(projects)
  const start=(identity,extra={})=>{
    const child=spawn(bin,[projects,path.join(home,`${identity}.json`),"0",exe],{cwd:home,windowsHide:true,
    env:{...env,CNRS_FIXTURE_URL:connection.endpoint.url,CNRS_FIXTURE_PASSWORD:connection.endpoint.auth.password,
       CNRS_SERVER_PASSWORD:password,CNRS_HTTPS_BIND:"127.0.0.1:0",CNRS_HTTPS_NAME:"127.0.0.1",
       CNRS_FIXTURE_INGRESS:"1",CNRS_FIXTURE_STDIN_STOP:"1",...extra}})
    const stopped=new Promise(resolve=>child.once("close",resolve))
    let lines=""
    for(const stream of [child.stdout,child.stderr]) stream.on("data",b=>lines+=b)
    const origins=async()=>{
      const end=Date.now()+15000
      while(!/^http:\/\/127/m.test(lines)&&Date.now()<end&&child.exitCode===null) await delay(25)
      const local=/^http:\/\/127\.0\.0\.1:\d+/m.exec(lines)?.[0]
      const remote=/^HTTPS (https:\/\/\S+)/m.exec(lines)?.[1]
      assert(local&&remote,lines)
      return {local,remote}
    }
    const pid=fixtureChildPid(child)
    return {child,stopped,origins,close:async()=>{await stopFixtureChild(child,stopped);await dropRegistration(env,await pid)}}
  }
  const solidDir=path.join(home,"solid")
  await solidAssets(solidDir)
  await mkdir(path.join(solidDir,"api"))
  await writeFile(path.join(solidDir,"api","solid-fixture-missing.js"),script)
  const server=start("risk",{CNRS_FIXTURE_UI_DIR:solidDir}),{child,stopped}=server
  const cleanup=[]
  try {
    const {local:rsBase,remote:tls}=await server.origins()
    const certDir=path.join(home,"risk.data/tls")
    const ca=await readFile(path.join(certDir,"ca-cert.pem"))
    await assert.rejects(send(`${tls}/api/auth/status`),{code:"SELF_SIGNED_CERT_IN_CHAIN"})
    assert.equal((await send(`${tls}/api/auth/status`,{ca})).status,200)
    await assert.rejects(send(`${tls}/api/auth/status`,{ca,servername:"wrong-name.invalid"}),{code:"ERR_TLS_CERT_ALTNAME_INVALID"})
    const use=(base,tlsOptions={})=>({url,...options})=>send(`${base}${url}`,{...options,...tlsOptions})
    let clock=Date.now()
    const tsFixture=await startRemoteSurface({after(fn){cleanup.push(fn)}},{
      now:()=>clock,password,serverIdentity:{serverId:randomUUID(),apiContract:1}
    })
    const tsLocal=use(`http://${tsFixture.local}`)
    const tsRemote=({url,headers,...options})=>send(`http://${tsFixture.target()}${url}`,
      {...options,headers:{Host:FAKE_TUNNEL_HOST,...headers}})
    const rsLocal=use(rsBase), rsRemote=use(tls,{ca})
    const build=async (local,remote,issue)=>{
      const login=await local({url:"/api/auth/login",method:"POST",...json({username:"codenomad",password})})
      assert.equal(login.status,200)
      const cookie=login.headers["set-cookie"][0].split(";",1)[0]
      const admin=(url,init)=>local({url,...init,headers:{...init?.headers,cookie}})
      return {local,remote,issue:()=>issue(admin),revoke:id=>admin(`/api/remote-control/devices/${id}`,{method:"DELETE"}),admin}
    }
    const rust=await build(rsLocal,rsRemote,async admin=>{
      const issued=await admin("/api/remote-control/pairings",{method:"POST"})
      assert.equal(issued.status,200)
      return new URL(issued.body.url).hash.slice(1)
    })
    const ts=await build(tsLocal,tsRemote,async()=>new URL(tsFixture.manager.createPairing().url).hash.slice(1))
    await solidAssets(path.join(path.dirname(tsFixture.registryPath),"ui"))
    await checkSolid("ingress",[tsRemote,rsRemote],[`https://${FAKE_TUNNEL_HOST}`,tls],[ts.issue,rust.issue])
    // Separate surface: its failure bucket uses the real clock.
    const expiryFixture=await startRemoteSurface({after(fn){cleanup.push(fn)}},{now:()=>clock,password})
    const expired=new URL(expiryFixture.manager.createPairing().url).hash.slice(1)
    clock+=301000
    const expiredResponse=await send(`http://${expiryFixture.target()}/api/remote-control/server-pair`,{
      method:"POST",body:JSON.stringify({code:expired,hostName:"Expiry fixture"}),
      headers:{Host:FAKE_TUNNEL_HOST,"content-type":"application/json","x-codenomad-server-pairing":"1"}
    })
    assert.equal(expiredResponse.status,401)
    result.expiry.typescript=expiredResponse.status
    const metadata=await rust.admin("/api/meta")
    const leaf=new X509Certificate(await readFile(path.join(certDir,"server-cert.pem")))
    assert.equal(metadata.body.tlsFingerprint,leaf.fingerprint256.replaceAll(":","").toLowerCase())
    result.tls={trusted:true,rejectsUntrusted:true,rejectsWrongName:true,leafFingerprintMatches:true}
    await query(rust,ts)
    const name="direct.fixture.test"
    const direct=start("direct",{CNRS_FIXTURE_INGRESS:"0",CNRS_HTTPS_NAME:name,CNRS_FIXTURE_UI_DIR:solidDir})
    try {
      const {local,remote}=await direct.origins()
      const authority=`${name}:${new URL(remote).port}`
      const directCa=await readFile(path.join(home,"direct.data/tls/ca-cert.pem"))
      const directTs=await startRemoteSurface({after(fn){cleanup.push(fn)}},{allowedOrigins:[`https://${authority}`],password})
      const rustDirect=({url,headers,...options})=>send(`https://127.0.0.1:${new URL(remote).port}${url}`,{
        ...options,ca:directCa,servername:name,headers:{...headers,Host:authority}
      })
      const tsDirect=({url,headers,...options})=>send(`http://${directTs.local}${url}`,{
        ...options,headers:{...headers,Host:authority}
      })
      await pairingNavigation("External direct HTTPS navigation",[tsDirect,rustDirect],{cookie:"__Host-codenomad_device=stale"})
      await solidAssets(path.join(path.dirname(directTs.registryPath),"ui"))
      const directRust=await build(use(local),rustDirect,async admin=>{
        const issued=await admin("/api/remote-control/pairings",{method:"POST",...json({origin:remote})})
        assert.equal(issued.status,200,JSON.stringify(issued.body))
        return new URL(issued.body.url).hash.slice(1)
      })
      await checkSolid("direct",[tsDirect,rustDirect],[remote,remote],[
        ()=>new URL(directTs.manager.createDirectPairing(remote).url).hash.slice(1),
        directRust.issue,
      ])
    } finally { await direct.close() }
    const code=await rust.issue()
    const fresh=await rsRemote({url:"/api/remote-control/server-pair",method:"POST",...json({code,hostName:"Shutdown fixture"}),
      headers:{"content-type":"application/json","x-codenomad-server-pairing":"1"}})
    assert.equal(fresh.status,200)
    const streaming=await rsRemote({url:"/api/events?clientId=fixture&connectionId=shutdown",headers:{
      cookie:`__Host-codenomad_device=${fresh.body.credential}`,"x-codenomad-server-request":"1"
    },stream:true})
    assert.equal(streaming.status,200)
    let timer
    const closed=new Promise(resolve=>streaming.response.once("close",resolve))
    streaming.response.resume()
    child.stdin.end("shutdown\n")
    try{await Promise.race([Promise.all([closed,stopped]),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error("Shutdown did not close live SSE")),3500)})])}
    finally{clearTimeout(timer)}
    assert.equal(child.exitCode,0)
    result.shutdown={sseClosed:true,exitCode:child.exitCode}
    const verify=async (identity,extra)=>{
      const trial=start(identity,extra)
      try {
        const {local,remote}=await trial.origins()
        const {admin}=await build(use(local),use(remote,{ca}))
        const meta=await admin("/api/meta")
        assert.equal(meta.status,200)
        const status=await send(`${remote}/api/auth/status`,{ca,headers:{cookie:rust.cookie,"x-codenomad-server-request":"1"}})
        assert.equal(status.body.pairingRequired,true)
        return meta.body.tlsFingerprint
      } finally {await trial.close()}
    }
    assert.equal(await verify("risk"),metadata.body.tlsFingerprint)
    result.tls.reuseAfterRestart=true
    result.revocationSurvivesRestart=true
    assert.equal(await verify("provided",{CNRS_TLS_KEY:path.join(certDir,"server-key.pem"),
      CNRS_TLS_CERT:path.join(certDir,"server-cert.pem"),CNRS_TLS_CA:path.join(certDir,"ca-cert.pem")}),metadata.body.tlsFingerprint)
    result.tls.providedChain=true
    assert.notEqual(await verify("risk",{CNRS_TLS_SANS:"extra.invalid"}),metadata.body.tlsFingerprint)
    assert.deepEqual(await readFile(path.join(certDir,"ca-cert.pem")),ca)
    result.tls.changedSanRotatesLeafOnly=true
  } finally {
    await server.close()
    for(const close of cleanup.reverse()) await close()
  }
}).catch(error=>{result.error=String(error.stack);console.error(result.error);process.exitCode=1})
await writeJson("security.json",result)
console.log(`security: ${result.error?"FAILED":`${reports.length} checks identical`}`)
