// Real HTTP servers, independent recording OpenCode substitutes, no provider or service discovery.
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {createHash, randomUUID} from 'node:crypto'
import {createServer, request as httpRequest} from 'node:http'
import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {pathToFileURL} from 'node:url'
import {setTimeout as delay} from 'node:timers/promises'
import {privateEnvironment} from '../../rune-app/fixtures/private-profile.mjs'
import {out, repo, rustBinary} from './fixtures.mjs'

const post = body => ({method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
const digest = body => createHash('sha256').update(JSON.stringify(body)).digest('hex')
const listen = server => new Promise(resolve => server.listen(0,'127.0.0.1',()=>resolve(`http://127.0.0.1:${server.address().port}`)))
const close = server => new Promise(resolve => {server.closeAllConnections();server.close(resolve)})
const data = size => `data:application/octet-stream;base64,${Buffer.alloc(size,97).toString('base64')}`
const http = (url,init={}) => new Promise((resolve,reject)=>{
  let responded=false
  const request=httpRequest(url,{method:init.method??'GET',headers:{...init.headers,...(init.body?{'content-length':Buffer.byteLength(init.body)}:{})}},response=>{
    responded=true
    const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>resolve({status:response.statusCode,
      headers:{get:key=>response.headers[key]},text:async()=>Buffer.concat(chunks).toString(),arrayBuffer:async()=>Buffer.concat(chunks)}))
  });request.on('error',error=>{if(!responded)resolve({status:error.code??String(error),headers:{get:()=>null},text:async()=>'',arrayBuffer:async()=>{}})});request.setTimeout(30000,()=>request.destroy(Error('HTTP deadline')))
  const body=Buffer.from(init.body??'');(async()=>{for(let at=0;at<body.length&&!responded;at+=262144){request.write(body.subarray(at,at+262144));await delay(1)}request.end()})().catch(reject)
})

async function upstream(profile) {
  const directory = path.join(profile,'workspace'), foreign = path.join(profile,'foreign')
  await mkdir(directory);await mkdir(foreign)
  await writeFile(path.join(directory,'a b#%.txt'),'synthetic\n')
  const calls = [], sessions = new Map(), password = randomUUID()
  for (const [id,dir,metadata] of [['ses_owned',directory,{}],['ses_foreign',foreign,{}],['ses_cn_schedule_reserved',directory,{}],['ses_carrier',directory,{'codenomad.schedule-carrier':true}]])
    sessions.set(id,{id,title:'Synthetic',projectID:'project_fixture',location:{directory:dir},metadata,time:{created:1,updated:1}})
  const server = createServer(async(req,res)=>{
    try {
      assert.equal(req.headers.authorization,`Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`)
      const url = new URL(req.url,'http://fixture'), chunks=[]
      for await(const chunk of req) chunks.push(chunk)
      const raw=Buffer.concat(chunks).toString(),body=raw?JSON.parse(raw):undefined
      calls.push({method:req.method,path:url.pathname,body})
      const send=(value,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value))}
      if(url.pathname==='/api/info')return send({version:'2.3.2',pid:process.pid})
      if(url.pathname==='/api/event'){res.writeHead(200,{'content-type':'text/event-stream'});res.write(': isolated\n\n');return}
      if(url.pathname==='/api/location')return send({directory,project:{id:'project_fixture',canonical:directory,directory}})
      if(url.pathname==='/api/project')return send([{id:'project_fixture',canonical:directory,sandboxes:[],time:{created:1,updated:1}}])
      if(url.pathname==='/api/session/active')return send({data:{}})
      if(url.pathname==='/api/session')return send({data:[],cursor:{}})
      if(url.pathname.startsWith('/api/rpc/'))return send({_tag:'RpcError',type:'rpc.method_not_found',message:'Fixture plugin absent'},400)
      const match=url.pathname.match(/^\/api\/session\/([^/]+)(?:\/(.*))?$/)
      if(match){const session=sessions.get(match[1]);if(!session)return send({type:'session.not_found'},404)
        if(!match[2])return send({data:session})
        if(match[2]==='environment'){res.writeHead(204);return res.end()}
        if(match[2]==='prompt')return send({data:{id:body.id??`inbox_${calls.length}`,sessionID:session.id,type:'user',payload:body}})
        if(match[2]==='interrupt')return send({data:true})
      }
      return send({data:[]})
    }catch(error){res.writeHead(500);res.end(JSON.stringify({error:String(error)}))}
  })
  return {directory,foreign,calls,password,origin:await listen(server),close:()=>close(server)}
}

async function start(label,profile,native) {
  const env=await privateEnvironment(profile),password=randomUUID(),config=path.join(profile,'config/config.yaml')
  await writeFile(config,'server:\n  environmentVariables: {}\n')
  Object.assign(env,{CLI_CONFIG:config,CNRS_FIXTURE_URL:native.origin+'/',CNRS_FIXTURE_PASSWORD:native.password,
    CNRS_FIXTURE_PID:String(process.pid),CNRS_SERVER_PASSWORD:password,CODENOMAD_SERVER_PASSWORD:password,
    CNRS_FIXTURE_STDIN_STOP:'1',CODENOMAD_NATIVE_BROWSER_AUTOMATION:'0'})
  const probe=createServer(),reserved=await listen(probe),port=new URL(reserved).port;await close(probe)
  const args=label==='ts'?[path.join(repo,'packages/server-rs/bench/ts-server.mjs'),'--http','true','--https','false','--http-port',port,
    '--ui-no-update','--config',config,'--workspace-root',native.directory]:[native.directory,path.join(profile,'rust.json'),port,'']
  const child=spawn(label==='ts'?process.execPath:rustBinary(),args,{cwd:profile,env,windowsHide:true,stdio:['pipe','pipe','pipe']})
  let log='';for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{if(log.length<2**20)log+=chunk})
  const exit=new Promise(resolve=>child.once('close',resolve));child.stdin.on('error',()=>{})
  const origin=`http://127.0.0.1:${port}`
  const request=(route,init={})=>http(origin+route,init)
  const stop=async()=>{if(child.exitCode===null){child.stdin.end(label==='ts'?'codenomad:shutdown\n':'shutdown\n');await Promise.race([exit,delay(2000)])}
    if(child.exitCode===null){child.kill();await exit}await writeFile(path.join(profile,`${label}.log`),log.replaceAll(password,'<redacted>').replaceAll(native.password,'<redacted>'))}
  try{
    for(const end=Date.now()+60000;;await delay(100)){
      if((await request('/api/auth/status').catch(()=>undefined))?.status===200)break
      assert(child.exitCode===null&&Date.now()<end,`${label} startup failed: ${log.slice(-1800)}`)
    }
    const login=await request('/api/auth/login',post({username:'codenomad',password}));assert.equal(login.status,200)
    const cookie=String(login.headers.get('set-cookie')).split(';')[0]
    const call=(route,init={})=>request(route,{...init,headers:{...init.headers,cookie}})
    const opened=await call('/api/workspaces',post({path:native.directory}));const text=await opened.text()
    assert.equal(opened.status,201,`${label} workspace: ${text}`)
    return {call,base:`/workspaces/${JSON.parse(text).id}/instance/api`,stop}
  }catch(error){await stop();throw error}
}

function cases(native){
  const file=path.join(native.directory,'a b#%.txt'),uri=pathToFileURL(file)
  const mib=1024*1024
  return [
    ['text-first',{text:'first',id:'inbox_first'}],['text-second',{text:'second',id:'inbox_second'}],
    ['all-fields',{text:'context',files:[{uri:uri.href,source:{type:'uri',uri:uri.href},name:'a b#%.txt',description:'fixture',mention:{start:0,end:7,text:'context'}}],agents:[{name:'build'}],skills:[{id:'fixture'}],metadata:{display:'fixture'},resume:false,id:'inbox_context',delivery:'queue'}],
    ['inline',{text:'bytes',files:[{uri:data(1024*1024)}]}],
    ['project-path',{text:'path',files:[{uri:file}]}],['remote-uri',{text:'remote',files:[{uri:'https://fixture.invalid/resource'}]}],
    ['file-exact',{files:[{uri:data(5*mib)}]}],['file-over',{files:[{uri:data(5*mib+1)}]}],
    ['count-exact',{files:Array.from({length:10},()=>({uri:data(1)}))}],['count-over',{files:Array.from({length:11},()=>({uri:data(1)}))}],
    ['total-exact',{files:Array.from({length:4},()=>({uri:data(5*mib)}))}],['total-over',{files:[...Array.from({length:4},()=>({uri:data(5*mib)})),{uri:data(1)}]}],
    ['bad-base64',{files:[{uri:'data:text/plain;base64,abc'}]}],['bad-percent',{files:[{uri:'data:text/plain,%zz'}]}],
    ['percent-utf8',{files:[{uri:'data:text/plain,%C3%A9'}]}],['files-object',{files:{}}],['file-null',{files:[null]}],['file-empty',{files:[{uri:' '}]}],
    ['relative',{files:[{uri:'relative.txt'}]}],['file-query',{files:[{uri:uri.href+'?x=1'}]}],['file-encoded-slash',{files:[{uri:'file:///D:/a%2fb'}]}],
    ['foreign-file',{files:[{uri:path.join(native.foreign,'private.txt')}]}],['foreign-location',{text:'x',location:{directory:native.foreign}}],
    ['carrier-metadata',{text:'x',metadata:{schedule:null}}],['unknown-native-field',{text:'x',future:'kept'}],
    ['json-exact',{text:'x'.repeat(32*mib-11)}],['json-over',{text:'x'.repeat(32*mib-10)}],
  ]
}

export async function run(){
  const root=await mkdtemp(path.join(out,'trial-prompt-admission-')),result={root,binary:rustBinary(),environments:'real TS/Rust; separate simulated OpenCode; no model',sides:{}}
  result.binarySha256=createHash('sha256').update(await readFile(result.binary)).digest('hex')
  const active=[]
  try{
    for(const label of ['ts','rs']){
      const profile=path.join(root,label);await mkdir(profile)
      const native=await upstream(profile);active.push(()=>native.close())
      const host=await start(label,profile,native);active.push(()=>host.stop())
      const rows=result.sides[label]=[]
      for(const [name,body] of cases(native)){
        const before=native.calls.length,response=await host.call(`${host.base}/session/ses_owned/prompt`,post(body)).catch(error=>({status:error.code??String(error),arrayBuffer:async()=>{}}))
        await response.arrayBuffer()
        const calls=native.calls.slice(before),forwarded=calls.filter(r=>r.path==='/api/session/ses_owned/prompt')
        if(forwarded.length)assert.deepEqual(forwarded[0].body,body,`${label} ${name} forwarding`)
        rows.push({name,status:response.status,bytes:Buffer.byteLength(JSON.stringify(body)),forwarded:forwarded.length,
          environment:calls.filter(r=>r.path.endsWith('/environment')).length,bodyHashVerified:forwarded.length?digest(forwarded[0].body)===digest(body):null})
      }
      for(const session of ['ses_foreign','ses_cn_schedule_reserved','ses_carrier']){
        const before=native.calls.length,response=await host.call(`${host.base}/session/${session}/prompt`,post({text:'refuse'}));await response.arrayBuffer()
        rows.push({name:session,status:response.status,forwarded:native.calls.slice(before).filter(r=>r.path.endsWith('/prompt')||r.path.endsWith('/environment')).length})
      }
      for(const [name,route,body] of [['interrupt-valid','interrupt',{}],['interrupt-invalid','interrupt',{resume:'bad'}],['model-large','model',{model:'x'.repeat(1024*1024)}]]){
        const response=await host.call(`${host.base}/session/ses_owned/${route}`,post(body));await response.arrayBuffer();rows.push({name,status:response.status})
      }
      result.sides[label]=rows
      await host.stop();active.pop();await native.close();active.pop()
    }
    result.differences=result.sides.ts.flatMap((row,index)=>JSON.stringify(row)===JSON.stringify(result.sides.rs[index])?[]:[{name:row.name,ts:row,rs:result.sides.rs[index]}])
    assert.equal(result.differences.length,0,`Prompt parity: ${result.differences.map(row=>`${row.name} TS=${row.ts.status} Rust=${row.rs.status}`).join(', ')}`)
  }catch(error){result.error=String(error.stack);process.exitCode=1}
  finally{for(const stop of active.reverse())await stop();await writeFile(path.join(root,'proof.json'),JSON.stringify(result,null,2)+'\n')}
  console.log(JSON.stringify({root,differences:result.differences?.map(row=>({name:row.name,ts:row.ts.status,rs:row.rs.status})),error:result.error}))
}
