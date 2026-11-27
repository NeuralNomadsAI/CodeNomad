import assert from 'node:assert/strict'
import {existsSync} from 'node:fs'
import {link,mkdtemp,mkdir,readFile,realpath,rm,rmdir,symlink,writeFile} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {test} from 'node:test'
import {acquireProfileLock,attestNative,fixtureTarget,isLocalAbsolutePath,privateManifest,requirePrivateCli,validatePrivateTree} from './live-access.mjs'
import {launchFixture,onFixtureSignal} from './fixture-host.mjs'
import {seedRealHistory} from './real-history-seed.mjs'
import {redactSecrets,resolveWorktreePackage} from '../../../scripts/native-fixture-http.mjs'
import {runDirectory} from '../../../scripts/perf/isolation.mjs'

const origin='http://127.0.0.1:42395'
const auth='fixture-credential'
const fixture=()=>({pid:127,exitCode:null,signalCode:null})

test('live fixtures fail closed before work when the listener cannot prove its PID',{timeout:15000},async()=>{
  const child=fixture()
  const ownerDenied=[]
  await assert.rejects(attestNative(origin,child,auth,async url=>{ownerDenied.push(url.href);return Response.json({pid:127})},127,
    async()=>{throw Error('Loopback port is not owned by fixture PID')}),/the shared OpenCode service is forbidden/)
  assert.deepEqual(ownerDenied,[],'No HTTP request or Authorization header may be sent before socket ownership passes')
  for(const response of [Response.json({pid:381}),Response.json({}, {status:401}),Response.json({})]){
    const requests=[]
    await assert.rejects(attestNative(origin,child,auth,async(url,init)=>{
      requests.push({path:url.pathname,method:init.method??'GET',auth:init.headers.get('authorization'),redirect:init.redirect})
      return response
    }),/the shared OpenCode service is forbidden/)
    assert.deepEqual(requests,[{path:'/api/info',method:'GET',auth,redirect:'error'}])
  }
  const missingPid=[]
  await assert.rejects(attestNative(origin,child,auth,async url=>{missingPid.push(url.href);return Response.json({pid:127})},undefined),/did not report its PID/)
  assert.deepEqual(missingPid,[])
})

test('live fixtures reject UNC executables before touching the filesystem',()=>{
  for(const bad of ['\\\\server\\share\\opencode.exe','//server/share/opencode','/\\server\\share\\opencode.exe','\\/server/share/opencode.exe']){
    assert.equal(isLocalAbsolutePath(bad),false)
    assert.throws(()=>requirePrivateCli(['--opencode',bad]),/absolute local executable/)
  }
})

test('a fixture refuses a redirected target and an exited child before sending',async()=>{
  const child=fixture(),requests=[]
  const request=async url=>{
    requests.push(url.href)
    return Response.json({pid:child.pid})
  }
  for(const url of ['http://localhost:42395','http://127.0.0.1:0','https://127.0.0.1:42395','http://127.0.0.1:42395/api/info']){
    await assert.rejects(attestNative(url,child,auth,request),/the shared OpenCode service is forbidden/)
  }
  assert.deepEqual(requests,[])
  const {read}=await attestNative(origin,child,auth,request)
  await assert.rejects(read('http://127.0.0.1:42396/api/session',{method:'POST'}),/the shared OpenCode service is forbidden/)
  await read('/api/session')
  child.signalCode='SIGTERM'
  await assert.rejects(read('/api/session',{method:'DELETE'}),/Private OpenCode has exited/)
  assert.deepEqual(requests,[`${origin}/api/info`,`${origin}/api/session`])
})

test('fixture relays only resolve to their assigned listener',()=>{
  assert.equal(fixtureTarget('/api/events?clientId=fixture',origin)?.href,`${origin}/api/events?clientId=fixture`)
  for(const url of ['http://foreign.invalid/api/events','http://127.0.0.1:42396/api/events','//foreign.invalid/api/events','http://user@127.0.0.1:42395/api/events',`blob:${origin}/same-origin`]){
    assert.equal(fixtureTarget(url,origin),null)
  }
})

test('resumed profiles must own every file, including a config nested below CLI_CONFIG',async()=>{
  const temp=await mkdtemp(path.join(os.tmpdir(),'rune-live-links-'))
  try{
    const root=await realpath(temp),profile=path.join(root,'profile'),config=path.join(profile,'config')
    await mkdir(config,{recursive:true})
    const outside=path.join(root,'outside'),foreign=path.join(outside,'config.yaml'),local=path.join(config,'config.yaml')
    await mkdir(outside)
    await writeFile(foreign,'fixture only')
    await validatePrivateTree(profile)
    await link(foreign,local)
    await assert.rejects(validatePrivateTree(profile),/non-owned file: .*config.yaml/)
    await rm(local)
    const junction=path.join(config,'linked')
    await symlink(outside,junction,process.platform==='win32'?'junction':'dir')
    await assert.rejects(validatePrivateTree(profile),/linked path: .*linked/)
  }finally{await rm(temp,{recursive:true,force:true})}
})

test('privateManifest rejects missing sessionID and seedRealHistory omits runtime secrets',async()=>{
  const hadRunDir=existsSync(runDirectory)
  await mkdir(runDirectory,{recursive:true})
  const profile=await mkdtemp(path.join(runDirectory,'trial-rune-live-unit-'))
  try{
    const project=path.join(profile,'project')
    await mkdir(project)
    await writeFile(path.join(profile,'.rune-private-opencode'),'Rune private OpenCode v1\n')
    const missing=path.join(profile,'session.json')
    await writeFile(missing,JSON.stringify({profile,project}))
    await assert.rejects(privateManifest(missing),/fixture session ID/)
    let importedMessages=[]
    const native={
      profile,project,password:'secret-fixture-password',env:{OPENCODE_SERVER_PASSWORD:'secret-fixture-password'},
      async read(route,init){
        if(route.endsWith('/export'))return {data:{info:{id:'ses_orig',time:{created:1}},messages:[]}}
        if(route==='/api/experimental/session/import'){
          const body=JSON.parse(init.body)
          importedMessages=body.messages
          return {data:body.info}
        }
        if(route.startsWith('/api/rpc/codenomad.session-pruning/window'))return {output:{status:'window',messages:importedMessages.slice(400)}}
        throw Error(`Unexpected route: ${route}`)
      },
    }
    await seedRealHistory(native,{...native,profile,project,sessionID:'ses_orig',pluginActive:true})
    const persisted=JSON.parse(await readFile(path.join(profile,'seeded.json'),'utf8'))
    assert.equal('password' in persisted,false)
    assert.equal('env' in persisted,false)
    assert.equal(persisted.seedCount,600)
    assert.equal(persisted.pluginActive,true)
    const validated=await privateManifest(path.join(profile,'seeded.json'))
    assert.equal(validated.sessionID,persisted.sessionID)
  }finally{
    await rm(profile,{recursive:true,force:true})
    if(!hadRunDir)await rmdir(runDirectory).catch(()=>{})
  }
})

test('resumed profiles reject unattested config files, Git hooks and parent package resolution',{timeout:15000},async()=>{
  const temp=await mkdtemp(path.join(os.tmpdir(),'rune-live-content-'))
  try{
    const root=await realpath(temp),profile=path.join(root,'profile')
    await mkdir(path.join(profile,'project','.git','hooks'),{recursive:true})
    await validatePrivateTree(profile)
    const hook=path.join(profile,'project','.git','hooks','pre-commit')
    await writeFile(hook,'#!/bin/sh\necho bad\n')
    await assert.rejects(validatePrivateTree(profile),/active Git hook/)
    await rm(hook)
    const gitConfig=path.join(profile,'project','.git','config')
    await writeFile(gitConfig,'[core]\n\thooksPath = /tmp/evil\n')
    await assert.rejects(validatePrivateTree(profile),/forbidden (?:key|section|directive)/)
    await rm(gitConfig)
    const sneaky=path.join(profile,'opencode.json')
    await writeFile(sneaky,'{}')
    await assert.rejects(validatePrivateTree(profile),/unattested config entry/)
    await rm(sneaky)
    const agentsMd=path.join(profile,'project','AGENTS.md')
    await writeFile(agentsMd,'# injected\n')
    await assert.rejects(validatePrivateTree(profile),/unattested config entry/)
    await rm(agentsMd)
    const claudeMd=path.join(profile,'project','CLAUDE.md')
    await writeFile(claudeMd,'# injected\n')
    await assert.rejects(validatePrivateTree(profile),/unattested config entry/)
    await rm(claudeMd)
    await mkdir(path.join(profile,'config'),{recursive:true})
    const persistedConfig=path.join(profile,'config','config.yaml')
    await writeFile(persistedConfig,'server: {}')
    await assert.rejects(validatePrivateTree(profile),/persisted config file/)
    await rm(persistedConfig)
    const commondir=path.join(profile,'project','.git','commondir')
    await writeFile(commondir,'../../outside')
    await assert.rejects(validatePrivateTree(profile),/forbidden Git redirection/)
    await rm(commondir)
    const worktreeCfg=path.join(profile,'project','.git','config.worktree')
    await writeFile(worktreeCfg,'[core]\n\tworktree = /tmp/outside\n')
    await assert.rejects(validatePrivateTree(profile),/forbidden Git redirection/)
    await rm(worktreeCfg)
    const alternatesDir=path.join(profile,'project','.git','objects','info')
    await mkdir(alternatesDir,{recursive:true})
    const alternates=path.join(alternatesDir,'alternates')
    await writeFile(alternates,'/tmp/outside-objects\n')
    await assert.rejects(validatePrivateTree(profile),/forbidden Git redirection/)
    await rm(alternates)
    await writeFile(gitConfig,'[core] hooksPath = /tmp/hooks\n')
    await assert.rejects(validatePrivateTree(profile),/inline directive|forbidden/)
    await writeFile(gitConfig,'[core]\n\trepositoryformatversion = 0\n\tbare = false\n')
    await validatePrivateTree(profile)
    await rm(gitConfig)
    const dotGitFile=path.join(profile,'project','sub')
    await mkdir(dotGitFile)
    await writeFile(path.join(dotGitFile,'.git'),'gitdir: /tmp/outside\n')
    await assert.rejects(validatePrivateTree(profile),/forbidden Git pointer/)
    await rm(dotGitFile,{recursive:true})
    assert(resolveWorktreePackage('@opencode/client').startsWith('file://'))
    const emptyModules=path.join(root,'empty-node_modules')
    await mkdir(emptyModules)
    assert.throws(()=>resolveWorktreePackage('undici',emptyModules),/outside repository boundary/)
    assert.throws(()=>resolveWorktreePackage('__missing_fixture_pkg__'),/missing __missing_fixture_pkg__/)
    const secret='super-secret-value'
    const basic=Buffer.from(`opencode:${secret}`).toString('base64')
    const redacted=redactSecrets(`pw=${secret} header=Basic ${basic}`,[secret])
    assert.equal(redacted.includes(secret),false)
    assert.equal(redacted.includes(basic),false)
  }finally{await rm(temp,{recursive:true,force:true})}
})

test('signal teardown closes admission, stops owned children and removes running.lock',{timeout:20000},async()=>{
  const temp=await mkdtemp(path.join(os.tmpdir(),'rune-live-signal-'))
  try{
    const root=await realpath(temp),lock=path.join(root,'running.lock')
    const hostUrl=new URL('./fixture-host.mjs',import.meta.url).href
    const script=`
      import {open,unlink} from 'node:fs/promises'
      import {launchFixture,onFixtureSignal} from ${JSON.stringify(hostUrl)}
      const lockPath=process.argv[1]
      const fh=await open(lockPath,'wx')
      const child=launchFixture(process.execPath,['-e','console.log("child-ready:"+process.pid);setInterval(()=>{},1000)'],{
        cwd:process.cwd(),env:{PATH:process.env.PATH},redact:['secret-token']
      })
      const line=await child.ready(out=>out.match(/^child-ready:(\\d+)/m)?.[1])
      onFixtureSignal(async()=>{await fh.close();await unlink(lockPath)})
      console.log('RUNNER_READY:'+line)
      if(process.platform==='win32'){setTimeout(()=>process.emit('SIGTERM','SIGTERM'),50)}
      else{setInterval(()=>{},1000)}
    `
    const runnerEnv={PATH:process.env.PATH}
    if(process.env.CARGO_TARGET_DIR)runnerEnv.CARGO_TARGET_DIR=process.env.CARGO_TARGET_DIR
    if(process.env.CODENOMAD_FIXTURE_JOB_EXE)runnerEnv.CODENOMAD_FIXTURE_JOB_EXE=process.env.CODENOMAD_FIXTURE_JOB_EXE
    const runner=launchFixture(process.execPath,['--input-type=module','-e',script,lock],{
      cwd:process.cwd(),env:runnerEnv,
    })
    try{
      const childPid=Number(await runner.ready(out=>out.match(/^RUNNER_READY:(\d+)/m)?.[1]))
      const runnerPid=await runner.pid()
      assert(Number.isSafeInteger(runnerPid)&&runnerPid>0,'Runner PID must be reported by fixture supervisor')
      if(process.platform!=='win32')process.kill(runnerPid,'SIGTERM')
      const code=await runner.closed
      assert.equal(code,143)
      let lockExists=true
      try{await readFile(lock)}catch(e){if(e.code==='ENOENT')lockExists=false}
      assert.equal(lockExists,false,'running.lock must be removed by signal cleanup')
      assert.throws(()=>process.kill(childPid,0),'Owned child must be stopped by signal teardown')
    }finally{await runner.stop()}
  }finally{await rm(temp,{recursive:true,force:true})}
})

test('acquireProfileLock rejects live owners and atomically recovers stale crash locks',{timeout:15000},async()=>{
  const temp=await mkdtemp(path.join(os.tmpdir(),'rune-live-lock-'))
  try{
    const lock=path.join(temp,'running.lock')
    const live=await acquireProfileLock(lock)
    try{
      await assert.rejects(acquireProfileLock(lock),{code:'EEXIST'})
    }finally{await live.close()}
    // Spawn and wait for a short-lived process to obtain a guaranteed dead PID.
    const short=launchFixture(process.execPath,['-e','process.exit(0)'],{cwd:process.cwd(),env:{PATH:process.env.PATH}})
    const deadPid=await short.pid()
    await short.closed
    await short.stop()
    await writeFile(lock,JSON.stringify({pid:deadPid})+'\n')
    // Concurrent stale-lock reclaimers: exactly one wins; the loser never unlinks the winner's fresh lock.
    const results=await Promise.allSettled([acquireProfileLock(lock),acquireProfileLock(lock)])
    const won=results.filter(r=>r.status==='fulfilled')
    const lost=results.filter(r=>r.status==='rejected')
    assert.equal(won.length,1,'Exactly one concurrent reclaimer must acquire the stale lock')
    assert.equal(lost.length,1,'The concurrent loser must fail without deleting the winner lock')
    try{
      assert.equal(JSON.parse(await readFile(lock,'utf8')).pid,process.pid)
    }finally{await won[0].value.close()}
  }finally{await rm(temp,{recursive:true,force:true})}
})

test('launchFixture redacts output and stops owned children cleanly',{timeout:15000},async()=>{
  const secret='fixture-secret-token'
  const basic=Buffer.from(`opencode:${secret}`).toString('base64')
  let signalHookRegistered=false
  const untrack=onFixtureSignal(()=>{signalHookRegistered=true})
  const proc=launchFixture(process.execPath,['-e',`console.log("ready ${secret} ${basic}"); setInterval(()=>{},1000)`],{
    cwd:process.cwd(),env:{PATH:process.env.PATH},redact:[secret],
  })
  try{
    await proc.ready(out=>out.includes('ready'))
    assert.equal(proc.output().includes(secret),false)
    assert.equal(proc.output().includes(basic),false)
    await proc.stop()
    assert.notEqual(proc.child.exitCode===null&&proc.child.signalCode===null,true)
    assert.equal(signalHookRegistered,false)
  }finally{
    untrack()
    await proc.stop()
  }
})
