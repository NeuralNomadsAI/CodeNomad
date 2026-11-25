import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import {existsSync} from 'node:fs'
import {copyFile, link, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, stat, unlink, writeFile} from 'node:fs/promises'
import {createServer} from 'node:http'
import os from 'node:os'
import path from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {setTimeout as delay} from 'node:timers/promises'
import {promisify} from 'node:util'
import {privatePath, runDirectory} from '../../../scripts/perf/isolation.mjs'
import {privateEnvironment} from './private-profile.mjs'
import {launchFixture,onFixtureSignal} from './fixture-host.mjs'
import {createAttestedFetch,createAttestedRelay,fixtureFetch,fixtureTarget,isLocalAbsolutePath,redactSecrets,RELAY_PLACEHOLDER_PASSWORD,resolveLocalExecutable,verifyLoopbackListenerOwner} from '../../../scripts/native-fixture-http.mjs'
export {fixtureTarget,isLocalAbsolutePath,verifyLoopbackListenerOwner}

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

export async function ensurePrivateGitRepo(project,profile,env){
  if(existsSync(path.join(project,'.git')))return
  await execFileAsync('git',['-c','core.hooksPath=','init','--quiet','--template=',project],{
    windowsHide:true,timeout:30000,
    env:{...env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:path.join(profile,'empty.gitconfig'),GIT_TEMPLATE_DIR:'',GIT_CEILING_DIRECTORIES:profile},
  })
}

export async function assertNoSystemOpenCodeConfig(){
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
  const liveTransport=request===fixtureFetch
  const alive=()=>{
    assert(child.pid&&child.exitCode===null&&child.signalCode===null,'Private OpenCode has exited')
    if(liveTransport){
      try{process.kill(pid,0)}catch{throw Error('Private OpenCode process is no longer alive')}
    }
  }
  assert(Number.isSafeInteger(pid)&&pid>0,`Fixture child did not report its PID; ${forbidden}`)
  alive()
  const transport=liveTransport?createAttestedFetch(endpoint.origin,Number(endpoint.port),pid,verifyOwner):request
  const send=async(route,init={})=>{
    const url=fixtureTarget(route instanceof Request?route.url:route,endpoint)
    assert(url,`Fixture cannot address another OpenCode endpoint; ${forbidden}`)
    alive()
    const headers=new Headers(init.headers??(route instanceof Request?route.headers:undefined))
    headers.set('authorization',authorization)
    const signal=init.signal??(route instanceof Request?route.signal:null)
    const timeout=AbortSignal.timeout(30000)
    return transport(route instanceof Request?route:url,{...init,headers,redirect:'error',
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
    await verifyOwner(Number(endpoint.port),pid)
    alive()
  }catch(cause){
    await transport.close?.()
    throw Error(`Could not attest the private OpenCode process; ${forbidden}: ${cause.message}`,{cause})
  }
  return {read,send,close:()=>transport.close?.()??Promise.resolve()}
}

const forbiddenProfileEntries=new Set(['.opencode','opencode.json','opencode.jsonc','.claude','.agents','programdata','agents.md','claude.md'])
const forbiddenGitEntries=new Set(['commondir','gitdir','alternates','config.worktree','worktrees'])
const allowedGitSections=new Set(['core','user','init'])
const allowedGitKeys=new Map([
  ['core',new Set(['repositoryformatversion','filemode','bare','logallrefupdates','symlinks','ignorecase','precomposeunicode','autocrlf','safecrlf','eol','quotepath'])],
  ['user',new Set(['name','email'])],
  ['init',new Set(['defaultbranch'])],
])

function assertSafeGitConfig(text){
  let section=null
  for(const rawLine of text.split(/\r?\n/)){
    const line=rawLine.trim()
    if(!line||line.startsWith('#')||line.startsWith(';'))continue
    if(line.startsWith('[')){
      const end=line.indexOf(']')
      assert(end>1,'Private fixture Git config contains a malformed section header')
      const header=line.slice(1,end).trim().toLowerCase()
      const trailing=line.slice(end+1).trim()
      assert(!trailing||trailing.startsWith('#')||trailing.startsWith(';'),
        'Private fixture Git config contains an inline directive after section header')
      assert(allowedGitSections.has(header),`Private fixture Git config contains a forbidden section: [${header}]`)
      section=header
      continue
    }
    const eq=line.indexOf('=')
    assert(section&&eq>0,'Private fixture Git config contains a forbidden directive')
    const key=line.slice(0,eq).trim().toLowerCase()
    const value=line.slice(eq+1).split(/[;#]/)[0].trim().toLowerCase()
    assert(allowedGitKeys.get(section)?.has(key),`Private fixture Git config contains a forbidden key: ${section}.${key}`)
    if(section==='core'&&key==='bare'){
      assert.equal(value,'false','Private fixture Git config cannot enable core.bare')
    }
  }
}

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
      if(base==='.git'&&!(parts.length===2&&parts[0]==='project'&&stat.isDirectory())){
        throw Error(`Private fixture profile contains a forbidden Git pointer: ${rel}`)
      }
      if(parts[0]==='project'&&parts[1]==='.git'){
        if(parts.length>=3&&parts.slice(2).some(part=>forbiddenGitEntries.has(part))){
          throw Error(`Private fixture profile contains a forbidden Git redirection: ${rel}`)
        }
        if(parts[2]==='hooks'&&parts.length===4&&!base.endsWith('.sample')){
          throw Error(`Private fixture profile contains an active Git hook: ${rel}`)
        }
      }
    }
    if(stat.isDirectory()){
      for(const name of await readdir(file))await visit(path.join(file,name),depth+1)
    }else if(rel.toLowerCase().startsWith(path.join('project','.git','config').toLowerCase())){
      const text=await readFile(file,'utf8')
      assertSafeGitConfig(text)
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

const heldLeases=new Set()

function pidAlive(pid){
  if(!Number.isSafeInteger(pid)||pid<=0)return false
  try{process.kill(pid,0);return true}catch(probe){return probe.code!=='ESRCH'}
}

function leaseBusyError(lease){
  return Object.assign(Error(`EEXIST: profile lease already held: ${lease}`),{code:'EEXIST'})
}

function withLeaseDb(dbPath,run,timeout=0){
  const db=new DatabaseSync(dbPath,{timeout})
  try{
    db.exec('PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE;')
    try{
      db.exec('CREATE TABLE IF NOT EXISTS lease (id INTEGER PRIMARY KEY CHECK (id = 1), pid INTEGER NOT NULL, supervisor_pid INTEGER, daemon_pid INTEGER, nonce TEXT NOT NULL, updated_at INTEGER NOT NULL);')
      try{db.exec('ALTER TABLE lease ADD COLUMN supervisor_pid INTEGER;')}catch{}
      const result=run(db)
      db.exec('COMMIT;')
      return result
    }catch(error){
      try{db.exec('ROLLBACK;')}catch{}
      throw error
    }
  }finally{db.close()}
}

async function assertSafeLeaseTarget(filePath){
  let info
  try{info=await lstat(filePath)}catch(error){if(error.code==='ENOENT')return;throw error}
  assert(!info.isSymbolicLink()&&info.isFile()&&info.nlink===1,`Unsafe fixture lease path: ${filePath}`)
}

export async function acquireProfileLock(lease){
  const key=path.resolve(lease)
  if(heldLeases.has(key))throw leaseBusyError(lease)
  heldLeases.add(key)
  const dbPath=`${lease}.sqlite`
  const nonce=randomUUID()
  const now=Date.now()
  let dbCommitted=false
  let acquired=false
  let trackedSupervisorPid=null
  let trackedDaemonPid=null
  try{
    await assertSafeLeaseTarget(lease)
    await assertSafeLeaseTarget(dbPath)
    let existingFile=null
    let existingStat=null
    try{
      existingFile=await readFile(lease,'utf8')
      existingStat=await stat(lease)
    }catch(error){if(error.code!=='ENOENT')throw error}
    withLeaseDb(dbPath,db=>{
      const row=db.prepare('SELECT pid, supervisor_pid, daemon_pid, nonce, updated_at FROM lease WHERE id = 1').get()
      if(row){
        const ownerLive=row.pid===process.pid||pidAlive(row.pid)
        const supervisorLive=row.supervisor_pid!=null&&pidAlive(row.supervisor_pid)
        const daemonLive=row.daemon_pid!=null&&pidAlive(row.daemon_pid)
        if(ownerLive||supervisorLive||daemonLive)throw leaseBusyError(lease)
      }
      if(existingFile!==null){
        if(!existingFile.trim()){
          if(!existingStat||now-existingStat.mtimeMs<2_000)throw leaseBusyError(lease)
        }else{
          try{
            const raw=JSON.parse(existingFile)
            const ownerLive=Number.isSafeInteger(raw?.pid)&&raw.pid>0&&(raw.pid===process.pid||pidAlive(raw.pid))
            const supervisorLive=Number.isSafeInteger(raw?.supervisorPid)&&raw.supervisorPid>0&&pidAlive(raw.supervisorPid)
            const daemonLive=Number.isSafeInteger(raw?.daemonPid)&&raw.daemonPid>0&&pidAlive(raw.daemonPid)
            if(ownerLive||supervisorLive||daemonLive)throw leaseBusyError(lease)
          }catch(parseError){
            if(parseError.code==='EEXIST')throw parseError
            if(!existingStat||now-existingStat.mtimeMs<2_000)throw leaseBusyError(lease)
          }
        }
      }
      db.prepare('INSERT OR REPLACE INTO lease (id, pid, supervisor_pid, daemon_pid, nonce, updated_at) VALUES (1, ?, NULL, NULL, ?, ?)').run(process.pid,nonce,now)
    },0)
    dbCommitted=true
    await writeFile(lease,JSON.stringify({pid:process.pid,supervisorPid:null,daemonPid:null,nonce})+'\n')
    acquired=true
  }catch(error){
    if(dbCommitted){
      try{
        withLeaseDb(dbPath,db=>{
          db.prepare('DELETE FROM lease WHERE id = 1 AND nonce = ?').run(nonce)
        },5000)
      }catch{}
    }
    heldLeases.delete(key)
    if(/database is locked/i.test(error?.message??''))throw leaseBusyError(lease)
    throw error
  }
  let closed=false
  return {
    async setSupervisorPid(supervisorPid){
      if(closed||!acquired)return
      trackedSupervisorPid=supervisorPid
      withLeaseDb(dbPath,db=>{
        const info=db.prepare('UPDATE lease SET supervisor_pid = ?, updated_at = ? WHERE id = 1 AND nonce = ?').run(supervisorPid,Date.now(),nonce)
        assert.equal(info.changes,1,'Profile lease lost before recording supervisor PID')
      },5000)
      await writeFile(lease,JSON.stringify({pid:process.pid,supervisorPid:trackedSupervisorPid,daemonPid:trackedDaemonPid,nonce})+'\n').catch(()=>{})
    },
    async setDaemonPid(daemonPid){
      if(closed||!acquired)return
      trackedDaemonPid=daemonPid
      withLeaseDb(dbPath,db=>{
        const info=db.prepare('UPDATE lease SET daemon_pid = ?, updated_at = ? WHERE id = 1 AND nonce = ?').run(daemonPid,Date.now(),nonce)
        assert.equal(info.changes,1,'Profile lease lost before recording daemon PID')
      },5000)
      await writeFile(lease,JSON.stringify({pid:process.pid,supervisorPid:trackedSupervisorPid,daemonPid:trackedDaemonPid,nonce})+'\n').catch(()=>{})
    },
    async close(){
      if(closed)return
      let removed=false
      if(acquired){
        withLeaseDb(dbPath,db=>{
          const info=db.prepare('DELETE FROM lease WHERE id = 1 AND nonce = ?').run(nonce)
          removed=info.changes===1
        },5000)
        if(removed)await unlink(lease).catch(()=>{})
      }
      closed=true
      heldLeases.delete(key)
    },
  }
}

async function purgeCrashResidues(profile){
  for(const name of await readdir(profile)){
    if(!/^(?:native-(?:runtime|config)-[0-9a-f-]+|opencode-[0-9a-f-]+(?:\.exe)?|running\.lock\.(?:stale|tmp)-[0-9a-f-]+)$/i.test(name))continue
    const target=path.join(profile,name)
    const stat=await lstat(target)
    if(stat.isSymbolicLink())continue
    await rm(target,{recursive:true,force:true,maxRetries:4,retryDelay:100})
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
  }else{
    const profileStat=await lstat(profile)
    assert(profileStat.isDirectory()&&!profileStat.isSymbolicLink(),'Resumed fixture profile must be a real directory')
    await validatePrivateTree(profile)
  }
  const lease=path.join(profile,'running.lock')
  const lock=await acquireProfileLock(lease)
  let daemon,model,plugin,password,executable,config,runtime,attested,nativeRelay,trackedSupervisorPid=null,trackedDaemonPid=null,aborted=false,executionFinished=false,pruningActive=false
  const checkActive=()=>{if(aborted)throw Error('Private fixture interrupted during startup')}
  const owned=name=>{
    const expected=path.join(profile,name)
    assert.equal(privatePath(expected),expected,'A private fixture path was redirected')
    return expected
  }
  const isDaemonStopped=()=>
    !pruningActive
    &&(!daemon?.child.pid||daemon.child.exitCode!==null||daemon.child.signalCode!==null)
    &&(trackedSupervisorPid==null||!pidAlive(trackedSupervisorPid))
    &&(trackedDaemonPid==null||!pidAlive(trackedDaemonPid))
  let cleaned,leaseRemoved=false
  const tryRemoveLease=async(force=false)=>{
    if(leaseRemoved)return
    if((executionFinished||force)&&isDaemonStopped()){
      leaseRemoved=true
      try{await unlink(lease)}catch(error){if(error.code!=='ENOENT')throw error}
    }
  }
  const cleanup=()=>{
    cleaned??=(async()=>{
      try{
        try{await nativeRelay?.close()}finally{
          try{await daemon?.stop()}finally{
            try{await attested?.close()}finally{await plugin?.close()}
          }
        }
      }finally{
        model?.closeAllConnections()
        if(model)await new Promise(resolve=>model.close(resolve))
        try{
          try{
            if(daemon){
              const daemonLogPath=owned('daemon.log')
              await assertSafeLeaseTarget(daemonLogPath)
              await writeFile(daemonLogPath,redactSecrets(daemon.output(),[password]))
            }
          }
          finally{
            try{if(executable)await removeExecutable(executable)}
            finally{
              try{if(config)await rm(config,{recursive:true,force:true})}
              finally{if(runtime)await rm(runtime,{recursive:true,force:true})}
            }
          }
        } finally {
          if(isDaemonStopped()){
            await lock.close()
            await tryRemoveLease()
          }
        }
      }
    })()
    return cleaned.finally(()=>tryRemoveLease())
  }
  const execution=(async()=>{
    try{
      if(!fresh){
        await purgeCrashResidues(profile)
        await validatePrivateTree(profile)
      }
      assert.equal(await readFile(path.join(profile,marker),'utf8'),'Rune private OpenCode v1\n')
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
      const programData=path.join(runtime,'win-program-data')
      const runtimeEnv=await privateEnvironment(runtime)
      const env={...runtimeEnv,OPENCODE_TEST_HOME:path.join(runtime,'home'),
        OPENCODE_CONFIG_DIR:config,OPENCODE_DB:database,
        OPENCODE_CONFIG_PROJECT_DISABLE:'1',OPENCODE_DISABLE_PROJECT_CONFIG:'1',
        OPENCODE_DISABLE_MODELS_FETCH:'1',OPENCODE_DISABLE_FFF:'1',
        OPENCODE_DISABLE_AUTOUPDATE:'true',OPENCODE_SERVER_PASSWORD:password,
        GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:path.join(runtime,'empty.gitconfig'),GIT_TEMPLATE_DIR:'',
        GIT_CEILING_DIRECTORIES:profile,
        ProgramData:programData,npm_config_userconfig:path.join(runtime,'empty.npmrc'),
        npm_config_globalconfig:path.join(runtime,'empty-global.npmrc'),npm_config_cache:path.join(runtime,'npm-cache'),
        OPENCODE_CONFIG_CONTENT:JSON.stringify(configContent),
      }
      await mkdir(programData,{recursive:true})
      await ensurePrivateGitRepo(project,profile,runtimeEnv)
      checkActive()
      if(pruning){
        pruningActive=true
        try{
          const {preparePruning}=await import('../../../scripts/perf/pruning.mjs')
          plugin=await preparePruning(profile,config,runtimeEnv,{
            async onBuilderSpawn({supervisorPid,childPid,closed}){
              assert(Number.isSafeInteger(supervisorPid)&&supervisorPid>0,'Builder supervisor PID unavailable')
              trackedSupervisorPid=supervisorPid
              await lock.setSupervisorPid(supervisorPid)
              void Promise.resolve(childPid).then(pid=>{
                if(pruningActive&&Number.isSafeInteger(pid)&&pid>0){trackedDaemonPid=pid;void lock.setDaemonPid(pid)}
              },()=>{})
              void closed.finally(()=>{
                if(trackedSupervisorPid===supervisorPid)trackedSupervisorPid=null
              })
            },
          })
          trackedSupervisorPid=null;trackedDaemonPid=null
          await lock.setSupervisorPid(null);await lock.setDaemonPid(null)
        }finally{pruningActive=false}
      }
      checkActive()
      daemon=launchFixture(executable,['serve','--hostname','127.0.0.1','--port','0','--print-logs'],{cwd:project,env,redact:[password],gate:true})
      try{
        assert(Number.isSafeInteger(daemon.child.pid)&&daemon.child.pid>0,'Daemon supervisor PID unavailable')
        trackedSupervisorPid=daemon.child.pid
        await lock.setSupervisorPid(daemon.child.pid)
      }catch(error){
        daemon.abortGate()
        throw error
      }
      daemon.releaseGate()
      const origin=await daemon.ready(stdout=>stdout.match(/^server listening on (http:\/\/127\.0\.0\.1:\d+)\/?\r?\n/m)?.[1])
      checkActive()
      const pid=await Promise.race([
        daemon.pid(),
        delay(10000,undefined,{ref:false}).then(()=>{throw Error('Timed out reading fixture child PID')}),
      ])
      trackedDaemonPid=pid
      await lock.setDaemonPid(pid)
      attested=await attestNative(origin,daemon.child,authorization,fixtureFetch,pid)
      nativeRelay=await createAttestedRelay(origin,pid,{requireClientAttestation:true,injectAuthorization:authorization})
      const {read,send}=attested
      checkActive()
      await plugin?.activate({project,url:origin,authorization,send},()=>assert.equal(daemon.child.exitCode,null))
      checkActive()
      return await run({profile,project,origin:`${origin}/`,relay:nativeRelay.origin,relayPassword:RELAY_PLACEHOLDER_PASSWORD,allowRelayClient:nativeRelay.allowClientPid,password,read,send,env,runtimeEnv,pid})
    } finally {
      executionFinished=true
      await cleanup()
    }
  })()
  const untrackSignal=onFixtureSignal(async()=>{
    await daemon?.stop().catch(()=>{})
    await Promise.race([execution.catch(()=>{}),delay(8000,undefined,{ref:false})])
    await cleanup()
    await tryRemoveLease(true)
  },()=>{aborted=true})
  try{return await execution}finally{untrackSignal()}
}
