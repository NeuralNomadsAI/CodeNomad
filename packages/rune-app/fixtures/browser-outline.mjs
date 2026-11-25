import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {createServer} from 'node:http'
import path from 'node:path'
import {chromium} from 'playwright'

const bundle=process.argv[2]
assert(bundle&&path.isAbsolute(bundle),'Pass the absolute wasm-bindgen output directory')
const files=new Map([
  ['/probe.js',['application/javascript',await readFile(path.join(bundle,'probe.js'))]],
  ['/probe_bg.wasm',['application/wasm',await readFile(path.join(bundle,'probe_bg.wasm'))]],
])
const requests=[]
const jumps=[]
const searches=[]
const read=async req=>{
  let body=''
  for await(const chunk of req){body+=chunk;assert(body.length<4096)}
  return {body:JSON.parse(body),cookie:req.headers.cookie}
}
const checkpoint=(after,through)=>({after,through,digest:'a'.repeat(64),changed:true})
const row=(id,seq)=>({id,seq,type:'user',tools:0,reasoning:0})
const hit=(sessionID,messageID)=>({sessionID,messageID,role:'assistant',partIndex:0,kind:'text',excerpt:'Été près de Québec'})
const server=createServer(async(req,res)=>{
  if(req.method==='POST'&&req.url==='/api/workspaces/workspace/session-history/outline'){
    requests.push(await read(req))
    const first=requests.length===1
    res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({
      status:'outline',total:2,entries:first?[row('z',0)]:[row('a',1801)],
      checkpoints:first?[checkpoint(-1,40)]:[checkpoint(40,2000)],
      cursor:first?{after:40,through:2000}:null,
    }))
  }else if(req.method==='POST'&&req.url==='/api/workspaces/workspace/session-history/window'){
    const request=await read(req)
    jumps.push(request)
    res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({
      status:'window', messages:[{id:'a',type:'user',text:'Distant message',time:{created:1}}],
      older:{kind:'before',messageID:'a'},newer:null,latest:true,resume:request.body.target,
    }))
  }else if(req.method==='GET'&&req.url==='/workspaces/workspace/instance/api/session/session'){
    assert.equal(req.headers.cookie,'fixture=outline')
    res.writeHead(200,{'Content-Type':'application/json'}).end('{"data":{"id":"session"}}')
  }else if(req.method==='POST'&&/^\/api\/workspaces\/workspace\/session-history\/(query|ranked)$/.test(req.url)){
    const request=await read(req)
    const route=req.url.split('/').at(-1)
    searches.push({route,...request})
    const {cursor}=request.body
    const result=route==='query'
      ? {status:'page',scanned:80,skipped:0,hits:[hit('session',cursor?'second':'first')],cursor:cursor?null:'literal'}
      : {status:'ranked',version:1,scanned:300,skipped:1,capped:true,examinedBefore:0,exclusions:[],
        hits:[hit('a','best'),hit('z','next')],cursor:'ranked'}
    res.writeHead(route==='ranked'&&cursor?400:200,{'Content-Type':'application/json'}).end(JSON.stringify(result))
  }else if(req.url==='/'){
    res.writeHead(200,{'Content-Type':'text/html','Set-Cookie':'fixture=outline; Path=/; HttpOnly'}).end('<!doctype html>')
  }else if(files.has(req.url)){
    const [type,bytes]=files.get(req.url)
    res.writeHead(200,{'Content-Type':type}).end(bytes)
  }else res.writeHead(404).end()
})
await new Promise((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolve))
let browser
try {
  browser=await chromium.launch({executablePath:process.env.CODENOMAD_BROWSER_PATH})
  const page=await browser.newPage()
  await page.goto(`http://127.0.0.1:${server.address().port}/`)
  const {ids,anchor,hits}=await page.evaluate(async()=>{
    const {default:init,fetch_outline,resolve_anchors,search_history}=await import('/probe.js')
    await init()
    return {ids:await fetch_outline(),anchor:await resolve_anchors(),hits:await search_history()}
  })
  assert.equal(ids,'z,a')
  assert.deepEqual(requests,[
    {body:{sessionID:'session'},cookie:'fixture=outline'},
    {body:{sessionID:'session',cursor:{after:40,through:2000}},cookie:'fixture=outline'},
  ])
  assert.equal(anchor,'a')
  assert.deepEqual(jumps,['a','missing'].map(messageID=>({
    body:{sessionID:'session',target:{kind:'around',messageID}},cookie:'fixture=outline',
  })))
  assert.equal(hits,'first,second,best,next')
  const literal={sessionID:'session',query:'Été',purpose:'search',includeTechnical:false}
  const ranked={version:1,query:'Été Québec',includeTechnical:true,limit:40}
  assert.deepEqual(searches,[
    ['query',literal],['query',{...literal,cursor:'literal'}],
    ['ranked',ranked],['ranked',{...ranked,cursor:'ranked'}],
  ].map(([route,body])=>({route,body,cookie:'fixture=outline'})))
  console.log('Chromium: authenticated outline, bounded anchors, literal paging and ranked restart.')
} finally {
  await browser?.close()
  server.closeAllConnections()
  await new Promise(resolve=>server.close(resolve))
}
