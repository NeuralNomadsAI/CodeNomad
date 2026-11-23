import assert from 'node:assert/strict'
import {setTimeout as delay} from 'node:timers/promises'
import {request} from 'playwright'
import {fixtureChildPid,spawnFixtureChild,stopFixtureChild} from '../../../scripts/native-fixture-guards.mjs'
import {withoutFixtureProxy} from '../../../scripts/native-fixture-http.mjs'

export async function until(check,label,ms=20000){
  const end=Date.now()+ms
  do{
    const value=await check()
    if(value)return value
    await delay(50)
  }while(Date.now()<end)
  throw Error(`Timed out: ${label}`)
}

export function launchFixture(binary,args,{cwd,env,shutdown,graceMs=3000}){
  assert(env,'An explicit fixture environment is required')
  const group=process.platform!=='win32'
  const child=spawnFixtureChild(binary,args,{cwd,env:withoutFixtureProxy(env),detached:group,windowsHide:true,stdio:[shutdown?'pipe':'ignore','pipe','pipe']})
  const startedBy=new Date()
  let output='',stdout='',error
  const closed=new Promise(resolve=>{
    child.once('close',resolve)
    child.once('error',cause=>{error=cause;resolve(1)})
  })
  child.stdout.on('data',data=>{stdout=(stdout+data).slice(-1048576)})
  for(const stream of [child.stdout,child.stderr])stream.on('data',data=>{output=(output+data).slice(-1048576)})
  child.stdin?.on('error',()=>{})
  return {child,pid:()=>fixtureChildPid(child),closed,output:()=>output,stdout:()=>stdout,ready:(match,ms)=>until(()=>{
    if(error)throw error
    assert(child.exitCode===null&&child.signalCode===null,`Fixture child exited: ${output.slice(-2000)}`)
    return match(stdout)
  },'owned listener',ms),async stop(close){
    if(child.pid)await stopFixtureChild(child,closed,graceMs,2000,{
      group,startedBy,close:close??(shutdown?()=>child.stdin.end(shutdown):undefined),
    })
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
