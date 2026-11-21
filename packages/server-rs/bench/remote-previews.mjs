// Real TS/Rust relay routes, one hermetic source per comparison, no browser or desktop host.
import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { createServer, request } from "node:http"
import { request as secureRequest } from "node:https"
import net from "node:net"
import tls from "node:tls"
import path from "node:path"
import { readFile, writeFile } from "node:fs/promises"
import { setTimeout as delay } from "node:timers/promises"

let upstream, source, identity, calls = []
const sockets = new Set()
const tokens = new Set()
const credential = "codenomad_session=fixture-preview-password-session"
const profile = () => ({ id: "relay", name: "Fixture", baseUrl: source, skipTlsVerify: false })
const AUTHORITY = "x-codenomad-backend-authority"
export const remoteIngress = true
const cookie = "codenomad_session=synthetic-untrusted-content"
const json = (res, status, obj) => res.writeHead(status, { "content-type":"application/json" }).end(JSON.stringify(obj))
export async function configure(ts, rs) {
  upstream = createServer(async (req,res) => {
    const { pathname, search } = new URL(req.url, source)
    if (pathname === "/api/auth/status") return json(res, 200, { authenticated: req.headers.cookie === credential })
    if (pathname === "/api/auth/login") {
      let body = ""
      for await (const chunk of req) body += chunk
      const { username,password } = JSON.parse(body)
      if (username !== "preview-fixture" || password !== "synthetic-only") return json(res,401,{error:"Unauthorized"})
      res.setHeader("Set-Cookie",`${credential}; HttpOnly; Path=/`)
      return json(res,200,{ok:true})
    }
    if (pathname === "/api/meta") return req.headers.cookie === credential
      ? json(res,200,{serverId:identity,apiContract:1}) : json(res,401,{error:"Unauthorized"})
    if (pathname.startsWith("/api/previews")) {
      assert.equal(req.headers.cookie,credential)
      assert.equal(req.headers[AUTHORITY],undefined)
      if (req.method === "POST") {
        let chunks = ""
        for await (const chunk of req) chunks += chunk
        const { sessionId,url } = JSON.parse(chunks)
        if (url.endsWith("slow")) await delay(600)
        const token = randomUUID(), prefix = `/previews/${token}`
        tokens.add(token)
        return json(res,200,{token,sessionId,targetUrl:url,proxyUrl:`${prefix}/page?q=1`,createdAt:"2026-01-01T00:00:00.000Z"})
      }
      const token = pathname.split("/").at(-1)
      tokens.delete(token)
      return res.writeHead(204).end()
    }
    const [, name, token, item] = pathname.split("/")
    if (name !== "previews" || !tokens.has(token)) return res.writeHead(404).end()
    calls.push({item, search, origin:req.headers.origin, leaked:Boolean(req.headers.cookie || req.headers.authorization || req.headers[AUTHORITY])})
    if (item === "events") {
      res.writeHead(200, { "content-type":"text/event-stream" })
      res.write("data: connected\n\n")
      return
    }
    if (item === "jump") return res.writeHead(302,{location:`/previews/${token}/after?yes=1`}).end()
    if (item === "outside") return res.writeHead(302,{location:`${source}/api/meta`}).end()
    if (item === "partial") return res.writeHead(206,{"content-range":"bytes 0-1/99","content-type":"text/html"}).end("ab")
    res.writeHead(200,{"content-type":"text/html","set-cookie":"codenomad_session=spoof","service-worker-allowed":"/",
      "content-security-policy":"default-src 'none'","x-frame-options":"deny"})
    res.end(`<head><script src="/previews/${token}/script.js"></script></head><body>relay${search}</body>`)
  })
  upstream.on("connection", socket => { sockets.add(socket); socket.once("close",()=>sockets.delete(socket)) })
  upstream.on("upgrade", (req,socket) => {
    const url = new URL(req.url,source)
    const [, name, token, item] = url.pathname.split("/")
    if (name!=="previews" || !tokens.has(token)) return socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n")
    calls.push({item,search:url.search,ws:true,origin:req.headers.origin,
      leaked:Boolean(req.headers.cookie || req.headers.authorization || req.headers[AUTHORITY])})
    const accept = createHash("sha1").update(req.headers["sec-websocket-key"]+"258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64")
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSet-Cookie: codenomad_session=spoof\r\n\r\n`)
    // Echo a fixed frame and leave the stream open for revocation.
    socket.write(Buffer.from([0x81,0x02,0x6f,0x6b]))
  })
  await new Promise(resolve=>upstream.listen(0,"127.0.0.1",resolve))
  source = `http://127.0.0.1:${upstream.address().port}`
  for (const { root } of [ts,rs]) {
    await writeFile(path.join(root,"state.yaml"),JSON.stringify({ui:{remoteServers:[profile()]}}))
    await writeFile(path.join(root,"remote-server-credentials.json"),JSON.stringify({servers:{
      relay:{origin:source,secret:{kind:"session",cookie:credential}}
    }}))
  }
  return ""
}
export async function close() {
  if (!upstream) return
  for (const socket of sockets) socket.destroy()
  await new Promise(resolve=>upstream.close(resolve))
}
const raw = (url, headers = {}, options = {}) => new Promise((resolve,reject)=>{
  const parsed = new URL(url)
  const send = parsed.protocol === "https:" ? secureRequest : request
  const req = send({hostname:"127.0.0.1", port:Number(parsed.port), path:`${parsed.pathname}${parsed.search}`, agent:false, ca:options.ca,
    method:options.method ?? "GET", headers:{host:parsed.host,...headers}}, res => {
    if (options.stream) { res.resume(); return resolve(res) }
    const parts = []
    res.on("data",chunk=>parts.push(chunk))
    res.on("error",reject)
    res.on("end",()=>{
      const keep = ["location","content-type","content-security-policy","access-control-allow-origin","referrer-policy",
        "cross-origin-resource-policy","cache-control","set-cookie","service-worker-allowed","clear-site-data","access-control-allow-methods"]
      resolve({status:res.statusCode,headers:Object.fromEntries(keep.filter(k=>res.headers[k]!==undefined).map(k=>[k,res.headers[k]])),
        body:Buffer.concat(parts).toString()})
    })
  })
  req.setTimeout(12_000,()=>req.destroy(Error("preview read timed out")))
  req.on("error",reject)
  req.end(options.body)
})
const websocket = (content, origin, secure = {}) => new Promise((resolve,reject)=>{
  const url = new URL(content)
  const isTls = url.protocol === "https:"
  const socket = isTls ? tls.connect({host:"127.0.0.1", port:Number(url.port), ca:secure.ca}) : net.createConnection(Number(url.port),"127.0.0.1")
  const closed = new Promise(done=>socket.once("close",done))
  let data = Buffer.alloc(0)
  socket.setTimeout(12_000,()=>socket.destroy())
  socket.on("error",reject)
  socket.on("close",()=>reject(Error("preview websocket closed before echo")))
  socket.on(isTls ? "secureConnect" : "connect",()=>socket.write([
    `GET ${secure.path ?? "/ws?q=1"} HTTP/1.1`,`Host: ${secure.host ?? url.host}`,`Origin: ${origin}`,`Cookie: ${cookie}`,"Authorization: Bearer synthetic",
    "Connection: Upgrade","Upgrade: websocket","Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==","Sec-WebSocket-Version: 13","",""
  ].join("\r\n")))
  socket.on("data", chunk => {
    data=Buffer.concat([data,chunk])
    const end=data.indexOf("\r\n\r\n")
    if (end<0) return
    const head=data.subarray(0,end).toString()
    const status=Number(head.split(" ")[1])
    if (status!==101) { socket.destroy(); return resolve({status,closed}) }
    if (data.length<end+8) return
    resolve({status,echo:data.subarray(end+6,end+8).toString(),cookie:/^set-cookie:/im.test(head),closed,destroy:()=>socket.destroy()})
  })
})
async function within(p,label) {
  let timer
  try { await Promise.race([p,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(label)),6000)})]) }
  finally { clearTimeout(timer) }
}
export async function run({call,origin,secureOrigin,ingress,data}) {
  identity = randomUUID()
  calls = []
  tokens.clear()
  const api = "/api/backends/relay"
  const invoke = (route, method="GET", proof, body) => call(`${api}${route}`, {method, headers:{origin,
    ...(proof?{[AUTHORITY]:proof}:{}), ...(body?{"content-type":"application/json"}:{})}, ...(body?{body:JSON.stringify(body)}:{})})
  const meta = p => invoke("/api/meta","GET",p)
  const create = proof => invoke("/preview-capabilities","POST",proof,{sessionId:"fixture",url:`${source}/application`})
  const output = {}
  output.noProof = (await create()).status
  output.wrongProof = (await create("z".repeat(43))).status
  const admitted = await meta("bootstrap")
  assert.equal(admitted.status,200)
  const proof = admitted.headers.get(AUTHORITY)
  assert.match(proof,/^[\w-]{43}$/)
  assert.equal((await meta(proof)).headers.get(AUTHORITY),proof)
  const issued = await create(proof)
  assert.equal(issued.status,200)
  const cap = await issued.json()
  const address = new URL(cap.contentUrl)
  assert.equal(address.hostname,`${cap.capability}.preview.localhost`)
  const publicRoot = address.origin
  const clean = value => JSON.parse(JSON.stringify(value).replaceAll(publicRoot,"<content-origin>").replaceAll(source,"<source-origin>")
    .replaceAll(origin,"<host-origin>").replaceAll(cap.token,"<source>").replaceAll(cap.capability,"<capability>"))
  output.issue = clean(cap)
  output.page = clean(await raw(cap.contentUrl,{cookie,authorization:"Bearer synthetic"}))
  assert.equal(output.page.status,200)
  assert.match(output.page.body,/\/previews\/<source>\/script.js/)
  assert.equal(output.page.headers["set-cookie"],undefined)
  assert.equal(output.page.headers["service-worker-allowed"],undefined)
  output.redirect = clean(await raw(`${publicRoot}/jump`))
  output.externalRedirect = (await raw(`${publicRoot}/outside`)).status
  output.crossOrigin = (await raw(cap.contentUrl,{origin:"http://fixture.invalid"})).status
  output.opaque = (await raw(cap.contentUrl,{origin:"null"})).status
  output.worker = (await raw(cap.contentUrl,{"service-worker":"script"})).status
  output.preflight = clean(await raw(`${publicRoot}/app`,{origin:publicRoot,"access-control-request-method":"GET"},{method:"OPTIONS"}))
  const ws = await websocket(publicRoot,publicRoot)
  assert.equal(ws.status,101)
  output.ws = {status:ws.status,echo:ws.echo,cookie:ws.cookie}
  output.foreignWs = (await websocket(publicRoot,"http://fixture.invalid")).status
  assert.equal(output.foreignWs,404)
  const events = await raw(`${publicRoot}/events`,{},{stream:true})
  assert.equal(events.statusCode,200)
  const eventClosed = new Promise(resolve=>events.once("close",resolve))
  try {
    output.wrongDelete = (await invoke(`/preview-capabilities/${cap.capability}`,"DELETE","z".repeat(43))).status
    output.remove = (await invoke(`/preview-capabilities/${cap.capability}`,"DELETE",proof)).status
    assert.equal(output.remove,204)
    await within(Promise.all([ws.closed,eventClosed]),"revocation did not close the live transfers")
    output.closed = true
  } finally { ws.destroy?.(); events.destroy() }
  output.expired = await raw(cap.contentUrl)
  const next = await (await create(proof)).json()
  assert.equal((await invoke("/preview-capabilities","DELETE",proof)).status,204)
  output.detached = (await raw(next.contentUrl)).status
  const third = await (await create(proof)).json()
  identity = randomUUID()
  output.identityChanged = (await meta(proof)).status
  output.renamedClosed = (await raw(third.contentUrl)).status
  output.stale = (await create(proof)).status
  const login = await invoke("/api/auth/login","POST","bootstrap",{username:"preview-fixture",password:"synthetic-only"})
  assert.equal(login.status,200)
  const replacement = (await meta("bootstrap")).headers.get(AUTHORITY)
  assert.match(replacement,/^[\w-]{43}$/)
  assert.notEqual(replacement,proof)
  const fourth = await (await create(replacement)).json()
  output.device = await runDevice({call,origin,secureOrigin,ingress,data},replacement)
  const patch = await call("/api/storage/state/ui", {method:"PATCH",headers:{origin,"content-type":"application/json"},body:'{"remoteServers":[]}'})
  assert.equal(patch.status,200)
  output.removedProfile = (await raw(fourth.contentUrl)).status
  output.removedProof = !(await meta(replacement)).ok
  assert(output.removedProof)
  output.ownedCalls = clean(calls)
  assert(calls.every(r=>!r.leaked && r.origin===undefined),"application credentials or origin reached the remote content")
  assert.deepEqual([output.crossOrigin,output.externalRedirect,output.opaque,output.worker,output.detached,output.stale,output.removedProfile],
    [404,404,404,404,404,404,404])
  return output
}

async function runDevice({call,origin,secureOrigin,ingress,data}, proof) {
  const local = async (route,method="POST",body) => call(route,{method,headers:{origin,
    ...(body?{"content-type":"application/json"}:{})},...(body?{body:JSON.stringify(body)}:{})})
  if (!secureOrigin) {
    const started = await local("/api/remote-control/start")
    assert.equal(started.status,200)
    for (let i=0;i<100 && !ingress();i++) await delay(25)
    assert(ingress(),"The real TS tunnel manager did not expose its local fixture ingress")
  }
  const wire = secureOrigin ?? ingress()
  const ca = secureOrigin ? await readFile(path.join(data,"tls","ca-cert.pem")) : undefined
  const host = secureOrigin ? new URL(secureOrigin).host : "preview-ingress.fixture.test"
  const publicOrigin = `https://${host}`
  const remote = (route,headers={},options={}) => raw(`${wire}${route}`,{...headers,host},{...options,ca})
  const newPair = async () => {
    const issued = await local("/api/remote-control/pairings")
    assert.equal(issued.status,200)
    const code = new URL((await issued.json()).url).hash.slice(1)
    const paired = await remote("/api/remote-control/pair",{origin:publicOrigin,"content-type":"application/json"},
      {method:"POST",body:JSON.stringify({code})})
    assert.equal(paired.status,200)
    return paired.headers["set-cookie"][0].split(";")[0]
  }
  const deviceCookie = await newPair()
  const otherCookie = await newPair()
  const deviceMeta = async () => {
    const response = await remote("/api/meta",{origin:publicOrigin,cookie:deviceCookie})
    assert.equal(response.status,200)
    return JSON.parse(response.body)
  }
  assert.notEqual((await deviceMeta()).previewsUnavailable,true)
  const api = "/api/backends/relay/preview-capabilities"
  const issue = async () => remote(api,{origin:publicOrigin,cookie:deviceCookie,"content-type":"application/json",[AUTHORITY]:proof},
    {method:"POST",body:JSON.stringify({sessionId:"fixture",url:`${source}/application`})})
  const created = await issue()
  assert.equal(created.status,200,created.body)
  const cap = JSON.parse(created.body)
  const prefix = `/previews/${cap.capability}`
  assert.equal(cap.contentUrl,`${prefix}/page?q=1`)
  const scrub = r => JSON.parse(JSON.stringify(r).replaceAll(cap.capability,"<capability>"))
  const document = scrub(await remote(cap.contentUrl,{origin:"null","authorization":"Bearer synthetic"}))
  assert.equal(document.status,200)
  assert.match(document.body,/\/previews\/<capability>\/script.js/)
  assert(!document.body.includes(cap.token))
  assert.equal(document.headers["cross-origin-resource-policy"],undefined)
  assert.equal(document.headers["access-control-allow-origin"],"null")
  const denied = await remote(`${api}/${cap.capability}`,{origin:publicOrigin,cookie:otherCookie,[AUTHORITY]:proof},{method:"DELETE"})
  assert.equal(denied.status,404)
  const redirected = await remote(`${prefix}/jump`,{origin:"null"})
  assert.equal(redirected.status,302)
  assert.equal(redirected.headers.location,`${prefix}/after?yes=1`)
  const partial = await remote(`${prefix}/partial`,{origin:"null"})
  assert.equal(partial.status,404)
  const ws = await websocket(wire,"null",{host,path:`${prefix}/ws?q=1`,ca})
  assert.equal(ws.status,101)
  const events = await remote(`${prefix}/events`,{origin:"null"},{stream:true})
  assert.equal(events.statusCode,200)
  const done = new Promise(resolve=>events.once("close",resolve))
  try {
    assert.equal((await local("/api/remote-control/previews","PUT",{enabled:false})).status,200)
    await within(Promise.all([ws.closed,done]),"turning previews off did not close device transfers")
    assert.equal((await deviceMeta()).previewsUnavailable,true)
    assert.equal((await remote(cap.contentUrl)).status,404)
    assert.equal((await issue()).status,404)
  } finally {
    ws.destroy?.()
    events.destroy()
    assert.equal((await local("/api/remote-control/previews","PUT",{enabled:true})).status,200)
  }
  return {document, foreignDelete:denied.status, redirect:scrub(redirected).headers.location,
    partial:partial.status, ws:{echo:ws.echo,cookie:ws.cookie}, disabled:true, revoked:true}
}
