import assert from "node:assert/strict"
import { spawn, execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, readdir, writeFile, copyFile, cp, symlink } from "node:fs/promises"
import { createServer, request } from "node:http"
import { createServer as tcp } from "node:net"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { createInterface } from "node:readline"
import { promisify } from "node:util"
import { setTimeout as delay } from "node:timers/promises"
import { Worker } from "node:worker_threads"

const [rune, ladybird, server, cli, plugins, fixture, solid] = process.argv.slice(2).map(p=>path.resolve(p))
assert.equal(process.platform, "win32")
assert(fixture && process.env.TEMP?.startsWith("D:\\"), "Pass six paths and use an explicit temporary directory on D:")
const root = await mkdtemp(path.join(process.env.TEMP, "trial-ladybird-"))
const exe = path.join(root, "codenomad-rs.exe")
await copyFile(server, exe)
await cp(plugins, path.join(root, "plugins"), {recursive:true})
if(solid) {
  const repo=path.resolve(solid,"../..")
  const {build}=await import(pathToFileURL(path.join(repo,"node_modules","esbuild","lib","main.js")).href)
  const {nativePluginBuild}=await import(pathToFileURL(path.join(repo,"packages","server","scripts","native-plugin-build.mjs")).href)
  await build({...nativePluginBuild,banner:{js:'// CodeNomad plugin IDs: ["codenomad.automation"]'},
    entryPoints:[path.join(repo,"packages","server","src","opencode","automation","desktop-plugin.ts")],
    outfile:path.join(root,"plugins","automation","plugin.mjs")})
}
const profile = path.join(root, "oc")
const project = path.join(root, "project")
const homeVars = Object.fromEntries([
  ["HOME",""],["USERPROFILE",""],["LOCALAPPDATA","AppData/Local"],["APPDATA","AppData/Roaming"],
  ["ProgramData","ProgramData"],["XDG_DATA_HOME","xdg-data"],["XDG_CONFIG_HOME","xdg-config"],
  ["XDG_STATE_HOME","xdg-state"],["XDG_CACHE_HOME","xdg-cache"],
  ["TEMP","tmp"],["TMP","tmp"],["npm_config_cache","npm-cache"],
].map(([k,v])=>[k,path.join(profile,v)]))
for (const p of [project,...Object.values(homeVars)]) await mkdir(p,{recursive:true})
const env = {...Object.fromEntries(Object.entries(process.env).filter(([k])=>
  /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|SYSTEMDRIVE|OS|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMW6432|LANG|TZ)$/i.test(k))),...homeVars}
const exec = (file,args,options={}) => promisify(execFile)(file,args,{env,cwd:project,windowsHide:true,timeout:30000,...options}).then(r=>r.stdout.trim())
const oc = (...args) => exec(cli,args)
const listen = server => new Promise(resolve=>server.listen(0,"127.0.0.1",()=>resolve(server.address().port)))
const tmp = tcp()
const port = await listen(tmp)
await new Promise(resolve=>tmp.close(resolve))
const file = path.join(project,"local.html")
await writeFile(file, `<!doctype html><title>Ladybird local</title><h1>Ladybird local file</h1><label>Local name <input value="initial"></label>`)
const local = pathToFileURL(file).href
const woff = process.env.RUNE_LADYBIRD_WOFF2
const app = createServer((req,res)=>{
  if(req.url==="/image.svg") {
    res.setHeader("content-type","image/svg+xml")
    return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="44" height="30"><rect width="44" height="30" fill="royalblue"/></svg>')
  }
  if(req.url==="/example.woff2" && woff) {
    res.setHeader("content-type","font/woff2")
    return readFile(woff).then(data=>res.end(data),()=>res.end())
  }
  const paged = new URL(req.url, "http://127.0.0.1").searchParams
  res.setHeader("content-type","text/html; charset=utf-8")
  res.end(`<!doctype html><title>Ladybird form trial</title>
    <style>@font-face{font-family:Trial;src:url('/example.woff2')}body{background:#e8ecff;color:#111;font:18px sans-serif}.spin{width:60px;height:60px;background:#d43;animation:rot 1s infinite linear}@keyframes rot{to{transform:rotate(360deg)}}section{height:3000px}</style>
    <h1>Ladybird ${req.url.startsWith("/trial") ? "web" : "SideCar"}</h1>
    <form><label>Display name <input required value="initial"></label><button>Save</button></form><output>Waiting</output>
    ${paged.has("covered") ? '<div style="position:fixed;inset:0;z-index:2;background:#ffffff18"></div>' : ""}
    <p id="features"></p><img alt="Blue swatch" src="/image.svg" onload="document.querySelector('#features').textContent+=' Image OK'">
    ${paged.has("animate") ? '<div class="spin"></div>' : ""}<section><p>Long content</p></section><footer>End marker</footer>
    <script>document.querySelector('form').onsubmit=e=>{e.preventDefault();document.querySelector('output').textContent='Saved: '+document.querySelector('input').value};
      addEventListener('scroll',()=>{if(scrollY>0 && !window.scrolledOnce){ window.scrolledOnce=true;
        document.querySelector('#features').textContent+=' Scroll OK'; }});
      if(typeof document.fonts?.load === 'function') document.fonts.load('18px Trial').then(()=>document.querySelector('#features').textContent+=' Font OK',()=>{});
      else document.querySelector('#features').textContent+=' Font API absent';
      const socket=new WebSocket('ws://'+location.host+location.pathname.replace(/trial$/, '')+'ws');
      socket.onmessage=()=>document.querySelector('#features').textContent+=' Socket OK';</script>`)
})
if(solid) {
  const ws=path.join(solid,"..","..","node_modules","ws","wrapper.mjs")
  const {WebSocketServer}=await import(pathToFileURL(ws).href)
  const wss=new WebSocketServer({server:app})
  wss.on("connection",socket=>socket.send("hello"))
}
const appPort = await listen(app)
const content = `http://127.0.0.1:${appPort}/trial`
const requested = [
  {action:"open",url:content},
  {action:"snapshot",query:"Display name"},
  {action:"type",text:"Agent Ladybird",clear:true},
  {action:"press",key:"Enter"},
  {action:"wait",text:"Saved: Agent Ladybird",timeout:2000},
]
let modelTurn=0, modelError
const modelRequests=[]
const chatSent=[]
const provider = createServer(async(req,res)=>{
  const buffers=[]
  for await (const b of req) buffers.push(b)
  const input=JSON.parse(Buffer.concat(buffers).toString() || "{}")
  const chunk=(delta,finish_reason)=>`data: ${JSON.stringify({id:"trial",model:"fixture",
    object:"chat.completion.chunk",choices:[{index:0,delta,finish_reason}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}})}\n\n`
  const user = input.messages?.filter(m=>m.role==="user").at(-1)?.content
  if (JSON.stringify(user)?.includes("Rune Ladybird latency fixture")) {
    res.setHeader("Content-Type","text/event-stream")
    res.write(chunk({role:"assistant"},null))
    for (let i=0; i<25 && !res.destroyed; i++) {
      chatSent[i]=Date.now()
      res.write(chunk({content:`LBD${i}; `},null))
      await delay(55)
    }
    res.end(chunk({},"stop")+"data: [DONE]\n\n")
    return
  }
  const tool=input.tools?.find(t=>/codenomad.*browser|^browser$/.test(t.function?.name ?? ""))?.function?.name
  const latest=input.messages?.filter(m=>m.role==="tool").at(-1)?.content
  modelRequests.push({hasTool:!!tool,lastTool:latest?.slice(0,1200)})
  const operation=requested[modelTurn]
  let delta, reason="stop"
  if (tool && operation) {
    const ref=latest?.match(/\[([0-9]+-e[0-9]+)\]\s+textbox Display name/)?.[1]
    if(operation.action==="type" && !ref) modelError=`Expected textbox ref: ${latest}`
    if(modelError) delta={role:"assistant",content:"Browser trial failed"}
    else {
      delta={role:"assistant",tool_calls:[{index:0,id:`call_${modelTurn}`,type:"function",function:{
        name:tool,arguments:JSON.stringify({...operation,...(operation.action==="type"?{ref}:{})})
      }}]}
      modelTurn++
      reason="tool_calls"
    }
  } else {
    if(!tool && modelTurn===0) modelError="codenomad.browser not advertised to the agent"
    if(modelTurn===requested.length && !latest?.includes("matched")) modelError=`Unexpected wait result: ${latest}`
    delta={role:"assistant",content:modelError?"Browser trial failed":"FORM_AGENT_OK"}
  }
  res.setHeader("Content-Type","text/event-stream")
  res.end(chunk(delta,null)+chunk({},reason)+"data: [DONE]\n\n")
})
const providerPort=await listen(provider)
const configDir=path.join(env.XDG_CONFIG_HOME,"opencode")
await mkdir(configDir,{recursive:true})
await writeFile(path.join(configDir,"opencode.json"),JSON.stringify({
  model:"fixture/fixture", providers:{fixture:{package:"@opencode/ai/providers/openai-compatible",
    settings:{baseURL:`http://127.0.0.1:${providerPort}/v1`,apiKey:"fixture-only"},models:{fixture:{}}}},
}))
env.OPENCODE_DISABLE_MODELS_FETCH="1"
const finish = path.join(root,"finish")
const children = []
function start(file, args, options) {
  const p = spawn(file,args,{windowsHide:true, ...options})
  p.done = new Promise(resolve=>p.once("close",resolve))
  children.push(p)
  return p
}
async function eventually(label, f, ms=25000) {
  for (const end=Date.now()+ms; Date.now()<end; await delay(120)) {
    const r=await f()
    if(r) return r
  }
  throw Error(`Timed out: ${label}`)
}
const trials = {}
const workers = []
let privateDaemonStarted = false
async function check(name, fn) {
  try { const r=await fn(); trials[name]=r; console.log(name,JSON.stringify(r).slice(0,1500)); return r }
  catch (e) { trials[name]={error:String(e)}; console.log(name,String(e)); }
}

try {
  assert((await oc("debug","paths","state")).startsWith(profile))
  await oc("service","set","port",String(port))
  await oc("service","set","hostname","127.0.0.1")
  assert.equal(await oc("service","status"),"stopped")
  const daemon = await oc("service","start")
  assert.equal(daemon,`http://127.0.0.1:${port}`)
  privateDaemonStarted = true
  const password=await oc("service","get","password")
  const login=Buffer.from(`opencode:${password}`).toString("base64")
  if (process.env.RUNE_LADYBIRD_LOAD === "1") {
    for (let i=0; i<8; i++) workers.push(new Worker("for (;;) Math.sqrt(Math.random());", {eval:true}))
  }
  const native=(route,init={})=>fetch(`${daemon}/api/${route}`,{...init,signal:AbortSignal.timeout(30_000),
    headers:{authorization:`Basic ${login}`,"x-opencode-directory":encodeURIComponent(project),"content-type":"application/json",...init.headers}})
  const p=start(rune,["--probe-ladybird"],{cwd:project,env:{...env,CODENOMAD_PROFILE:"trial-ladybird",RUNE_SERVER_BIN:exe,
    RUNE_HOST_ROOT:path.join(root,"host"), RUNE_TRIAL_OPENCODE_BIN:cli,RUNE_TRIAL_OPENCODE_PROFILE:profile,RUNE_TEST_FOLDER:project,
    RUNE_LADYBIRD_BIN:ladybird,RUNE_LADYBIRD_TEST_FILE:local,RUNE_LADYBIRD_PROBE_FINISH:finish,RUNE_LADYBIRD_SIDECAR_PORT:String(appPort),
    RUNE_LADYBIRD_CONSOLE:"1",RUNE_LADYBIRD_PROBE_DPI:process.env.RUNE_LADYBIRD_PROBE_DPI ?? "1"},stdio:["ignore","pipe","pipe"]})
  let info, metrics, resized, stderr=""
  p.stderr.on("data", b=>{stderr=(stderr+b).slice(-100_000)})
  createInterface({input:p.stdout}).on("line",line=>{
    if(line.startsWith("LADYBIRD_TRIAL ")) info=JSON.parse(line.slice("LADYBIRD_TRIAL ".length))
    if(line.startsWith("LADYBIRD_METRICS ")) metrics=JSON.parse(line.slice("LADYBIRD_METRICS ".length))
    if(line==="LADYBIRD_RESIZED") resized=true
  })
  try {
    await eventually("Rune session",()=>{if(p.exitCode!==null)throw Error(stderr);return info},80000)
    assert((await native(`session/${info.session}`)).ok)
    console.log("real Rust backend and private OpenCode session ready; SideCar:",info.sidecar)
    const dir=path.join(env.LOCALAPPDATA,"CodeNomad","automation-bridges")
    const registrations=await readdir(dir)
    assert.equal(registrations.length,1)
    const bridge=JSON.parse(await readFile(path.join(dir,registrations[0]),"utf8"))
    async function call(mode,params={}) {
      const body=JSON.stringify({mode,sessionID:info.session,...params})
      const {status,packet}=await new Promise((resolve,reject)=>{
        const req=request(bridge.url,{method:"POST",headers:{"content-type":"application/json","content-length":Buffer.byteLength(body),
          "x-codenomad-automation-token":bridge.token},signal:AbortSignal.timeout(25_000)},res=>{
          let raw=""
          res.on("data",d=>{raw+=d})
          res.on("end",()=>{try {resolve({status:res.statusCode,packet:JSON.parse(raw)})}catch(e){reject(e)}})
          res.on("error",reject)
        })
        req.on("error",reject)
        req.end(body)
      })
      if(status!==200) throw Error(`${status} ${JSON.stringify(packet)}`)
      return packet.result
    }
    async function tool(command) {
      const target=command.action==="open"?null:(await call("browser-probe")).target
      return call("browser-execute",{target,command,deadline:Date.now()+12000})
    }
    const snap=(query)=>tool({action:"snapshot",query})
    const ref=(s,pattern)=>s.snapshot.split("\n").find(line=>pattern.test(line))?.match(/^\s*\[([^\]]+)\]/)?.[1]
    const navigate=url=>tool({action:"navigate",url})
    const wait=(text,timeout=2500)=>tool({action:"wait",text,timeout})
    async function processes() {
      const cmd=`$r=Get-Process -Id ${p.pid}; $all=@(Get-CimInstance Win32_Process);
        $kids=@($all | Where-Object { $_.ParentProcessId -eq $r.Id -and $_.Name -eq 'RuneLadybird.exe' -and $_.CreationDate -ge $r.StartTime });
        $ids=@($r.Id);
        while($kids.Count) { $k=$kids[0]; $kids=@($kids | Select-Object -Skip 1);
          $ids+= $k.ProcessId; $kids+= @($all | Where-Object { $_.ParentProcessId -eq $k.ProcessId -and $_.CreationDate -ge $k.CreationDate -and $_.Name -ne 'conhost.exe' }); }
        @((Get-Process -Id $ids -ErrorAction SilentlyContinue | ForEach-Object { @{pid=$_.Id;name=$_.ProcessName;cpu=$_.CPU;rss=$_.WorkingSet64;private=$_.PrivateMemorySize64} })) | ConvertTo-Json -Compress`;
      const raw=JSON.parse(await exec("powershell.exe",["-NoProfile","-Command",cmd]))
      return Object.fromEntries([raw].flat().map(row=>[row.pid,row]))
    }
    async function sample() {
      const before=await processes()
      const started=performance.now()
      await delay(3000)
      const after=await processes()
      const seconds=(performance.now()-started)/1000
      const samples = Object.fromEntries(Object.entries(after).map(([k,n])=>[k,{
        name:n.name,corePercent:Math.round(1000*(n.cpu-(before[k]?.cpu ?? n.cpu))/seconds)/10,
        rssMB:Math.round(n.rss/1e6),privateMB:Math.round(n.private/1e6),
      }]))
      const engine = Object.values(samples).filter(n=>n.name!=="codenomad-rune")
      return {seconds, rune:samples[p.pid], ladybird:{
        corePercent:engine.reduce((a,b)=>a+b.corePercent,0),
        rssMB:engine.reduce((a,b)=>a+b.rssMB,0),privateMB:engine.reduce((a,b)=>a+b.privateMB,0),
      }, processes:samples}
    }
    await check("file",async()=>{const start=performance.now(); const opened=await tool({action:"open",url:local});
      const snapshot=await snap();
      try { await wait("Ladybird local file") } catch(e) { return {opened,snapshot,error:String(e)} }
      return {...snapshot,coldMs:Math.round(performance.now()-start)}})
    const vite = await check("vite",async()=>{
      const rootVite=path.join(root,"vite")
      await cp(fixture,rootVite,{recursive:true,filter:p=>!p.includes("node_modules")})
      const src=path.join(rootVite,"App.jsx")
      await writeFile(src,`import {useState} from 'react';
        export default function App(){
          const [n,setN]=useState(0), [name,setName]=useState('initial');
          return <><button onClick={()=>setN(n+1)}>avant:{n}</button><label>React name <input value={name}
            onInput={e=>document.querySelector('#native-result').textContent='Native input: '+e.nativeEvent.inputType}
            onChange={e=>setName(e.target.value)}/></label><output>React value: {name}</output><output id="native-result"/></>;
        }`)
      await exec(process.execPath,[path.join(path.dirname(process.execPath),"node_modules","npm","bin","npm-cli.js"),
        "ci","--no-audit","--no-fund"],{cwd:rootVite})
      const testPort=tcp()
      const vitePort=await listen(testPort)
      await new Promise(resolve=>testPort.close(resolve))
      const child=start(process.execPath,[path.join(rootVite,"node_modules","vite","bin","vite.js"),"--host","127.0.0.1","--port",String(vitePort),"--strictPort"],
        {cwd:rootVite,env,stdio:["ignore","pipe","pipe"]})
      let output=""
      for(const stream of [child.stdout,child.stderr]) stream.on("data",b=>{output+=b})
      const url=`http://127.0.0.1:${vitePort}/`
      await eventually("Vite",async()=>{if(child.exitCode!==null)throw Error(output);return (await fetch(url).catch(()=>null))?.ok},15000)
      const started=performance.now(); await navigate(url); await wait("avant:0",10000)
      const navMs=Math.round(performance.now()-started)
      const id=ref(await snap("avant"),/avant:0/)
      assert(id)
      await tool({action:"click",ref:id})
      await wait("avant:1")
      await writeFile(src,(await readFile(src,"utf8")).replace("avant:","après:"))
      await wait("après:1",7500)
      const name=ref(await snap("React name"),/React name/)
      const typed=await tool({action:"type",ref:name,text:"Été React"})
      const reacted=(await wait("React value: Été React").catch(()=>null))?.matched===true
      return {url,navMs,hmr:"après:1",typed,reacted,text:await snap("input")}
    })
    const solidTrial = async()=>{
      const vite=path.join(solid,"..","..","node_modules","vite","dist","node","index.js")
      const reservation=tcp()
      const port=await listen(reservation)
      await new Promise(resolve=>reservation.close(resolve))
      const target = new URL(info.server).origin
      const ui = path.join(root,"solid","packages","ui")
      await mkdir(path.dirname(ui),{recursive:true})
      await cp(solid,ui,{recursive:true,filter:p=>!/(^|[\\/])(node_modules|dist|\.vite)([\\/]|$)/.test(p)})
      await cp(path.resolve(solid,"../server/src"),path.resolve(ui,"../server/src"),{recursive:true})
      const speech = path.resolve(solid,"../desktop-speech")
      const speechFixture = path.resolve(ui,"../desktop-speech")
      await mkdir(speechFixture,{recursive:true})
      for (const name of (await readdir(speech)).filter(name=>name.endsWith(".ts"))) {
        await copyFile(path.join(speech,name),path.join(speechFixture,name))
      }
      await symlink(path.resolve(solid,"../..","node_modules"), path.join(root,"solid","node_modules"), "junction")
      const source=`import {createServer} from ${JSON.stringify(pathToFileURL(vite).href)};
        const origin='http://127.0.0.1:${port}', target=${JSON.stringify(target)};
        // Translate the exact fixture origin for this reverse proxy; don't supply any credential.
        const api={target,changeOrigin:true,configure(proxy){
          proxy.on('proxyReq',(out, req)=>{
            if (req.headers.origin===origin) out.setHeader('origin',target);
            if (req.headers.referer?.startsWith(origin+'/')) out.setHeader('referer',target+req.headers.referer.slice(origin.length));
          });
        }};
        const v=await createServer({configFile:${JSON.stringify(path.join(ui,"vite.config.ts"))},cacheDir:${JSON.stringify(path.join(root,"solid-cache"))},server:{port:${port},strictPort:true,host:'127.0.0.1',
          proxy:{'/api':api,'/workspaces':api,'/login':api},fs:{allow:${JSON.stringify([path.join(root,"solid"),path.resolve(solid,"../.."),path.join(root,"solid-cache")])}}}});
        await v.listen(); console.log('VITE '+v.httpServer.address().port);`
      const launch=path.join(root,"solid.mjs")
      await writeFile(launch,source)
      const child=start(process.execPath,[launch],{cwd:ui,env,stdio:["ignore","pipe","pipe"]})
      let output=""
      for(const stream of [child.stdout,child.stderr]) stream.on("data",b=>{output+=b})
      await eventually("Solid Vite",()=>{if(child.exitCode!==null)throw Error(output);return output.includes(`VITE ${port}`)},15000)
      const pageUrl = `http://127.0.0.1:${port}/`
      const api = await fetch(`http://127.0.0.1:${port}/api/auth/status`,{signal:AbortSignal.timeout(5_000)})
      const auth = await api.json()
      const entry=await fetch(`http://127.0.0.1:${port}/main.tsx`,{signal:AbortSignal.timeout(10_000)}).catch(e=>e)
      const entryStatus=entry.status ?? null
      const entryDetail=entry instanceof Error?String(entry):entry.ok?null:(await entry.text()).slice(0,350)
      let snapshot, ladybirdError
      try {
        await navigate(pageUrl)
        await delay(1800)
        snapshot=await snap()
        const shot=await tool({action:"screenshot"})
        await writeFile(path.join(root,"solid.png"),Buffer.from(shot.image.data,"base64"))
      } catch(error) { ladybirdError=String(error) }
      if(process.env.RUNE_LADYBIRD_CHROMIUM) {
        const {chromium}=await import(pathToFileURL(path.join(solid,"../..","node_modules","playwright","index.mjs")).href)
        const browser=await chromium.launch({executablePath:process.env.RUNE_LADYBIRD_CHROMIUM,headless:true,env,
          args:["--disable-background-networking","--disable-notifications"]})
        try {
          const page=await browser.newPage()
          const errors=[]
          page.on("pageerror",e=>errors.push(e.message))
          page.on("response",r=>{if(r.status()>=400) errors.push(`${r.status()} ${new URL(r.url()).pathname}`)})
          await page.goto(pageUrl,{timeout:12000})
          await delay(800)
          const comparison=await page.locator("body").innerText()
          const status=await page.goto(content,{timeout:5000})
          await page.getByRole("textbox",{name:"Display name"}).fill("Chromium")
          await page.getByRole("button",{name:"Save"}).click()
          await page.getByText("Saved: Chromium",{exact:true}).waitFor()
          return {...snapshot,ladybirdError,apiStatus:api.status,auth,entryStatus,entryDetail,chromium:{solid:comparison.slice(0,350),form:status?.status(),errors:errors.slice(0,8)}}
        } catch(error) {
          return {...snapshot,ladybirdError,apiStatus:api.status,auth,entryStatus,entryDetail,chromiumError:String(error)}
        } finally {
          await browser.close()
          await writeFile(path.join(root,"solid-vite.log"),output)
        }
      }
      await writeFile(path.join(root,"solid-vite.log"),output)
      return {...snapshot,ladybirdError,apiStatus:api.status,auth,entryStatus,entryDetail}
    }
    await check("form",async()=>{
      await navigate(content)
      const name=ref(await snap("Display name"),/Display name/)
      assert(name)
      const typed=await tool({action:"type",ref:name,text:"Été 日本",clear:true})
      assert.equal(typed.value,"Été 日本")
      await tool({action:"press",key:"Enter"})
      await wait("Saved: Été 日本")
      const shot=await tool({action:"screenshot"})
      await writeFile(path.join(root,"form.png"),Buffer.from(shot.image.data,"base64"))
      await tool({action:"scroll",direction:"down",amount:700})
      await wait("Scroll OK")
      return {typed,image:shot.image.data.length}
    })
    await check("features",async()=>{
      await navigate(content)
      const observed={}
      for(const text of ["Image OK","Font OK","Font API absent","Socket OK"]) observed[text]=(await wait(text,900).catch(()=>null))?.matched===true
      return observed
    })
    await check("ownership",async()=>{
      const {target}=await call("browser-probe")
      await assert.rejects(tool({action:"open",url:content}),/preview-in-use/)
      await navigate(content+"?covered")
      await assert.rejects(call("browser-execute",{target,command:{action:"snapshot"}}),/stale-preview/)
      const save=ref(await snap("Save"),/Save/)
      assert(save)
      await assert.rejects(tool({action:"click",ref:save}),/covered/)
      return {duplicate:true,staleTarget:true,covered:true}
    })
    await check("idle",sample)
    await check("sidecar",async()=>{
      assert.equal(info.sidecar?.status,201)
      const r=info.sidecar.body
      await navigate(`${info.server}sidecars/${r.id ?? r.sidecar?.id}/`)
      return await snap()
    })
    await check("animation",async()=>{
      await navigate(content+"?animate&phase=animation")
      const png=()=>tool({action:"screenshot"}).then(s=>s.image.data)
      const before=await png()
      const usage=await sample()
      assert.notEqual(before,await png(),"animation produced identical images")
      return usage
    })
    await check("scroll-active",async()=>{
      await navigate(content+"?animate&phase=scroll")
      const usage = sample()
      for (let n=0;n<9;n++) {
        await tool({action:"scroll",direction:n%2?"up":"down",amount:700})
        await delay(220)
      }
      await wait("Scroll OK")
      return await usage
    })
    if(process.env.RUNE_LADYBIRD_AGENT==="1") await check("agent",async()=>{
      // The existing preview can be navigated; open was already exercised above.
      requested[0]={action:"snapshot"}
      requested.splice(1,0,{action:"navigate",url:content},{action:"snapshot"})
      const prompted=await native(`session/${info.session}/prompt`,{method:"POST",body:JSON.stringify({
        text:"Use codenomad.browser to fill Display name with Agent Ladybird, submit, and verify the saved result.",
        model:{providerID:"fixture",modelID:"fixture"},
      })})
      assert(prompted.ok,await prompted.text())
      let log
      try {
        await eventually("agent tool calls",async()=>{
          log=await (await native(`session/${info.session}/message?limit=20`)).text()
          return log.includes("FORM_AGENT_OK") || modelError ? log : undefined
        },35000)
      } finally {
        await writeFile(path.join(root,"agent.json"),log ?? "[]")
        await writeFile(path.join(root,"agent-model.json"),JSON.stringify({modelTurn,modelError,modelRequests},null,2))
      }
      assert(!modelError,modelError)
      assert.equal(modelTurn,requested.length)
      assert(log.includes("FORM_AGENT_OK"))
      return {model:"deterministic local provider",nativeToolCalls:modelTurn}
    })
    await check("chat-stream",async()=>{
      await navigate(content+"?animate&phase=chat")
      const prompted = await native(`session/${info.session}/prompt`,{method:"POST",body:JSON.stringify({
        text:"Rune Ladybird latency fixture",model:{providerID:"fixture",modelID:"fixture"},
      })})
      assert(prompted.ok,await prompted.text())
      const seen=path.join(root,"chat-seen.json")
      const samples=await eventually("chat chunk reception in Rune",async()=>{
        try { return JSON.parse(await readFile(seen,"utf8")) } catch { return null }
      },10000)
      const transfer=samples.map((t,i)=>t-chatSent[i]).sort((a,b)=>a-b)
      assert.equal(transfer.length,25)
      return {chunks:transfer.length,firstMs:samples[0]-chatSent[0],p95Ms:transfer[Math.ceil(transfer.length*.95)-1],maxMs:transfer.at(-1)}
    })
    await check("reload-resize",async()=>{
      const old=(await call("browser-probe")).target
      await writeFile(path.join(root,"reload"),"")
      await eventually("resize from Rune",()=>resized)
      await eventually("reload generation",async()=> (await call("browser-probe")).target!==old)
      await eventually("reloaded page",()=>wait("Waiting",350).catch(()=>null),5000)
      const image=await eventually("resized screenshot",async()=>{
        const page = Buffer.from((await tool({action:"screenshot"})).image.data,"base64")
        return page.readUInt32BE(16)<1100*(Number(process.env.RUNE_LADYBIRD_PROBE_DPI) || 1) ? page : null
      },5000)
      const width=image.readUInt32BE(16)
      await writeFile(path.join(root,"resized.png"),image)
      await writeFile(path.join(root,"capture"),"")
      await eventually("Rune composite capture",async()=> (await readdir(root)).includes("rune-composite.png"),5000)
      return {width,height:image.readUInt32BE(20)}
    })
    if(solid && process.env.RUNE_LADYBIRD_NO_SOLID!=="1") await check("solid",solidTrial)
    await writeFile(finish,"")
    await p.done
    console.log("metrics",JSON.stringify(metrics),"evidence",root)
    await writeFile(path.join(root,"results.json"),JSON.stringify({trials,metrics},null,2))
  } finally { await writeFile(path.join(root,"rune.log"),stderr) }
} finally {
  await Promise.all(workers.map(worker=>worker.terminate()))
  await writeFile(finish,"")
  for (const p of children.reverse()) {
    await Promise.race([p.done,delay(1500)])
    if(p.exitCode===null) p.kill()
    await p.done
  }
  if (privateDaemonStarted) await oc("service","stop").catch(()=>{})
  app.closeAllConnections()
  await new Promise(resolve=>app.close(resolve))
  await new Promise(resolve=>provider.close(resolve))
}
