// Private real OpenCode + shared Rust + real Rune widgets. No model, tool or user profile.
import assert from 'node:assert/strict'
import {writeFile} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import path from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import {requireTestSupport,clientBinary,serverBinary} from './fixture-binaries.mjs'
import {fixtureTarget,requirePrivateCli,withNative} from './live-access.mjs'
import {launchFixture,rustOrigin} from './fixture-host.mjs'
import {createAttestedFetch,createAttestedRelay,redactSecrets,RELAY_PLACEHOLDER_PASSWORD,resolveWorktreePackage} from '../../../scripts/native-fixture-http.mjs'

const {OpenCode}=await import(resolveWorktreePackage('@opencode/client'))
requirePrivateCli();requireTestSupport()
await withNative(async native=>{
const {profile:root,project,password}=native
const secrets=[password,'fixture-rune-native-pending']
const env=native.runtimeEnv,proof={root,project,native:true,ui:'Rune Runtime, offscreen',modelCalls:0,tools:0,requests:[],events:[],stages:[],visible:[],cases:[],cleaned:false,result:1}
let rust,ui,client,observer,watch,watchError,session,origin,cookie,uiLines='',protocolError,rustFetch,rustRelay
const ids=['once','always','reject'].map(decision=>`per_rune_live_${decision}_${randomUUID().replaceAll('-','')}`),forms=new Map()
const expected=['once','always','reject','typed-question','cancel-question'];let position=0,awaiting='ready',protocol=Promise.resolve()
const post=body=>({method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
async function until(check,label){const end=Date.now()+30000;while(Date.now()<end){if(protocolError)throw protocolError;if(watchError)throw watchError;const remaining=Math.max(100,end-Date.now());const value=await Promise.race([Promise.resolve().then(()=>check(remaining)),delay(remaining,null,{ref:false})]);if(value)return value;await delay(Math.min(30,Math.max(0,end-Date.now())))}throw Error(`Timeout: ${label}`)}
async function relay(route,init={},timeoutMs=15000){
  const target=fixtureTarget(route,origin)
  assert(target,'Foreign fixture origin forbidden')
  const response=await rustFetch(target,{...init,headers:{cookie,...init.headers},signal:AbortSignal.timeout(timeoutMs)})
  const text=await response.text(),body=text?JSON.parse(text):null;proof.requests.push({host:'rust',method:init.method??'GET',path:route,status:response.status});return{status:response.status,body}
}
async function stage(event){
  if(event.type==='pending-live-visible'){proof.visible.push(event);return}
  if(event.type==='pending-live-complete'){assert.equal(position,5);assert.equal(event.cases,5);assert.equal(event.transcriptReceipts,3);proof.complete=event;return}
  if(event.type!=='pending-live-stage')return
  assert.equal(event.case,expected[position]);assert.equal(event.stage,awaiting);proof.stages.push(event)
  const index=position,prefix=`/workspaces/${proof.workspace}/instance/api/session/${session.id}`
  if(event.stage==='ready'){
    awaiting='done'
    if(index<3){assert.equal(event.id,ids[index]);assert.equal((await client.permission.create({sessionID:session.id,id:event.id,agent:'build',action:'rune_fixture',resources:[`synthetic-${event.case}`]})).effect,'ask')}
    else{const fields=index===3?[{key:'name',type:'string',required:true},{key:'count',type:'integer',minimum:1,maximum:4},{key:'enabled',type:'boolean'}]:[{key:'value',type:'string'}]
      forms.set(event.case,await client.session.form.create({sessionID:session.id,title:index===3?'Rune native typed question':'Rune native cancelled question',fields}))}
  }else{
    if(index<3){assert.equal(event.id,ids[index]);assert(!(await client.permission.list({sessionID:session.id})).some(p=>p.id===event.id));assert.equal((await relay(`${prefix}/permission/${event.id}/reply`,post({decision:event.case}))).status,404)}
    else{assert.equal(event.id,forms.get(event.case).id);const detail=await client.session.form.get({sessionID:session.id,formID:event.id});assert.equal(detail.state.status,index===3?'answered':'cancelled')
      if(index===3)assert.deepEqual(detail.state.answer,{name:'Réponse native Rune 🦀\nDeuxième ligne',count:2,enabled:true})
      else assert.equal((await relay(`${prefix}/form/${event.id}`,{method:'DELETE'})).status,409)}
    proof.cases.push({case:event.case,id:event.id,nativeSettlement:true});position++;awaiting='ready'
  }
}
try{
  client=OpenCode.make({baseUrl:native.origin,fetch:async(input,init)=>{const request=new Request(input,init),url=new URL(request.url);assert(!url.pathname.endsWith('/prompt')&&!url.pathname.includes('/shell'),'No model or shell execution');const response=await native.send(request);proof.requests.push({host:'native',method:request.method,path:url.pathname,status:response.status});return response}})
  proof.version=(await client.server.info()).version
  observer=new AbortController();watch=(async()=>{try{for await(const event of client.event.subscribe({signal:observer.signal})){proof.events.push({type:event.type,sessionID:event.data?.sessionID,id:event.data?.id});assert(proof.events.length<256)}}catch(error){if(!observer.signal.aborted&&error?.name!=='AbortError')watchError??=error}})()
  await until(()=>proof.events.some(e=>e.type==='server.connected'),'native SSE')
  session=await client.session.create({location:{directory:project},title:'Rune private native pending UI',permissions:[{action:'*',resource:'*',effect:'deny'},{action:'rune_fixture',resource:'*',effect:'ask'}]});assert.equal(path.resolve(session.location.directory),project);proof.session=session.id
  const rustPassword=randomUUID()
  rust=launchFixture(serverBinary,[path.dirname(project),path.join(root,'rust-identity.json'),'0','private-rune-native-pending'],{cwd:root,shutdown:'shutdown\n',redact:[password,rustPassword],env:{...env,CNRS_FIXTURE_URL:native.relay,CNRS_FIXTURE_PASSWORD:native.relayPassword,CNRS_SERVER_PASSWORD:rustPassword,CNRS_FIXTURE_STDIN_STOP:'1'}})
  native.allowRelayClient(rust.pid(),rust.closed)
  origin=await rust.ready(rustOrigin)
  const rustPid=await rust.pid()
  rustFetch=createAttestedFetch(origin,Number(new URL(origin).port),rustPid)
  rustRelay=await createAttestedRelay(origin,rustPid,{requireClientAttestation:true,substitutePassword:rustPassword,isolateSessionCookie:true})
  const login=await rustFetch(`${origin}/api/auth/login`,{...post({username:'codenomad',password:rustPassword}),signal:AbortSignal.timeout(15000)});assert.equal(login.status,200);cookie=login.headers.get('set-cookie').split(';')[0]
  const opened=await relay('/api/workspaces',post({path:project,requestId:`rune-native-ui-${randomUUID()}`}));assert.equal(opened.status,201);assert.equal(path.resolve(opened.body.path),project);proof.workspace=opened.body.id
  await until(async remaining=>{
    const window=await relay(`/api/workspaces/${proof.workspace}/session-history/window`,{
      ...post({sessionID:session.id,target:{kind:'latest'}}),
      headers:{'content-type':'application/json','x-codenomad-user-files':'reference-v1'},
    },Math.min(15000,remaining))
    proof.historyStatus={status:window.status,kind:window.body?.status,reason:window.body?.reason}
    return window.body?.status==='window'
  },'native history window ready')
  ui=launchFixture(clientBinary,['--probe-real-pending'],{cwd:root,redact:[password,rustPassword],env:{...env,RUNE_BACKEND:`${rustRelay.origin}/`,RUNE_PASSWORD:RELAY_PLACEHOLDER_PASSWORD,RUNE_WORKSPACE:proof.workspace,RUNE_SESSION:session.id,RUNE_EMPTY_SESSION:'1',RUNE_PENDING_OUT:root,RUNE_PENDING_IDS:JSON.stringify(ids),RUNE_LOCALE:'fr'}})
  rustRelay.allowClientPid(ui.pid(),ui.closed)
  ui.child.stdout.on('data',b=>{
    uiLines+=b
    if(uiLines.length>=65536){protocolError??=Error('Pending probe stdout exceeded 64 KiB');ui.child.kill();return}
    for(let at;(at=uiLines.indexOf('\n'))>=0;){const line=uiLines.slice(0,at);uiLines=uiLines.slice(at+1);let value;try{value=JSON.parse(line)}catch{continue}protocol=protocol.then(()=>stage(value)).catch(error=>{protocolError??=error;ui.child.kill()})}
  })
  const code=await Promise.race([ui.closed.then(async exit=>{await protocol;return exit}),delay(60000,124,{ref:false})]);if(code===124)await ui.stop();if(protocolError)throw protocolError;assert.equal(code,0);assert.equal(position,5);assert.equal(proof.visible.length,5);assert(proof.complete)
  const receipts=await until(async remaining=>{const r=await relay(`/api/workspaces/${proof.workspace}/sessions/${session.id}/permission-receipts?unanchored=true`,{},Math.min(15000,remaining));return r.body?.receipts?.length===3?r.body.receipts:null},'three UI permission receipts')
  proof.receipts=receipts.map(r=>({decision:r.decision,reason:r.reason,origin:r.origin})).sort((a,b)=>a.decision.localeCompare(b.decision));assert.deepEqual(proof.receipts,['always','once','reject'].map(decision=>({decision,reason:`Motif réel Rune ${decision} 🦀`,origin:'codenomad'})))
  const history=await relay(`/api/workspaces/${proof.workspace}/session-history/window`,post({sessionID:session.id,target:{kind:'latest'}}))
  assert.equal(history.body?.status,'window');assert.deepEqual(history.body.messages,[])
  if(watchError)throw watchError
  assert(!proof.events.some(e=>e.type.startsWith('session.tool.')||e.type.startsWith('session.execution.')))
  assert.equal(proof.events.filter(e=>e.type==='permission.asked').length,3);assert.equal(proof.events.filter(e=>e.type==='form.created').length,2)
  proof.result=0
}catch(error){proof.error=redactSecrets(String(error?.stack??error),secrets);process.exitCode=1}
finally{
  observer?.abort();if(watch)await Promise.race([watch.catch(()=>{}),delay(2000,undefined,{ref:false})])
  try{await ui?.stop();if(client&&session){await client.session.remove({sessionID:session.id});proof.cleaned=true;assert(!(await client.session.list({location:{directory:project}})).data.some(s=>s.id===session.id))}}
  catch(error){proof.result=1;proof.cleanupError=redactSecrets(String(error),secrets);process.exitCode=1}
  finally{try{await Promise.allSettled([rustFetch?.close(),rustRelay?.close()])}finally{await rust?.stop()};proof.rustExit=rust?.child.exitCode??null
    if(rust&&proof.rustExit!==0){proof.result=1;proof.cleanupError??='Rust did not stop cleanly';process.exitCode=1}
    await writeFile(path.join(root,'proof.json'),JSON.stringify(proof,null,2));await writeFile(path.join(root,'rust.log'),rust?.output()??'');await writeFile(path.join(root,'rune.log'),ui?.output()??'')
    console.log(JSON.stringify({result:proof.result,version:proof.version,cases:proof.cases.length,cleaned:proof.cleaned,rustExit:proof.rustExit,root,error:proof.error?.split('\n')[0]}))}
}
})
