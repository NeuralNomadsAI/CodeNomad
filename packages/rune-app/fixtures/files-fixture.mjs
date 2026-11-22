// Actual Rust filesystem routes and the typed client; no native window or installed daemon.
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {randomUUID,createHash} from 'node:crypto'
import {mkdir,stat,copyFile,readFile,writeFile,symlink} from 'node:fs/promises'
import {createServer,request} from 'node:http'
import os from 'node:os'
import path from 'node:path'
import {privateEnvironment} from './private-profile.mjs'
import {stopFixtureChild} from '../../../scripts/native-fixture-guards.mjs'

const repository=path.resolve(import.meta.dirname,'../../..')
const write=process.argv.includes('--write')
const reader=process.argv.includes('--reader')
assert(!(write&&reader),'Reader qualification stays read-only')
const source=process.env.RUNE_SERVER_EXE,target=process.env.CARGO_TARGET_DIR
for(const [name,value]of Object.entries({RUNE_SERVER_EXE:source,CARGO_TARGET_DIR:target}))assert(value&&path.isAbsolute(value),`${name} must be explicit and absolute`)
assert((await stat(source)).isFile(),'Explicit Rust server is missing')
assert((await stat(target)).isDirectory(),'Cargo target must already exist; the fixture never creates a new build cache')
const root=path.join(repository,'target/rune-files-tests',`trial-${randomUUID()}`)
await mkdir(root,{recursive:true})
const directory=path.join(root,'project'),foreign=path.join(root,'foreign')
await mkdir(path.join(directory,'empty'),{recursive:true});await mkdir(path.join(directory,'nested'));await mkdir(path.join(directory,'.git'));await mkdir(foreign)
for(const [file,bytes]of [['été 日本語.txt','été\n日本語🦀\r\n'],['empty.txt',''],['binary.bin',Buffer.from([0,1,255,128,0,42])],
  ['nested/日本語.txt','nested bytes'],['full.bin',Buffer.alloc(5*1024*1024,0x93)],['oversized.bin',Buffer.alloc(5*1024*1024+1,0x93)],['.git/private.txt','protected']])await writeFile(path.join(directory,file),bytes)
await writeFile(path.join(foreign,'foreign.txt'),'private sibling bytes')
const proof={root,directory,foreign,write,reader,result:'failed',requests:[],nativeRequests:[],links:{},client:null,shutdown:null}
for(const [name,destination]of [['outward',foreign],['protected',path.join(directory,'.git')]]){
  try{await symlink(destination,path.join(directory,name),process.platform==='win32'?'junction':'dir');proof.links[name]={created:true}}
  catch(error){proof.links[name]={created:false,reason:error.code??'unavailable'}}
}
const binary=path.join(root,process.platform==='win32'?'codenomad-rs.exe':'codenomad-rs')
await copyFile(source,binary);proof.serverSha256=createHash('sha256').update(await readFile(binary)).digest('hex')
const password=randomUUID(),nativePassword=randomUUID(),env=await privateEnvironment(root)
let server,serverStopped,cargo,cargoStopped,proxy,failure,serverLog='',clientLog='',cookie,origin,workspace
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
const fake=createServer((req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1');proof.nativeRequests.push({method:req.method,path:url.pathname})
  res.setHeader('content-type','application/json')
  if(req.method==='GET'&&url.pathname==='/api/location'&&url.searchParams.get('location[directory]')===directory)
    return res.end(JSON.stringify({data:{directory}}))
  res.writeHead(404);res.end('{}')
})
fake.requestTimeout=15000;fake.headersTimeout=10000
await new Promise((resolve,reject)=>{fake.once('error',reject);fake.listen(0,'127.0.0.1',resolve)})
const call=async(route,method='GET',body)=>{
  const response=await fetch(`${origin}${route}`,{method,headers:{'content-type':'application/json',...(cookie?{cookie}:{})},
    ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(30000)})
  assert(response.ok,`Fixture setup ${method} ${route}: ${response.status}`);return response
}
try{
  server=spawn(binary,[root,path.join(root,'identity.json'),'0','fixture-only'],{cwd:root,windowsHide:true,stdio:['pipe','pipe','pipe'],
    env:{...env,CNRS_FIXTURE_URL:`http://127.0.0.1:${fake.address().port}/`,CNRS_FIXTURE_PASSWORD:nativePassword,
      CNRS_SERVER_PASSWORD:password,CNRS_FIXTURE_STDIN_STOP:'1'}})
  let spawnError
  serverStopped=new Promise(resolve=>{server.once('close',resolve);server.once('error',error=>{spawnError=error;resolve()})})
  for(const pipe of [server.stdout,server.stderr])pipe.on('data',bytes=>serverLog=(serverLog+bytes).slice(-1048576))
  for(const end=Date.now()+20000;!origin;){
    if(spawnError)throw spawnError
    assert(server.exitCode===null&&server.signalCode===null&&Date.now()<end,'Owned Rust startup failed')
    origin=serverLog.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];if(!origin)await sleep(25)
  }
  const login=await call('/api/auth/login','POST',{username:'codenomad',password})
  cookie=login.headers.get('set-cookie')?.split(';')[0];assert(cookie)
  workspace=(await(await call('/api/workspaces','POST',{path:directory})).json()).id;assert(workspace)
  proxy=createServer((req,res)=>{
    const url=new URL(req.url,origin),row={method:req.method,path:url.pathname};proof.requests.push(row)
    const privateWrite=write&&req.method==='PUT'&&url.pathname===`/api/workspaces/${workspace}/files/content`
      &&url.searchParams.getAll('directory').length===1&&url.searchParams.getAll('path').length===1
      &&((url.searchParams.get('directory')===directory&&['été 日本語.txt','.git/private.txt'].includes(url.searchParams.get('path')))
        ||(url.searchParams.get('directory')===foreign&&url.searchParams.get('path')==='foreign.txt'))
    if(req.method==='PUT'){row.directory=url.searchParams.get('directory');row.file=url.searchParams.get('path')}
    if(req.method!=='GET'&&!(req.method==='POST'&&url.pathname==='/api/auth/login')&&!privateWrite){
      row.blocked=true;res.writeHead(403);res.end('Read-only client fixture');return
    }
    const upstream=request(url,{method:req.method,headers:{...req.headers,host:url.host}},response=>{
      row.status=response.statusCode;res.writeHead(response.statusCode,response.headers);response.pipe(res)
    })
    upstream.setTimeout(30000,()=>upstream.destroy())
    upstream.on('error',()=>{row.failed=true;if(!res.headersSent)res.writeHead(502);res.end()})
    req.on('aborted',()=>upstream.destroy());res.on('close',()=>upstream.destroy());req.pipe(upstream)
  })
  proxy.requestTimeout=35000;proxy.headersTimeout=10000
  await new Promise((resolve,reject)=>{proxy.once('error',reject);proxy.listen(0,'127.0.0.1',resolve)})
  const manifest=path.join(root,'manifest.json')
  await writeFile(manifest,JSON.stringify({directory,foreign,workspaceId:workspace,origin:`http://127.0.0.1:${proxy.address().port}/`,
    write,reader,outwardLink:proof.links.outward.created,protectedLink:proof.links.protected.created})+'\n')
  const test=reader?['-p','codenomad-rune-app','--features','test-support','files::view::tests::server::real_rust_reader_ui_contract']
    :['-p','codenomad-client',...(write?['--test','files_write_server','real_rust_files_write_contract']:['--lib','files_tests::real_rust_files_read_contract'])]
  const args=['+1.99.1','test','--offline','--locked',...test,'--','--exact','--ignored','--nocapture']
  proof.command=['cargo',...args];proof.cargoTarget=target
  const cargoEnv={...env,CARGO_TARGET_DIR:target,CARGO_INCREMENTAL:'0',RUNE_FILES_TEST_MANIFEST:manifest,RUNE_FILES_TEST_PASSWORD:password,
    CARGO_HOME:process.env.CARGO_HOME??path.join(os.homedir(),'.cargo'),RUSTUP_HOME:process.env.RUSTUP_HOME??path.join(os.homedir(),'.rustup')}
  cargo=spawn('cargo',args,{cwd:repository,env:cargoEnv,windowsHide:true,stdio:['ignore','pipe','pipe']})
  let cargoError
  cargoStopped=new Promise(resolve=>{cargo.once('close',resolve);cargo.once('error',error=>{cargoError=error;resolve()})})
  for(const pipe of [cargo.stdout,cargo.stderr])pipe.on('data',bytes=>clientLog=(clientLog+bytes).slice(-1048576))
  let timer
  try{await Promise.race([cargoStopped,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Files client test exceeded 180s')),180000)})])}
  finally{clearTimeout(timer)}
  if(cargoError)throw cargoError
  assert.equal(cargo.exitCode,0,'Ignored real Rust Files test failed; inspect client.log')
  const receipts=clientLog.split(/\r?\n/).flatMap(line=>{try{return [JSON.parse(line.slice(line.indexOf('{'),line.lastIndexOf('}')+1))]}catch{return []}}).filter(row=>row.type==='files-native-proof')
  assert.equal(receipts.length,1);assert.equal(receipts[0].result,'ok');proof.client=receipts[0]
  assert(!proof.requests.some(row=>row.blocked),'Typed client stays inside the explicit fixture request policy')
  assert(!proof.nativeRequests.some(row=>row.method!=='GET'||row.path.includes('/session')||row.path.endsWith('/prompt')),'No native session or prompt mutations')
  if(reader)assert.equal(await readFile(path.join(directory,'été 日本語.txt'),'utf8'),'été\n日本語🦀\r\n','Reader preserves fixture bytes')
  if(write){
    const versions=proof.client.versions,contents=proof.client.contents
    assert.equal(versions.length,4);assert.equal(new Set(versions).size,4)
    assert.deepEqual(versions,contents.map(text=>`"${createHash('sha256').update(text).digest('hex')}"`))
    const writes=proof.requests.filter(row=>row.method==='PUT');assert.equal(writes.length,6)
    assert.deepEqual(writes.slice(0,4).map(row=>row.status),[204,409,204,409])
    assert(writes.slice(4).every(row=>row.status>=400&&row.status!==409),'Refusals come from Rust ownership/path admission')
    await assert.rejects(stat(path.join(directory,'été 日本語.txt')),error=>error.code==='ENOENT')
    assert.equal(await readFile(path.join(foreign,'foreign.txt'),'utf8'),'private sibling bytes')
    assert.equal(await readFile(path.join(directory,'.git/private.txt'),'utf8'),'protected')
  }
  if(write)proof.writeContract='Observed-version writes preserve external changes and absent files; private foreign selectors and .git targets are refused'
  else proof.linkContract='Workspace reads follow outward links; protected project .git targets and foreign directory selectors are refused'
  proof.result='ok'
}catch(error){failure=error;proof.error=error.message}
finally{
  const errors=[]
  if(cargo&&cargo.exitCode===null&&cargo.signalCode===null)try{await stopFixtureChild(cargo,cargoStopped)}catch(error){errors.push(error.message)}
  if(workspace&&server?.exitCode===null)try{const removed=await call(`/api/workspaces/${workspace}`,'DELETE');assert.equal(removed.status,204);proof.workspaceReleased=true;const remaining=await(await call('/api/workspaces')).json();assert.deepEqual(remaining,[]);proof.recordsRemaining=remaining.length}catch(error){errors.push(error.message)}
  if(server&&server.exitCode===null&&server.signalCode===null){
    server.stdin.on('error',()=>{});server.stdin.end('shutdown\n');await Promise.race([serverStopped,sleep(5000)])
    proof.shutdown={graceful:server.exitCode===0,exitCode:server.exitCode,signal:server.signalCode}
    if(!proof.shutdown.graceful){errors.push('Owned Rust server did not acknowledge shutdown');try{await stopFixtureChild(server,serverStopped)}catch(error){errors.push(error.message)}}
  }
  for(const http of [proxy,fake].filter(Boolean)){http.closeAllConnections();await new Promise(resolve=>http.close(resolve))}
  const clean=text=>[password,nativePassword].reduce((value,secret)=>value.replaceAll(secret,'<fixture password>'),text)
  await writeFile(path.join(root,'rust.log'),clean(serverLog));await writeFile(path.join(root,'client.log'),clean(clientLog))
  if(errors.length){proof.result='failed';proof.cleanupErrors=errors;failure??=Error('Owned Files fixture cleanup failed')}
  await writeFile(path.join(root,'proof.json'),clean(JSON.stringify(proof,null,2))+'\n')
}
console.log(JSON.stringify({type:'files-fixture',result:proof.result,root,proof:path.join(root,'proof.json')}))
if(failure)throw failure
