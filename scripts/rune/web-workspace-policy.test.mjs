import assert from 'node:assert/strict'
import {test} from 'node:test'
import {workspacePolicy,fulfillWorkspaceCreation} from './web-workspace-policy.mjs'

const origin='http://127.0.0.1:12345',project='D:/private/projects/synthetic'
const creation=requestId=>({path:project,requestId})
const response=(id,requestId)=>({id,requestId,location:{directory:project}})
test('only the exact private project and bounded creation claims enter the owned policy',()=>{
  const p=workspacePolicy({origin,project})
  for(const input of [{path:project},creation(''),creation(' '),creation('x'.repeat(129)),{...creation('valid'),path:project+'/other'},{...creation('valid'),location:{directory:'/foreign'}}])assert(!p.allows('POST','/api/workspaces',input))
  assert(!p.allows('POST','/api/workspaces/creation/cancel',{requestId:'valid'}))
  assert(p.allows('POST','/api/workspaces',creation('own-claim')))
  assert(p.allows('POST','/api/workspaces/creation/cancel',{requestId:'own-claim'}))
  assert(!p.allows('GET','/workspaces/foreign/instance/api/session'))
  assert(!p.allows('DELETE','/api/workspaces/foreign'))
})
test('invalid admissions leave every workspace unowned; release requires its own claim',()=>{
  const p=workspacePolicy({origin,project}),input=creation('first')
  p.allows('POST','/api/workspaces',input)
  for(const body of [{...response('one','first'),id:'../escape'},response('one','other'),{...response('one','first'),location:{directory:'/foreign'}},{...response('one','first'),location:{directory:project,workspaceID:'native'}}]){
    assert.throws(()=>p.admit(input,body,origin));assert.equal(p.workspaces.size,0)
  }
  assert.throws(()=>p.admit(input,response('one','first'),'http://localhost:54321'))
  p.admit(input,response('one','first'),origin)
  const second=creation('second');p.allows('POST','/api/workspaces',second)
  assert.throws(()=>p.admit(second,response('one','second'),origin))
  assert.throws(()=>p.admit(input,response('two','first'),origin))
  assert(p.allows('POST','/api/workspaces/one/creation/release',{requestId:'first'}))
  assert(!p.allows('POST','/api/workspaces/one/creation/release',{requestId:'second'}))
  assert(p.allows('DELETE','/api/workspaces/one'))
  assert(!p.allows('DELETE','/api/workspaces/one',null,{forbidRelease:true}))
})
test('owned reads retain fixed sessions, history bounds and the prohibition on native mutations',()=>{
  const p=workspacePolicy({origin,project}),input=creation('own')
  p.allows('POST','/api/workspaces',input);p.admit(input,response('one','own'),origin)
  for(const path of ['/api/meta','/api/workspaces','/api/events','/workspaces/one/instance/api/model','/workspaces/one/instance/api/session','/workspaces/one/instance/api/session/ses_existing/permission','/workspaces/one/instance/api/session/ses_another/form'])assert(p.allows('GET',path),path)
  assert(p.allows('POST','/api/workspaces/one/session-history/window',{sessionID:'ses_existing'}))
  assert(!p.allows('POST','/api/workspaces/one/session-history/window',{sessionID:'ses_foreign'}))
  assert(!p.allows('POST','/api/workspaces/one/session-history/window',{sessionID:'ses_existing',extra:'x'.repeat(32768)}))
  for(const path of ['/api/session','/workspaces/one/instance/api/session','/workspaces/one/instance/api/session/ses_existing/prompt','/workspaces/one/instance/api/session/ses_existing/interrupt','/workspaces/one/instance/api/session/ses_existing/permission'])assert(!p.allows('POST',path),path)
})
test('the fetched creation is validated and admitted before browser delivery',async()=>{
  for(const valid of [true,false]){
    const p=workspacePolicy({origin,project}),input=creation('own');p.allows('POST','/api/workspaces',input)
    let fulfilled=false
    const route={request:()=>({postDataJSON:()=>input}),fetch:async options=>{
      assert.equal(options.maxRedirects,0);assert.equal(options.timeout,30000)
      return {ok:()=>true,url:()=>origin,body:async()=>Buffer.from(JSON.stringify(response('one',valid?'own':'foreign')))}
    },fulfill:async()=>{assert(p.workspaces.has('one'));fulfilled=true}}
    if(valid)assert.deepEqual(await fulfillWorkspaceCreation(route,p),{workspaceId:'one',admittedBeforeFulfill:true})
    else await assert.rejects(fulfillWorkspaceCreation(route,p))
    assert.equal(fulfilled,valid)
  }
})
