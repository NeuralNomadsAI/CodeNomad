// Private real OpenCode + shared Rust + real Rune widgets. No model, tool or user profile.
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {copyFile,mkdir,writeFile} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import path from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import {OpenCode} from '@opencode/client'
import {privateEnvironment} from './private-profile.mjs'
import {requireTestSupport,clientBinary,serverBinary} from './fixture-binaries.mjs'

const cli=process.argv[2];assert(cli&&path.isAbsolute(cli),'Supply an absolute private-daemon CLI executable')
const root=path.resolve(import.meta.dirname,'../../../target/rune-real-pending',`trial-${randomUUID()}`),project=path.join(root,'projects','empty')
await mkdir(project,{recursive:true})
const rune=path.join(root,`rune-client${process.platform==='win32'?'.exe':''}`);await copyFile(clientBinary,rune);requireTestSupport(rune)
const env=await privateEnvironment(root),password=randomUUID(),proof={root,project,native:true,ui:'Rune Runtime, offscreen',modelCalls:0,tools:0,requests:[],events:[],stages:[],visible:[],cases:[],cleaned:false,result:1}
Object.assign(env,{OPENCODE_TEST_HOME:env.HOME,OPENCODE_DB:path.join(root,'native.db'),OPENCODE_CONFIG_DIR:path.join(root,'native-config'),OPENCODE_SERVER_PASSWORD:password,
  OPENCODE_CONFIG_PROJECT_DISABLE:'1',OPENCODE_DISABLE_MODELS_FETCH:'1',OPENCODE_DISABLE_FFF:'1',OPENCODE_DISABLE_AUTOUPDATE:'true',OPENCODE_CONFIG_CONTENT:'{}',GIT_CEILING_DIRECTORIES:root})
await mkdir(env.OPENCODE_CONFIG_DIR)
let native,rust,ui,client,observer,watch,session,origin,cookie,nativeLog='',rustLog='',uiLog='',uiLines='',protocolError
const ids=['once','always','reject'].map(decision=>`per_rune_live_${decision}_${randomUUID().replaceAll('-','')}`),forms=new Map()
const expected=['once','always','reject','typed-question','cancel-question'];let position=0,awaiting='ready',protocol=Promise.resolve()
const post=body=>({method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
const live=child=>child&&child.exitCode===null&&child.signalCode===null
async function until(check,label){for(const end=Date.now()+30000;Date.now()<end;await delay(30)){if(protocolError)throw protocolError;const value=await check();if(value)return value}throw Error(`Timeout: ${label}`)}
function owned(program,args,options,log){const child=spawn(program,args,{cwd:root,env,windowsHide:true,stdio:['pipe','pipe','pipe'],...options});child.stdout.on('data',b=>log(b,true));child.stderr.on('data',b=>log(b,false));child.on('error',error=>protocolError??=error);return child}
async function relay(route,init={}){
  const response=await fetch(new URL(route,origin),{...init,headers:{cookie,...init.headers},signal:AbortSignal.timeout(15000)})
  const text=await response.text(),body=text?JSON.parse(text):null;proof.requests.push({host:'rust',method:init.method??'GET',path:route,status:response.status});return{status:response.status,body}
}
async function stage(event){
  if(event.type==='pending-live-visible'){proof.visible.push(event);return}
  if(event.type==='pending-live-complete'){assert.equal(position,5);assert.equal(event.cases,5);proof.complete=event;return}
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
  native=owned(cli,['serve','--hostname','127.0.0.1','--port','0','--log-level','debug','--print-logs'],{},b=>nativeLog=(nativeLog+b).slice(-1048576))
  const base=await until(()=>{assert.equal(native.exitCode,null);return nativeLog.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]},'private OpenCode ready')
  client=OpenCode.make({baseUrl:base,fetch:async(input,init)=>{const request=new Request(input,init),url=new URL(request.url);assert.equal(url.origin,base);assert(!url.pathname.endsWith('/prompt')&&!url.pathname.includes('/shell'),'No model or shell execution');request.headers.set('authorization',`Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`);const response=await fetch(request);proof.requests.push({host:'native',method:request.method,path:url.pathname,status:response.status});return response}})
  proof.version=(await client.server.info()).version
  observer=new AbortController();watch=(async()=>{for await(const event of client.event.subscribe({signal:observer.signal})){proof.events.push({type:event.type,sessionID:event.data?.sessionID,id:event.data?.id});assert(proof.events.length<256)}})();void watch.catch(()=>{})
  await until(()=>proof.events.some(e=>e.type==='server.connected'),'native SSE')
  session=await client.session.create({location:{directory:project},title:'Rune private native pending UI',permissions:[{action:'*',resource:'*',effect:'deny'},{action:'rune_fixture',resource:'*',effect:'ask'}]});assert.equal(path.resolve(session.location.directory),project);proof.session=session.id
  rust=owned(serverBinary,[path.dirname(project),path.join(root,'rust-identity.json'),'0','private-rune-native-pending'],{env:{...env,CNRS_FIXTURE_URL:`${base}/`,CNRS_FIXTURE_PASSWORD:password,CNRS_SERVER_PASSWORD:'fixture-rune-native-pending',CNRS_FIXTURE_STDIN_STOP:'1'}},b=>rustLog=(rustLog+b).slice(-1048576))
  origin=await until(()=>{assert.equal(rust.exitCode,null);return rustLog.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]},'private Rust ready')
  const login=await fetch(`${origin}/api/auth/login`,post({username:'codenomad',password:'fixture-rune-native-pending'}));assert.equal(login.status,200);cookie=login.headers.get('set-cookie').split(';')[0]
  const opened=await relay('/api/workspaces',post({path:project,requestId:`rune-native-ui-${randomUUID()}`}));assert.equal(opened.status,201);assert.equal(path.resolve(opened.body.path),project);proof.workspace=opened.body.id
  ui=owned(rune,['--probe-real-pending'],{env:{...env,RUNE_BACKEND:`${origin}/`,RUNE_PASSWORD:'fixture-rune-native-pending',RUNE_WORKSPACE:proof.workspace,RUNE_SESSION:session.id,RUNE_EMPTY_SESSION:'1',RUNE_PENDING_OUT:root,RUNE_PENDING_IDS:JSON.stringify(ids),RUNE_LOCALE:'fr'}},(b,stdout)=>{
    uiLog=(uiLog+b).slice(-262144);if(!stdout)return;uiLines+=b;assert(uiLines.length<65536)
    for(let at;(at=uiLines.indexOf('\n'))>=0;){const line=uiLines.slice(0,at);uiLines=uiLines.slice(at+1);let value;try{value=JSON.parse(line)}catch{continue}protocol=protocol.then(()=>stage(value)).catch(error=>{protocolError??=error;if(live(ui))ui.kill()})}
  })
  const code=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Rune pending probe exceeded 60 seconds')),60000);ui.once('close',code=>{clearTimeout(timer);resolve(code)});ui.once('error',error=>{clearTimeout(timer);reject(error)})});await protocol;if(protocolError)throw protocolError;assert.equal(code,0);assert.equal(position,5);assert.equal(proof.visible.length,5);assert(proof.complete)
  const receipts=await until(async()=>{const r=await relay(`/api/workspaces/${proof.workspace}/sessions/${session.id}/permission-receipts?unanchored=true`);return r.body?.receipts?.length===3?r.body.receipts:null},'three UI permission receipts')
  proof.receipts=receipts.map(r=>({decision:r.decision,reason:r.reason,origin:r.origin})).sort((a,b)=>a.decision.localeCompare(b.decision));assert.deepEqual(proof.receipts,['always','once','reject'].map(decision=>({decision,reason:`Motif réel Rune ${decision} 🦀`,origin:'codenomad'})))
  assert.equal((await client.experimental.session.export({sessionID:session.id})).messages.length,0);assert(!proof.events.some(e=>e.type.startsWith('session.tool.')||e.type.startsWith('session.execution.')))
  assert.equal(proof.events.filter(e=>e.type==='permission.asked').length,3);assert.equal(proof.events.filter(e=>e.type==='form.created').length,2)
  proof.result=0
}catch(error){proof.error=String(error?.stack??error);process.exitCode=1}
finally{
  if(live(ui)){const stopped=new Promise(resolve=>ui.once('close',resolve));ui.kill();await stopped}observer?.abort();await watch?.catch(()=>{})
  try{if(client&&session){await client.session.remove({sessionID:session.id});proof.cleaned=true;assert(!(await client.session.list({location:{directory:project}})).data.some(s=>s.id===session.id))}}
  catch(error){proof.result=1;proof.cleanupError=String(error);process.exitCode=1}
  finally{if(live(rust)){const stopped=new Promise(resolve=>rust.once('close',resolve));rust.stdin.end('shutdown\n');await Promise.race([stopped,delay(5000,undefined,{ref:false})]);if(live(rust))rust.kill();await stopped}proof.rustExit=rust?.exitCode??null
    if(rust&&proof.rustExit!==0){proof.result=1;proof.cleanupError??='Rust did not stop cleanly';process.exitCode=1}
    if(live(native)){const stopped=new Promise(resolve=>native.once('close',resolve));native.kill();await stopped}proof.nativeStopped=!live(native)
    await writeFile(path.join(root,'proof.json'),JSON.stringify(proof,null,2));await writeFile(path.join(root,'native.log'),nativeLog);await writeFile(path.join(root,'rust.log'),rustLog);await writeFile(path.join(root,'rune.log'),uiLog)
    console.log(JSON.stringify({result:proof.result,version:proof.version,cases:proof.cases.length,cleaned:proof.cleaned,rustExit:proof.rustExit,root,error:proof.error?.split('\n')[0]}))}
}
