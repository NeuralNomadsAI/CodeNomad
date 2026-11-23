import assert from 'node:assert/strict'
import {test} from 'node:test'
import {attestNative} from './live-access.mjs'

const origin='http://127.0.0.1:42395'
const auth='fixture-credential'
const fixture=()=>({pid:127,exitCode:null,signalCode:null})

test('live fixtures fail closed before work when the listener cannot prove its PID',async()=>{
  const child=fixture()
  for(const response of [Response.json({pid:381}),Response.json({}, {status:401}),Response.json({})]){
    const requests=[]
    await assert.rejects(attestNative(origin,child,auth,async(url,init)=>{
      requests.push([url.pathname,init.method??'GET'])
      assert.equal(init.headers.authorization,auth)
      assert.equal(init.redirect,'error')
      return response
    }),/the shared OpenCode service is forbidden/)
    assert.deepEqual(requests,[['/api/info','GET']])
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
  const read=await attestNative(origin,child,auth,request)
  await assert.rejects(read('http://127.0.0.1:42396/api/session',{method:'POST'}),/the shared OpenCode service is forbidden/)
  await read('/api/session')
  child.signalCode='SIGTERM'
  await assert.rejects(read('/api/session',{method:'DELETE'}),/Private OpenCode has exited/)
  assert.deepEqual(requests,[`${origin}/api/info`,`${origin}/api/session`])
})
