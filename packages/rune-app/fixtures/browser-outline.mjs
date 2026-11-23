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
const checkpoint=(after,through)=>({after,through,digest:'a'.repeat(64),changed:true})
const row=(id,seq)=>({id,seq,type:'user',tools:0,reasoning:0})
const server=createServer(async(req,res)=>{
  if(req.method==='POST'&&req.url==='/api/workspaces/workspace/session-history/outline'){
    let body=''
    for await(const chunk of req){body+=chunk;assert(body.length<4096)}
    requests.push({body:JSON.parse(body),cookie:req.headers.cookie})
    const first=requests.length===1
    res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({
      status:'outline',total:2,entries:first?[row('z',0)]:[row('a',1801)],
      checkpoints:first?[checkpoint(-1,40)]:[checkpoint(40,2000)],
      cursor:first?{after:40,through:2000}:null,
    }))
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
  const ids=await page.evaluate(async()=>{
    const {default:init,fetch_outline}=await import('/probe.js')
    await init()
    return fetch_outline()
  })
  assert.equal(ids,'z,a')
  assert.deepEqual(requests,[
    {body:{sessionID:'session'},cookie:'fixture=outline'},
    {body:{sessionID:'session',cursor:{after:40,through:2000}},cookie:'fixture=outline'},
  ])
  console.log('Chromium: authenticated outline pages preserve native sequence order.')
} finally {
  await browser?.close()
  server.closeAllConnections()
  await new Promise(resolve=>server.close(resolve))
}
