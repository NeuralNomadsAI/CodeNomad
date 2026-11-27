import assert from 'node:assert/strict'
import {test} from 'node:test'
import {workspacePolicy,fulfillWorkspaceCreation} from './web-workspace-policy.mjs'

const origin='http://127.0.0.1:12345',project='D:/private/projects/synthetic'
const creation=requestId=>({path:project,requestId})
const response=(id,requestId)=>({id,requestId,location:{directory:project}})
test('origin and cookie refusals never register a creation claim',async()=>{
  const p=workspacePolicy({origin,project})
  const req=(base,cookie)=>({url:()=>base+'/api/workspaces',method:()=> 'POST',postDataJSON:()=>creation('unadmitted'),allHeaders:async()=>({cookie})})
  assert(!await p.request(req(origin,'')))
  assert(!await p.request(req('http://localhost:12345','private=fixture')))
  assert(!await p.request(req(origin,'private=fixture'),{allowApi:false}))
  assert(!p.allows('POST','/api/workspaces/creation/cancel',{requestId:'unadmitted'}))
})
test('UI preferences are read-only and require the private origin and cookie',async()=>{
  const p=workspacePolicy({origin,project})
  for(const path of ['/api/storage/config/ui','/api/storage/state/ui']){
    const req=(base,cookie,method='GET')=>({url:()=>base+path,method:()=>method,allHeaders:async()=>({cookie})})
    assert(await p.request(req(origin,'private=fixture')))
    assert(!await p.request(req(origin,'')))
    assert(!await p.request(req('http://localhost:12345','private=fixture')))
    assert(!await p.request(req(origin,'private=fixture','PATCH')))
    assert(!await p.request(req(origin,'private=fixture'),{allowApi:false}))
  }
})
test('only the timeline scenario may save the exact reasoning filter',()=>{
  const p=workspacePolicy({origin,project,markerFilters:true})
  const route='/api/storage/config/ui'
  const settings={showThinkingBlocks:false,toolCallExpansionDefaults:{preset:'custom',thinking:'collapsed',tools:{bash:'hidden'}}}
  assert(p.allows('PATCH',route,{settings}))
  assert(!p.allows('PATCH',route,{settings:{...settings,locale:'en'}}))
  assert(!p.allows('PATCH',route,{settings:{...settings,showThinkingBlocks:true}}))
  assert(!workspacePolicy({origin,project}).allows('PATCH',route,{settings}))
})
test('only the exact private project and bounded creation claims enter the owned policy',()=>{
  const p=workspacePolicy({origin,project})
  for(const input of [{path:project},creation(''),creation(' '),creation('x'.repeat(129)),{...creation('valid'),path:project+'/other'},{...creation('valid'),location:{directory:'/foreign'}}])assert(!p.allows('POST','/api/workspaces',input))
  assert(!p.allows('POST','/api/workspaces/creation/cancel',{requestId:'valid'}))
  assert(p.allows('POST','/api/workspaces',creation('own-claim')))
  assert(p.allows('POST','/api/workspaces/creation/cancel',{requestId:'own-claim'}))
  assert(!p.allows('GET','/workspaces/foreign/instance/api/session'))
  assert(!p.allows('DELETE','/api/workspaces/foreign'))
})
test('mobile Preferences admits only the private read of memory settings',async()=>{
  const smoke=workspacePolicy({origin,project,mobilePreferences:true})
  const req=(base,cookie,method='GET',suffix='settings')=>({
    url:()=>`${base}/api/memory/${suffix}`,method:()=>method,allHeaders:async()=>({cookie}),
  })
  assert(await smoke.request(req(origin,'private=fixture')))
  assert(!await smoke.request(req(origin,'')))
  assert(!await smoke.request(req('http://localhost:12345','private=fixture')))
  assert(!await smoke.request(req(origin,'private=fixture','PUT')))
  assert(!await smoke.request(req(origin,'private=fixture','GET','entries')))
  assert(!await workspacePolicy({origin,project}).request(req(origin,'private=fixture')))
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
  for(const path of ['/api/meta','/api/workspaces','/api/events','/api/workspaces/one/sessions/ses_existing/permission-mode','/api/workspaces/one/sessions/ses_another/permission-mode','/api/workspaces/one/sessions/ses_linked/permission-mode','/api/workspaces/one/sessions/ses_linked_next/permission-mode','/api/workspaces/one/sessions/ses_existing/permission-receipts','/api/workspaces/one/sessions/ses_another/permission-receipts','/api/workspaces/one/sessions/ses_linked/permission-receipts','/api/workspaces/one/sessions/ses_linked_next/permission-receipts','/workspaces/one/instance/api/model','/workspaces/one/instance/api/session','/workspaces/one/instance/api/session/ses_existing/permission','/workspaces/one/instance/api/session/ses_another/form'])assert(p.allows('GET',path),path)
  assert(!p.allows('GET','/api/workspaces/one/sessions/ses_foreign/permission-mode'))
  assert(!p.allows('GET','/api/workspaces/foreign/sessions/ses_existing/permission-mode'))
  assert(!p.allows('PUT','/api/workspaces/one/sessions/ses_existing/permission-mode',{mode:'supervised'}))
  assert(!p.allows('GET','/api/workspaces/one/sessions/ses_foreign/permission-receipts'))
  assert(!p.allows('GET','/api/workspaces/foreign/sessions/ses_existing/permission-receipts'))
  assert(!p.allows('POST','/api/workspaces/one/sessions/ses_existing/permission-receipts',{}))
  assert(p.allows('POST','/api/workspaces/one/session-history/window',{sessionID:'ses_existing'}))
  assert(!p.allows('POST','/api/workspaces/one/session-history/window',{sessionID:'ses_foreign'}))
  assert(!p.allows('POST','/api/workspaces/one/session-history/window',{sessionID:'ses_existing',extra:'x'.repeat(32768)}))
  assert(p.allows('POST','/api/workspaces/one/session-history/outline',{sessionID:'ses_existing'}))
  assert(!p.allows('POST','/api/workspaces/one/session-history/outline',{sessionID:'ses_foreign'}))
  assert(p.allows('POST','/api/workspaces/one/session-history/query',{sessionID:'ses_existing',purpose:'search'}))
  assert(!p.allows('POST','/api/workspaces/one/session-history/query',{sessionID:'ses_existing',purpose:'prune'}))
  assert(!p.allows('POST','/api/workspaces/one/session-history/query',{sessionID:'ses_foreign',purpose:'search'}))
  assert(p.allows('POST','/api/workspaces/one/session-history/ranked',{version:1,limit:40}))
  for(const path of ['/api/session','/workspaces/one/instance/api/session','/workspaces/one/instance/api/session/ses_existing/prompt','/workspaces/one/instance/api/session/ses_existing/interrupt','/workspaces/one/instance/api/session/ses_existing/permission'])assert(!p.allows('POST',path),path)
})
test('command catalogue reads require an authenticated owned workspace',async()=>{
  const p=workspacePolicy({origin,project}),input=creation('own')
  p.allows('POST','/api/workspaces',input);p.admit(input,response('one','own'),origin)
  const req=(base,workspace,cookie,method='GET')=>({
    url:()=>`${base}/workspaces/${workspace}/instance/api/command`,method:()=>method,
    allHeaders:async()=>({cookie}),
  })
  assert(await p.request(req(origin,'one','private=fixture')))
  assert(!await p.request(req(origin,'one','')))
  assert(!await p.request(req(origin,'foreign','private=fixture')))
  assert(!await p.request(req('http://localhost:12345','one','private=fixture')))
  assert(!await p.request(req(origin,'one','private=fixture','POST')))
})
test('prompt history reads are limited to the fixture folders and an admitted instance',()=>{
  const p=workspacePolicy({origin,project}),input=creation('own')
  const route=key=>`/api/storage/instances/${encodeURIComponent(key)}`
  assert(!p.allows('GET',route(project)))
  p.allows('POST','/api/workspaces',input);p.admit(input,response('one','own'),origin)
  assert(p.allows('GET',route(project)))
  assert(p.allows('GET',route('one')))
  assert(!p.allows('GET',route('D:/other')))
  assert(!p.allows('PUT',route(project),{}))
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
test('the Android benchmark may submit only its exact prompt on an owned session',()=>{
  const androidPrompt='private Android fixture text', p=workspacePolicy({origin,project,androidPrompt})
  const input=creation('own')
  p.allows('POST','/api/workspaces',input);p.admit(input,response('one','own'),origin)
  const route='/workspaces/one/instance/api/session/ses_existing/prompt'
  assert(p.allows('POST',route,{text:androidPrompt}))
  assert(!p.allows('POST',route,{text:'foreign'}))
  assert(!p.allows('POST',route,{text:androidPrompt,files:[]}))
  assert(!p.allows('POST',route.replace('/one/','/foreign/'),{text:androidPrompt}))
  assert(!p.allows('POST',route.replace('ses_existing','ses_another'),{text:androidPrompt}))
})

test('Mission control is admitted only to the recorded lifecycle fixture target',()=>{
  for(const missions of [false,true]){
    const p=workspacePolicy({origin,project,missions}),input=creation('own')
    p.allows('POST','/api/workspaces',input);p.admit(input,response('one','own'),origin)
    const path='/api/workspaces/one/missions/gamma/control'
    const intent={action:'pause',expectedRevision:7,requestId:'a8df8d99-9f05-42e9-8ba6-5558eb68a166',graceful:true}
    assert.equal(p.allows('POST',path,intent),missions)
    assert(!p.allows('POST',path.replace('/one/','/outside/'),intent))
    assert(!p.allows('POST',path.replace('/gamma/','/another/'),intent))
    assert(!p.allows('POST',path,{...intent,action:'stop'}))
    assert(!p.allows('POST',path,{...intent,expectedRevision:0}))
  }
})

test('the mobile menu scene admits only its queued prompt, fixture file and history write',()=>{
  const menuPrompt='fixture prompt',p=workspacePolicy({origin,project,menuPrompt}),input=creation('own')
  const route='/workspaces/one/instance/api/session/ses_existing/prompt'
  const draft={text:menuPrompt,delivery:'queue',resume:false,
    files:[{name:'mobile-menu.txt',uri:'data:text/plain;base64,bWVudSBmaWxl'}]}
  const storage=folder=>`/api/storage/instances/${encodeURIComponent(folder)}`
  const history={messageHistory:[menuPrompt],agentModelSelections:{}}
  assert(!p.allows('POST',route,draft))
  p.allows('POST','/api/workspaces',input);p.admit(input,response('one','own'),origin)
  assert(p.allows('POST',route,draft))
  assert(!p.allows('POST',route,{...draft,delivery:'steer'}))
  assert(!p.allows('POST',route,{...draft,files:[]}))
  assert(!p.allows('POST',route.replace('ses_existing','ses_another'),draft))
  assert(p.allows('PUT',storage(project),history))
  assert(!p.allows('PUT',storage('D:/other'),history))
})
test('session inbox reads stay read-only on admitted fixture sessions',()=>{
  const p=workspacePolicy({origin,project}),input=creation('own')
  p.allows('POST','/api/workspaces',input);p.admit(input,response('one','own'),origin)
  assert(p.allows('GET','/workspaces/one/instance/api/session/ses_existing/inbox'))
  assert(p.allows('GET','/workspaces/one/instance/api/session/ses_linked/inbox'))
  assert(!p.allows('DELETE','/workspaces/one/instance/api/session/ses_existing/inbox'))
  assert(!p.allows('GET','/workspaces/foreign/instance/api/session/ses_existing/inbox'))
  assert(!p.allows('GET','/workspaces/one/instance/api/session/ses_foreign/inbox'))
})
