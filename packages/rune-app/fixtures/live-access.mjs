import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import {copyFile, mkdir, open, readFile, realpath, unlink, writeFile} from 'node:fs/promises'
import {createServer} from 'node:http'
import path from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import {stopFixtureChild} from '../../../scripts/native-fixture-guards.mjs'
import {privatePath, runDirectory} from '../../../scripts/perf/isolation.mjs'
import {privateEnvironment} from './private-profile.mjs'

export const args=process.argv.slice(2).filter((arg,i,all)=>arg!=='--opencode'&&all[i-1]!=='--opencode')
const marker='.rune-private-opencode'
const forbidden='the shared OpenCode service is forbidden'

export function requirePrivateCli(){
  const argv=process.argv.slice(2), index=argv.indexOf('--opencode'), cli=argv[index+1]
  assert(index>=0&&index===argv.lastIndexOf('--opencode')&&cli&&path.isAbsolute(cli),
    `Pass --opencode <absolute executable>; ${forbidden}`)
  return cli
}

export async function attestNative(origin,child,authorization,request=fetch){
  const endpoint=new URL(origin)
  assert(endpoint.protocol==='http:'&&endpoint.hostname==='127.0.0.1'&&endpoint.pathname==='/'&&
    !endpoint.search&&!endpoint.hash&&!endpoint.username&&!endpoint.password&&endpoint.port&&endpoint.port!=='0',
    `Expected the fixture child's loopback listener; ${forbidden}`)
  const alive=()=>assert(child.pid&&child.exitCode===null&&child.signalCode===null,'Private OpenCode has exited')
  const read=async(route,init={})=>{
    const url=new URL(route,endpoint)
    assert.equal(url.origin,endpoint.origin,`Fixture cannot address another OpenCode endpoint; ${forbidden}`)
    alive()
    const response=await request(url,{...init,headers:{...init.headers,authorization,'content-type':'application/json'},
      redirect:'error',signal:AbortSignal.timeout(30000)})
    if(!response.ok)throw Error(`Private OpenCode ${url.pathname}: HTTP ${response.status}`)
    return response.json().catch(()=>({}))
  }
  try{
    const info=await read('/api/info')
    assert.equal(info.pid,child.pid,'OpenCode PID differs from the fixture child')
    alive()
  }catch(cause){throw Error(`Could not attest the private OpenCode process; ${forbidden}: ${cause.message}`,{cause})}
  return read
}

export async function privateManifest(file){
  const actual=await realpath(path.resolve(file))
  const profile=privatePath(path.dirname(actual))
  assert(/^trial-rune-live-/.test(path.basename(profile)),'Expected a private Rune fixture profile')
  assert.equal(await readFile(path.join(profile,marker),'utf8'),'Rune private OpenCode v1\n')
  const data=JSON.parse(await readFile(actual,'utf8'))
  assert.equal(data.profile,profile)
  assert.equal(await realpath(data.project),path.join(profile,'project'),'Expected the private fixture project')
  assert(/^[A-Za-z0-9_-]{1,256}$/.test(data.sessionID),'Expected a fixture session ID')
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

export async function withNative(run,{profile,pruning=true}={}){
  const cli=requirePrivateCli()
  const fresh=!profile
  profile=privatePath(profile??path.join(runDirectory,`trial-rune-live-${randomUUID()}`))
  if(fresh){
    await mkdir(path.dirname(profile),{recursive:true});await mkdir(profile)
    await writeFile(path.join(profile,marker),'Rune private OpenCode v1\n',{flag:'wx'})
  }
  assert.equal(await readFile(path.join(profile,marker),'utf8'),'Rune private OpenCode v1\n')
  const lease=path.join(profile,'running.lock')
  const lock=await open(lease,'wx')
  let child,stopped,model,plugin,log='',password,executable
  const owned=name=>{
    const expected=path.join(profile,name)
    assert.equal(privatePath(expected),expected,'A private fixture path was redirected')
    return expected
  }
  try{
    const project=owned('project'), config=owned('native-config')
    const database=owned('opencode.db')
    for(const name of ['home','xdg','tmp','config','ProgramData','npm-cache','empty.npmrc','empty-global.npmrc',
      'home/AppData','home/AppData/Local','home/AppData/Roaming','xdg/config','xdg/data','xdg/state','xdg/cache'])owned(name)
    await mkdir(project,{recursive:true});await mkdir(config,{recursive:true})
    executable=path.join(profile,`opencode-${randomUUID()}${process.platform==='win32'?'.exe':''}`)
    await copyFile(await realpath(cli),executable)
    password=randomUUID()
    const authorization=`Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`
    model=await provider()
    const env={...await privateEnvironment(profile),OPENCODE_TEST_HOME:path.join(profile,'home'),
      OPENCODE_CONFIG_DIR:config,OPENCODE_DB:database,
      OPENCODE_CONFIG_PROJECT_DISABLE:'1',OPENCODE_DISABLE_MODELS_FETCH:'1',OPENCODE_DISABLE_FFF:'1',
      OPENCODE_DISABLE_AUTOUPDATE:'true',OPENCODE_SERVER_PASSWORD:password,
      ProgramData:path.join(profile,'ProgramData'),npm_config_userconfig:path.join(profile,'empty.npmrc'),
      npm_config_globalconfig:path.join(profile,'empty-global.npmrc'),npm_config_cache:path.join(profile,'npm-cache'),
      OPENCODE_CONFIG_CONTENT:JSON.stringify({model:'fixture/fixture',providers:{fixture:{
        package:'@opencode/ai/providers/openai-compatible',
        settings:{baseURL:`http://127.0.0.1:${model.address().port}/v1`,apiKey:'fixture-only'},
        models:{fixture:{},alternate:{variants:[{id:'low'}]}},
      }}}),
    }
    await mkdir(env.ProgramData,{recursive:true})
    if(pruning){const {preparePruning}=await import('../../../scripts/perf/pruning.mjs');plugin=await preparePruning(profile,config)}
    child=spawn(executable,['serve','--hostname','127.0.0.1','--port','0','--print-logs'],{cwd:project,env,windowsHide:true,stdio:['ignore','pipe','pipe']})
    let error,origin
    stopped=new Promise(resolve=>{child.once('close',resolve);child.once('error',e=>{error=e;resolve()})})
    for(const pipe of [child.stdout,child.stderr])pipe.on('data',data=>{log=(log+data).slice(-1048576)})
    for(const end=Date.now()+60000;!origin;await delay(50)){
      if(error)throw error
      assert(Date.now()<end&&child.exitCode===null,'Private OpenCode did not start')
      origin=log.match(/^server listening on (http:\/\/127\.0\.0\.1:\d+)\/?\r?$/m)?.[1]
    }
    const read=await attestNative(origin,child,authorization)
    await plugin?.activate({project,url:origin,authorization},()=>assert.equal(child.exitCode,null))
    return await run({profile,project,origin:`${origin}/`,password,read,env,pid:child.pid})
  } finally {
    try{try{await plugin?.close()}finally{if(child&&child.exitCode===null&&child.signalCode===null)await stopFixtureChild(child,stopped)}}finally{
      model?.closeAllConnections()
      if(model)await new Promise(resolve=>model.close(resolve))
      try{
        await writeFile(path.join(profile,'daemon.log'),password?log.replaceAll(password,'<fixture password>'):log)
        if(executable)await unlink(executable).catch(error=>{if(error.code!=='ENOENT')throw error})
      } finally {
        await lock.close()
        if(!child?.pid||child.exitCode!==null||child.signalCode!==null)await unlink(lease)
      }
    }
  }
}
