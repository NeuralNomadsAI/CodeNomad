import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import {mkdir, mkdtemp, realpath, rm, writeFile} from 'node:fs/promises'
import {createServer} from 'node:http'
import path from 'node:path'
import {privatePath, runDirectory} from '../../../scripts/perf/isolation.mjs'
import {privateEnvironment} from './private-profile.mjs'
import {launchFixture,rustOrigin} from './fixture-host.mjs'

export const title = 'Rune private journey'
export const filename = 'journey.txt'
export const prompt = 'RUNE-JOURNEY: update journey.txt'
export const initial = 'Journey before\n'
export const edited = 'Journey after permission\n'
export const reply = 'Journey complete.'
export const commit = 'Rune journey commit'

async function modelServer(project, marker) {
  let calls=0, failure
  const model=createServer(async(req,res)=>{
    try {
      assert.equal(req.method,'POST')
      assert.equal(req.url,'/v1/chat/completions')
      assert.equal(req.headers.authorization,`Bearer ${marker}`)
      let raw=''
      for await(const chunk of req){raw+=chunk;assert(raw.length<4*1024*1024)}
      const {stream,model,messages,tools}=JSON.parse(raw)
      assert.equal(model,'journey')
      assert(stream && ++calls<=2)
      assert(messages.some(row=>row.role==='user'&&JSON.stringify(row.content).includes(prompt)))
      if(calls===2) assert(messages.some(row=>row.role==='tool'),'Second model request needs the real tool result')
      res.writeHead(200,{'content-type':'text/event-stream'})
      const send=(delta,finish_reason=null)=>res.write(`data: ${JSON.stringify({
        id:`journey-${calls}`,object:'chat.completion.chunk',model,choices:[{index:0,delta,finish_reason}],
        usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15},
      })}\n\n`)
      send({role:'assistant'})
      if(calls===1){
        const write=tools.find(tool=>tool.function.name==='write').function
        assert(write.parameters.properties.path && write.parameters.properties.content)
        send({tool_calls:[{index:0,id:'call_journey_write',type:'function',function:{
          name:write.name,arguments:JSON.stringify({path:path.join(project,filename),content:edited}),
        }}]})
      } else send({content:reply})
      send({},calls===1?'tool_calls':'stop')
      res.end('data: [DONE]\n\n')
    } catch(error){failure=error;res.destroy()}
  })
  await new Promise((resolve,reject)=>{model.once('error',reject);model.listen(0,'127.0.0.1',resolve)})
  return {port:model.address().port, prove(){if(failure)throw failure;assert.equal(calls,2,'Model must receive exactly one tool turn and its continuation')},
    async close(){model.closeAllConnections();await new Promise(resolve=>model.close(resolve))}}
}

export async function withJourneyHost({cli,rust,web,mode},report,run){
  await mkdir(runDirectory,{recursive:true})
  const profile=await mkdtemp(privatePath(path.join(runDirectory,'trial-rune-journey-')))
  const project=path.join(profile,'project')
  const privatePassword=randomUUID(), password=randomUUID(), marker=randomUUID()
  let native, server, pruning, model
  try{
    await mkdir(project)
    const env=await privateEnvironment(profile)
    env.GIT_CONFIG_NOSYSTEM='1'
    env.GIT_CONFIG_GLOBAL=path.join(profile,'empty.gitconfig')
    assertPrivateChild(env)
    const git=(...args)=>execFileSync('git',args,{cwd:project,env,windowsHide:true,timeout:10000,encoding:'utf8'}).trim()
    git('init','-q')
    git('config','user.name','Rune Fixture')
    git('config','user.email','rune@invalid')
    await writeFile(path.join(project,filename),initial)
    git('add',filename)
    git('commit','-qm','Journey start')
    const before=git('rev-parse','HEAD')
    model=await modelServer(project,marker)
    const config=path.join(profile,'native-config')
    const programData=path.join(profile,'ProgramData')
    await Promise.all([mkdir(config),mkdir(programData)])
    const {preparePruning}=await import('../../../scripts/perf/pruning.mjs')
    pruning=await preparePruning(profile,config)
    const ownedNative={
      OPENCODE_TEST_HOME:env.HOME,OPENCODE_CONFIG_DIR:config,
      OPENCODE_DB:path.join(profile,'opencode.db'),OPENCODE_CONFIG_PROJECT_DISABLE:'1',
      OPENCODE_DISABLE_MODELS_FETCH:'1',OPENCODE_DISABLE_FFF:'1',OPENCODE_DISABLE_AUTOUPDATE:'true',
      OPENCODE_SERVER_PASSWORD:privatePassword,
      OPENCODE_CONFIG_CONTENT:JSON.stringify({
        model:'fixture/journey',formatter:false,snapshots:false,
        permissions:[{action:'*',resource:'*',effect:'deny'},{action:'edit',resource:'*',effect:'ask'}],
        providers:{fixture:{package:'@opencode/ai/providers/openai-compatible',
          settings:{baseURL:`http://127.0.0.1:${model.port}/v1`,apiKey:marker},models:{journey:{}}}},
      }),
    }
    native=launchFixture(await realpath(cli),['serve','--hostname','127.0.0.1','--port','0','--print-logs'],{cwd:project,env:assertPrivateChild({
      ...env,ProgramData:programData,
      npm_config_userconfig:path.join(profile,'empty.npmrc'),npm_config_globalconfig:path.join(profile,'empty-global.npmrc'),
      npm_config_cache:path.join(profile,'npm-cache'),
      ...ownedNative,
    },ownedNative)})
    const daemon=await native.ready(stdout=>stdout.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0])
    assert.notEqual(new URL(daemon).port,'4096','Default OpenCode port is forbidden')
    const authorization=`Basic ${Buffer.from(`opencode:${privatePassword}`).toString('base64')}`
    async function read(route) {
      const url=new URL(route,daemon)
      assert.equal(url.origin,daemon)
      assert.equal(native.child.exitCode,null,'The private OpenCode child exited')
      const res=await fetch(url,{headers:{authorization},redirect:'error',signal:AbortSignal.timeout(10000)})
      assert(res.ok,`Private OpenCode ${url.pathname}: HTTP ${res.status}`)
      return res.json()
    }
    assert.equal((await read('/api/info')).pid,native.child.pid,'Refusing an OpenCode endpoint that is not the owned child')
    report.openCodePID=native.child.pid
    await pruning.activate({project,url:daemon,authorization},()=>assert.equal(native.child.exitCode,null))
    const ownedRust={CNRS_FIXTURE_PASSWORD:privatePassword,CNRS_SERVER_PASSWORD:password}
    server=launchFixture(rust,[profile,path.join(profile,'backend.json'),'0','fixture-only'],{cwd:profile,shutdown:'shutdown\n',env:assertPrivateChild({
      ...env,...ownedRust,CNRS_FIXTURE_URL:daemon,CNRS_FIXTURE_STDIN_STOP:'1',
      ...(mode==='web'?{CNRS_FIXTURE_UI_DIR:web}:{}),
    },ownedRust)})
    const origin=await server.ready(rustOrigin)
    await run({profile,project,origin,password,env})
    report.stage='verify-model-and-git'
    model.prove()
    assert.equal(git('log','-1','--format=%s'),commit)
    report.commitSHA=git('rev-parse','HEAD')
    assert.notEqual(report.commitSHA,before)
    assert.equal(git('show',`HEAD:${filename}`),edited.trimEnd())
    assert.equal(git('status','--porcelain'),'')
  }finally{
    const errors=[]
    const settle=async run=>{try{await run()}catch(error){errors.push(error)}}
    try{
      await settle(()=>server?.stop())
      await settle(()=>pruning?.close())
      await settle(()=>native?.stop())
      await settle(()=>model?.close())
      for(const [name,process] of [['rust',server],['opencode',native]]){
        if(process)await settle(()=>writeFile(path.join(report.output,`${name}.log`),
          process.output().replaceAll(privatePassword,'<private>').replaceAll(password,'<private>').replaceAll(marker,'<private>')))
      }
    }finally{
      await settle(async()=>{
        await rm(profile,{recursive:true,force:true,maxRetries:8,retryDelay:250})
        report.profileRemoved=true
      })
      if(errors.length){
        report.stage='private-host-cleanup'
        throw new AggregateError(errors,`Fixture cleanup failed: ${errors.map(error=>error.message).join('; ')}`)
      }
    }
  }
}

export function assertPrivateChild(env,owned={}){
  for(const [key,value] of Object.entries(env)){
    if(!credentialVariable(key))continue
    assert(Object.hasOwn(owned,key)&&owned[key]===value,`Unexpected credential or OpenCode environment variable: ${key}`)
  }
  return env
}

export const credentialVariable=key=>/opencode|(?:^|_)(?:key|token|secret|password|credential|credentials)(?:_|$)/i.test(key)
