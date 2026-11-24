import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import {copyFile, lstat, mkdir, open, readdir, readFile, readlink, realpath, rm, unlink, writeFile} from 'node:fs/promises'
import {createServer} from 'node:http'
import os from 'node:os'
import path from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import {promisify} from 'node:util'
import {privatePath, runDirectory} from '../../../scripts/perf/isolation.mjs'
import {privateEnvironment} from './private-profile.mjs'
import {launchFixture,onFixtureSignal} from './fixture-host.mjs'
import {fixtureFetch,fixtureTarget,isLocalAbsolutePath,redactSecrets,resolveLocalExecutable} from '../../../scripts/native-fixture-http.mjs'
export {fixtureTarget,isLocalAbsolutePath}

export const args=process.argv.slice(2).filter((arg,i,all)=>arg!=='--opencode'&&all[i-1]!=='--opencode')
const marker='.rune-private-opencode'
const forbidden='the shared OpenCode service is forbidden'
const execFileAsync=promisify(execFile)

export function requirePrivateCli(argv=process.argv.slice(2)){
  const index=argv.indexOf('--opencode'), cli=argv[index+1]
  assert(index>=0&&index===argv.lastIndexOf('--opencode')&&isLocalAbsolutePath(cli),
    `Pass --opencode <absolute local executable>; ${forbidden}`)
  return cli
}

export async function verifyLoopbackListenerOwner(port,pid){
  assert(Number.isSafeInteger(port)&&port>0&&port<=65535,'Invalid loopback port')
  assert(Number.isSafeInteger(pid)&&pid>0,'Invalid fixture PID')
  if(process.platform==='win32'){
    const {stdout}=await execFileAsync('netstat.exe',['-ano','-p','tcp'],{timeout:10000,windowsHide:true,maxBuffer:8*1024*1024})
    const owners=new Set()
    for(const line of stdout.split(/\r?\n/)){
      const match=/^\s*TCP\s+127\.0\.0\.1:(\d+)\s+0\.0\.0\.0:0\s+\S+\s+(\d+)\s*$/i.exec(line)
      if(match&&Number(match[1])===port)owners.add(Number(match[2]))
    }
    assert(owners.size===1&&owners.has(pid),`Loopback port 127.0.0.1:${port} is not owned by fixture PID ${pid}; ${forbidden}`)
    return
  }
  if(process.platform==='linux'){
    const target=`0100007F:${port.toString(16).toUpperCase().padStart(4,'0')}`
    const table=await readFile('/proc/net/tcp','utf8')
    const inodes=new Set()
    for(const line of table.split('\n').slice(1)){
      const cols=line.trim().split(/\s+/)
      if(cols[1]===target&&cols[3]==='0A'&&cols[9])inodes.add(`socket:[${cols[9]}]`)
    }
    assert(inodes.size>0,`Loopback port 127.0.0.1:${port} is not listening; ${forbidden}`)
    const fds=await readdir(`/proc/${pid}/fd`)
    for(const fd of fds){
      try{if(inodes.has(await readlink(`/proc/${pid}/fd/${fd}`)))return}catch{}
    }
    throw Error(`Loopback port 127.0.0.1:${port} is not owned by fixture PID ${pid}; ${forbidden}`)
  }
  const {stdout}=await execFileAsync('lsof',['-nP','-a','-p',String(pid),`-iTCP:${port}`,'-sTCP:LISTEN','-Fp'],{timeout:10000})
  assert(stdout.split(/\r?\n/).includes(`p${pid}`),`Loopback port 127.0.0.1:${port} is not owned by fixture PID ${pid}; ${forbidden}`)
}

async function assertNoSystemOpenCodeConfig(){
  if(process.platform==='win32')return
  const paths=process.platform==='darwin'
    ? ['/Library/Application Support/opencode',
       path.join('/Library/Managed Preferences',os.userInfo().username,'ai.opencode.managed.plist'),
       '/Library/Managed Preferences/ai.opencode.managed.plist']
    : ['/etc/opencode']
  for(const candidate of paths){
    let stat
    try{stat=await lstat(candidate)}catch(error){if(error.code==='ENOENT')continue;throw error}
    if(stat.isDirectory()){
      const entries=await readdir(candidate)
      assert.equal(entries.length,0,`Host system OpenCode config must be empty for private fixtures: ${candidate}`)
    }else{
      throw Error(`Host system OpenCode config must be absent for private fixtures: ${candidate}`)
    }
  }
}

export async function attestNative(origin,child,authorization,request=fixtureFetch,...rest){
  const pid=rest.length?rest[0]:child.pid
  const verifyOwner=rest.length>1?rest[1]:(request===fixtureFetch?verifyLoopbackListenerOwner:async()=>{})
  const endpoint=new URL(origin)
  assert(endpoint.protocol==='http:'&&endpoint.hostname==='127.0.0.1'&&endpoint.pathname==='/'&&
    !endpoint.search&&!endpoint.hash&&!endpoint.username&&!endpoint.password&&endpoint.port&&endpoint.port!=='0',
    `Expected the fixture child's loopback listener; ${forbidden}`)
  const alive=()=>assert(child.pid&&child.exitCode===null&&child.signalCode===null,'Private OpenCode has exited')
  assert(Number.isSafeInteger(pid)&&pid>0,`Fixture child did not report its PID; ${forbidden}`)
  alive()
  const send=async(route,init={})=>{
    const url=fixtureTarget(route instanceof Request?route.url:route,endpoint)
    assert(url,`Fixture cannot address another OpenCode endpoint; ${forbidden}`)
    alive()
    const headers=new Headers(init.headers??(route instanceof Request?route.headers:undefined))
    headers.set('authorization',authorization)
    const signal=init.signal??(route instanceof Request?route.signal:null)
    const timeout=AbortSignal.timeout(30000)
    return request(route instanceof Request?route:url,{...init,headers,redirect:'error',
      signal:url.pathname==='/api/event'&&signal?signal:signal?AbortSignal.any([signal,timeout]):timeout})
  }
  const read=async(route,init={})=>{
    const headers=new Headers(init.headers)
    headers.set('content-type','application/json')
    const response=await send(route,{...init,headers})
    if(!response.ok)throw Error(`Private OpenCode ${new URL(route,endpoint).pathname}: HTTP ${response.status}`)
    return response.json().catch(()=>({}))
  }
  try{
    await verifyOwner(Number(endpoint.port),pid)
    alive()
    const info=await read('/api/info')
    assert.equal(info.pid,pid,'OpenCode PID differs from the fixture child')
    alive()
  }catch(cause){throw Error(`Could not attest the private OpenCode process; ${forbidden}: ${cause.message}`,{cause})}
  return {read,send}
}

const forbiddenProfileEntries=new Set(['.opencode','opencode.json','opencode.jsonc','.claude','.agents','programdata'])
const dangerousGitConfig=/^\s*(?:hooksPath|fsmonitor|sshCommand|templateDir|credential|filter|diff|merge|alias|pager|editor|uploadpack|receivepack)\s*=|^\s*\[(?:include|includeIf|url\b|credential\b|filter\b|alias\b)/im

export async function validatePrivateTree(profile){
  let count=0
  async function visit(file,depth){
    assert(++count<=20000&&depth<=32,'Private fixture profile exceeds its entry bound')
    const stat=await lstat(file)
    assert(!stat.isSymbolicLink()&&await realpath(file)===file,
      `Private fixture profile contains a linked path: ${path.relative(profile,file)}`)
    const rel=path.relative(profile,file)
    const base=path.basename(file).toLowerCase()
    if(!stat.isDirectory()){
      assert(stat.isFile()&&stat.nlink===1,`Private fixture profile contains a non-owned file: ${rel}`)
    }
    if(rel){
      assert(!forbiddenProfileEntries.has(base),`Private fixture profile contains unattested config entry: ${rel}`)
      const parts=rel.split(path.sep).map(part=>part.toLowerCase())
      if(parts[0]==='config'&&parts.length>1){
        throw Error(`Private fixture profile contains persisted config file: ${rel}`)
      }
      if(parts[0]==='project'&&parts[1]==='.git'&&parts[2]==='hooks'&&parts.length===4&&!base.endsWith('.sample')){
        throw Error(`Private fixture profile contains an active Git hook: ${rel}`)
      }
    }
    if(stat.isDirectory()){
      for(const name of await readdir(file))await visit(path.join(file,name),depth+1)
    }else if(rel.toLowerCase()===path.join('project','.git','config').toLowerCase()){
      const text=await readFile(file,'utf8')
      assert(!dangerousGitConfig.test(text),'Private fixture Git config contains a forbidden directive')
    }
  }
  await visit(profile,0)
}

export async function privateManifest(file){
  assert(typeof file==='string'&&file.length>0&&!/^[\\/]{2}/.test(file)&&!/^[\\/]{2}/.test(path.normalize(file)),'Expected a local private fixture manifest')
  const actual=path.resolve(file)
  const profile=path.dirname(actual)
  assert.equal(privatePath(profile),profile,'Expected an unlinked private fixture profile')
  assert(/^trial-rune-live-/.test(path.basename(profile)),'Expected a private Rune fixture profile')
  await validatePrivateTree(profile)
  assert.equal(await readFile(path.join(profile,marker),'utf8'),'Rune private OpenCode v1\n')
  const data=JSON.parse(await readFile(actual,'utf8'))
  assert.equal(data.profile,profile)
  const expectedProject=path.join(profile,'project')
  assert(isLocalAbsolutePath(data.project)&&path.resolve(data.project)===expectedProject,'Expected the private fixture project')
  assert.equal(await realpath(data.project),expectedProject,'Expected the private fixture project')
  assert(typeof data.sessionID==='string'&&/^[A-Za-z0-9_-]{1,256}$/.test(data.sessionID),'Expected a fixture session ID')
  return data
}

async function provider(){
  const server=createServer(async(req,res)=>{
    try{
      assert.equal(req.method,'POST')
      assert.equal(req.url,'/v1/chat/completions')
      let raw=''
      for await(const chunk of req){raw+=chunk;assert(raw.length<4*1024*1024)}
      const {model,messages,stream}=JSON.parse(raw)
      const contains=marker=>messages.some(m=>m.role==='user'&&JSON.stringify(m.content)?.includes(marker))
      const held=contains('1500 lignes')
      const text=contains('RUNE-REAL-REPRISE')?`\`\`\`rust\nfn main() {\n${Array.from({length:60},(_,i)=>`    let value_${String(i+1).padStart(2,'0')} = ${i+1};`).join('\n')}\n    println!("RUNE-REAL-REPRISE");\n}\n\`\`\``:'Rune synthetic fixture response. No external provider or tools.'
      if(!stream){
        res.setHeader('content-type','application/json')
        res.end(JSON.stringify({id:'fixture',model,choices:[{message:{role:'assistant',content:text},finish_reason:'stop'}]}))
        return
      }
      res.writeHead(200,{'content-type':'text/event-stream'})
      const send=(delta,finish_reason=null)=>res.write(`data: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',model,choices:[{index:0,delta,finish_reason}],
        usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}})}\n\n`)
      send({role:'assistant'})
      if(held){
        for(let line=1;line<=1500&&!res.destroyed;line++){send({content:`${line}. Rune\n`});await delay(30)}
      }else{
        for(const part of text.match(/.{1,16}|\n/gu)){if(res.destroyed)return;send({content:part});await delay(20)}
      }
      if(!res.destroyed){send({},'stop');res.end('data: [DONE]\n\n')}
    }catch{res.destroy()}
  })
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)})
  return server
}

async function removeExecutable(file){
  const deadline=Date.now()+3000
  for(;;){
    try{await unlink(file);return}
    catch(error){
      if(error.code==='ENOENT')return
      // Closing a Windows job starts termination before all image mappings are released.
      if(process.platform!=='win32'||!['EPERM','EBUSY'].includes(error.code)||Date.now()>=deadline)throw error
      await delay(50)
    }
  }
}

export async function withNative(run,{profile,pruning=true,denyAllTools=false}={}){
  const cli=resolveLocalExecutable(requirePrivateCli(),'OpenCode binary')
  await assertNoSystemOpenCodeConfig()
  const fresh=!profile
  const supplied=profile
  profile=privatePath(profile??path.join(runDirectory,`trial-rune-live-${randomUUID()}`))
  if(supplied)assert.equal(profile,supplied,'Expected an unlinked private fixture profile')
  if(fresh){
    await mkdir(path.dirname(profile),{recursive:true});await mkdir(profile)
    await writeFile(path.join(profile,marker),'Rune private OpenCode v1\n',{flag:'wx'})
  }
  if(!fresh)await validatePrivateTree(profile)
  assert.equal(await readFile(path.join(profile,marker),'utf8'),'Rune private OpenCode v1\n')
  const lease=path.join(profile,'running.lock')
  const lock=await open(lease,'wx')
  let daemon,model,plugin,password,executable,config,runtime,aborted=false
  const checkActive=()=>{if(aborted)throw Error('Private fixture interrupted during startup')}
  const owned=name=>{
    const expected=path.join(profile,name)
    assert.equal(privatePath(expected),expected,'A private fixture path was redirected')
    return expected
  }
  const cleanup=async()=>{
    try{try{await plugin?.close()}finally{await daemon?.stop()}}finally{
      model?.closeAllConnections()
      if(model)await new Promise(resolve=>model.close(resolve))
      try{
        const log=daemon?.output()??''
        try{await writeFile(path.join(profile,'daemon.log'),redactSecrets(log,[password]))}
        finally{
          try{if(executable)await removeExecutable(executable)}
          finally{
            try{if(config)await rm(config,{recursive:true,force:true})}
            finally{if(runtime)await rm(runtime,{recursive:true,force:true})}
          }
        }
      } finally {
        await lock.close()
        if(!daemon?.child.pid||daemon.child.exitCode!==null||daemon.child.signalCode!==null)await unlink(lease)
      }
    }
  }
  const execution=(async()=>{
    try{
      checkActive()
      const project=owned('project')
      config=owned(`native-config-${randomUUID()}`)
      runtime=owned(`native-runtime-${randomUUID()}`)
      const database=owned('opencode.db')
      await mkdir(project,{recursive:true});await mkdir(config);await mkdir(runtime)
      checkActive()
      executable=path.join(profile,`opencode-${randomUUID()}${process.platform==='win32'?'.exe':''}`)
      await copyFile(cli,executable)
      checkActive()
      password=randomUUID()
      const authorization=`Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`
      model=await provider()
      checkActive()
      const configContent={model:'fixture/fixture',providers:{fixture:{
        package:'@opencode/ai/providers/openai-compatible',
        settings:{baseURL:`http://127.0.0.1:${model.address().port}/v1`,apiKey:'fixture-only'},
        models:{fixture:{},alternate:{variants:[{id:'low'}]}},
      }}}
      if(denyAllTools)configContent.permissions=[{action:'*',resource:'*',effect:'deny'}]
      const programData=path.join(runtime,'ProgramData')
      const runtimeEnv=await privateEnvironment(runtime)
      const env={...runtimeEnv,OPENCODE_TEST_HOME:path.join(runtime,'home'),
        OPENCODE_CONFIG_DIR:config,OPENCODE_DB:database,
        OPENCODE_CONFIG_PROJECT_DISABLE:'1',OPENCODE_DISABLE_MODELS_FETCH:'1',OPENCODE_DISABLE_FFF:'1',
        OPENCODE_DISABLE_AUTOUPDATE:'true',OPENCODE_SERVER_PASSWORD:password,
        ProgramData:programData,npm_config_userconfig:path.join(runtime,'empty.npmrc'),
        npm_config_globalconfig:path.join(runtime,'empty-global.npmrc'),npm_config_cache:path.join(runtime,'npm-cache'),
        OPENCODE_CONFIG_CONTENT:JSON.stringify(configContent),
      }
      await mkdir(programData,{recursive:true})
      checkActive()
      if(pruning){const {preparePruning}=await import('../../../scripts/perf/pruning.mjs');plugin=await preparePruning(profile,config)}
      checkActive()
      daemon=launchFixture(executable,['serve','--hostname','127.0.0.1','--port','0','--print-logs'],{cwd:project,env,redact:[password]})
      const origin=await daemon.ready(stdout=>stdout.match(/^server listening on (http:\/\/127\.0\.0\.1:\d+)\/?\r?$/m)?.[1])
      checkActive()
      const pid=await daemon.pid()
      const {read,send}=await attestNative(origin,daemon.child,authorization,fixtureFetch,pid)
      checkActive()
      await plugin?.activate({project,url:origin,authorization,send},()=>assert.equal(daemon.child.exitCode,null))
      checkActive()
      return await run({profile,project,origin:`${origin}/`,password,read,send,env,runtimeEnv,pid})
    } finally {
      await cleanup()
    }
  })()
  const untrackSignal=onFixtureSignal(()=>{aborted=true;return execution.catch(()=>{})})
  try{return await execution}finally{untrackSignal()}
}
