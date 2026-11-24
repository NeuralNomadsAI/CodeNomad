import assert from 'node:assert/strict'
import {setTimeout as delay} from 'node:timers/promises'
import {fixtureChildPid,spawnFixtureChild,stopFixtureChild} from '../../../scripts/native-fixture-guards.mjs'
import {redactSecrets,resolveWorktreePackage,withoutFixtureProxy} from '../../../scripts/native-fixture-http.mjs'

const {request}=await import(resolveWorktreePackage('playwright'))

const activeChildren=new Set()
const signalAborts=new Set()
const signalCleanups=new Set()
let cleaningSignals=false,signalHooked=false
function updateSignalHooks(){
  const active=activeChildren.size+signalAborts.size+signalCleanups.size>0
  if(active&&!signalHooked){signalHooked=true;process.on('SIGINT',onSignal);process.on('SIGTERM',onSignal)}
  else if(!active&&signalHooked){signalHooked=false;process.off('SIGINT',onSignal);process.off('SIGTERM',onSignal)}
}
function onSignal(signal){
  if(cleaningSignals)return
  cleaningSignals=true
  for(const abort of [...signalAborts])try{abort()}catch{}
  const teardown=(async()=>{
    while(activeChildren.size>0){
      const batch=[...activeChildren]
      for(const stop of batch)activeChildren.delete(stop)
      await Promise.allSettled(batch.map(stop=>stop()))
    }
    await Promise.allSettled([...signalCleanups].map(cleanup=>cleanup()))
  })()
  Promise.race([teardown,delay(10000,undefined,{ref:false})])
    .finally(()=>process.exit(signal==='SIGINT'?130:143))
}
export function fixtureShuttingDown(){return cleaningSignals}
export function registerFixtureChild(stop){
  if(cleaningSignals){
    void Promise.resolve().then(stop).catch(()=>{})
    throw Error('Fixture shutting down')
  }
  activeChildren.add(stop)
  updateSignalHooks()
  return ()=>{activeChildren.delete(stop);updateSignalHooks()}
}
export function onFixtureSignal(cleanup,abort){
  if(abort)signalAborts.add(abort)
  signalCleanups.add(cleanup)
  updateSignalHooks()
  return ()=>{if(abort)signalAborts.delete(abort);signalCleanups.delete(cleanup);updateSignalHooks()}
}

export async function until(check,label,ms=20000){
  const end=Date.now()+ms
  do{
    const value=await check()
    if(value)return value
    await delay(50)
  }while(Date.now()<end)
  throw Error(`Timed out: ${label}`)
}

export function launchFixture(binary,args,{cwd,env,shutdown,graceMs=3000,redact=[]}){
  assert(env,'An explicit fixture environment is required')
  assert(!cleaningSignals,'Fixture shutting down')
  const group=process.platform!=='win32'
  const child=spawnFixtureChild(binary,args,{cwd,env:withoutFixtureProxy(env),detached:group,windowsHide:true,stdio:[shutdown?'pipe':'ignore','pipe','pipe']})
  const startedBy=new Date()
  let output='',stdout='',error,stopping
  const sanitize=text=>redactSecrets(text,redact)
  const closed=new Promise(resolve=>{
    child.once('close',resolve)
    child.once('error',cause=>{error=cause;resolve(1)})
  })
  const stop=close=>{
    stopping??=(async()=>{
      if(child.pid)await stopFixtureChild(child,closed,graceMs,2000,{
        group,startedBy,close:close??(shutdown?()=>child.stdin.end(shutdown):undefined),
      })
    })()
    return stopping
  }
  const untrack=registerFixtureChild(()=>stop())
  void closed.finally(untrack)
  child.stdout.on('data',data=>{stdout=(stdout+data).slice(-1048576)})
  for(const stream of [child.stdout,child.stderr])stream.on('data',data=>{output=(output+data).slice(-1048576)})
  child.stdin?.on('error',()=>{})
  return {child,pid:()=>fixtureChildPid(child),closed,redact:sanitize,output:()=>sanitize(output),stdout:()=>sanitize(stdout),ready:(match,ms)=>until(()=>{
    if(error)throw error
    assert(child.exitCode===null&&child.signalCode===null,`Fixture child exited: ${sanitize(output.slice(-2000))}`)
    return match(stdout)
  },'owned listener',ms),async stop(close){
    try{await stop(close)}finally{untrack()}
  }}
}

export const rustOrigin=stdout=>stdout.match(/^http:\/\/127\.0\.0\.1:\d+(?=\r?$)/m)?.[0]

export async function signInFixture(origin,password){
  assert.match(origin,/^http:\/\/127\.0\.0\.1:\d+$/)
  const http=await request.newContext({baseURL:origin,timeout:15000})
  try{
    assert.equal((await http.get('/api/workspaces',{maxRedirects:0})).status(),401,'Workspace inventory requires authentication')
    assert.equal((await http.post('/api/auth/login',{data:{username:'codenomad',password},maxRedirects:0})).status(),200)
    return http
  }catch(error){await http.dispose();throw error}
}
