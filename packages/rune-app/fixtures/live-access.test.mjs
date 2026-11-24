import assert from 'node:assert/strict'
import {link,mkdtemp,mkdir,readFile,realpath,rm,symlink,writeFile} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {test} from 'node:test'
import {attestNative,fixtureTarget,isLocalAbsolutePath,privateManifest,requirePrivateCli,validatePrivateTree} from './live-access.mjs'
import {seedRealHistory} from './real-history-seed.mjs'
import {runDirectory} from '../../../scripts/perf/isolation.mjs'

const origin='http://127.0.0.1:42395'
const auth='fixture-credential'
const fixture=()=>({pid:127,exitCode:null,signalCode:null})

test('live fixtures fail closed before work when the listener cannot prove its PID',async()=>{
  const child=fixture()
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
  }finally{await rm(profile,{recursive:true,force:true})}
})
