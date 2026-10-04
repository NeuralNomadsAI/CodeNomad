// Independent native default-permission and reload qualification, not a retry of
// the broad fixture's intentionally retained global-allow negative assertion.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { OpenCode } from '@opencode/client'
import { build } from 'esbuild'
const experiment='D:/CodeNomad/.codenomad/worktrees/missions-native-subsessions-20261003'
assert.equal(process.cwd().replaceAll('\\','/').toLowerCase(),experiment.toLowerCase())
const root=await mkdtemp('C:/Users/Admin/AppData/Local/Temp/opencode/native-contract-default-')
for(const name of ['config','project','plugin'])await mkdir(root+'/'+name)
await writeFile(root+'/config/opencode.json','{}')
await build({entryPoints:[experiment+'/packages/server/src/missions/native-subsession-experiment/contract-wrapper.ts'],outfile:root+'/plugin/wrapper.mjs',bundle:true,platform:'node',format:'esm',target:'node22',logLevel:'silent'})
const token=randomUUID(), rpc={id:'private.contract.default',methods:{control:{input:{type:'object'},output:{type:'object'}}},events:{}}
await writeFile(root+'/plugin/index.ts',`import {installNativeMissionContracts} from './wrapper.mjs';export default {id:'private.contract.default',async setup(ctx){
 const m=await installNativeMissionContracts(ctx);await ctx.session.hook('http.request',e=>{e.request.headers.set('x-session',e.sessionID);e.request.headers.set('x-kind',e.kind)});await ctx.session.hook('retry',e=>{e.decision={retry:false}});
 await ctx.rpc.register(${JSON.stringify(rpc)},{control:async i=>{if(i.token!==${JSON.stringify(token)})throw Error('Private authority');if(i.action==='seed')return m.seed(i.plan);if(i.action==='inspect')return JSON.parse(JSON.stringify(await m.inspect()));if(i.action==='agents')return await ctx.agent.list();throw Error('No invocation bypass')}});return ()=>m.dispose();}}`)
const requests=[],events=[],results={},transcripts={}
let child,output='',client,stage='boot',parentID,childID,failure,timer
const abort=new AbortController(),steps=new Map(),ref=taskKey=>({missionID:'private_default',revision:1,taskKey})
const tool=(name,input)=>({name,input,id:'call_'+randomUUID().replaceAll('-','')})
const sub=(taskKey,agent='general')=>tool('subagent',{agent,description:'Native default proof',prompt:'Native default proof',mission:ref(taskKey)})
function emit(res,answer){const d=typeof answer==='string'?{role:'assistant',content:answer}:{role:'assistant',tool_calls:[{index:0,id:answer.id,type:'function',function:{name:answer.name,arguments:JSON.stringify(answer.input)}}]};res.setHeader('content-type','text/event-stream');for(const [delta,finish_reason]of[[d,null],[{},typeof answer==='string'?'stop':'tool_calls']])res.write('data: '+JSON.stringify({id:'private',object:'chat.completion.chunk',choices:[{index:0,delta,finish_reason}]})+'\n\n');res.end('data: [DONE]\n\n')}
const provider=createServer(async(req,res)=>{try{let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw),sessionID=req.headers['x-session'],kind=req.headers['x-kind'];requests.push({sessionID,kind,body,time:Date.now()});assert(requests.length<=30);if(kind!=='primary')return emit(res,'Private title');if(!steps.has(sessionID)&&sessionID!==parentID){childID=sessionID;steps.set(sessionID,[sub('forbidden','general'),tool('mission_contract_report',{contract:ref('general-work'),outcome:'completed',summary:'General native negative control'}),'GENERAL_DEFAULT_FINAL'])}emit(res,steps.get(sessionID)?.shift()??'DEFAULT_NATIVE_DONE')}catch(e){failure=e;res.destroy()}})
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>/^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS)$/i.test(k)))
Object.assign(env,{HOME:root,USERPROFILE:root,APPDATA:root,LOCALAPPDATA:root,OPENCODE_TEST_HOME:root,OPENCODE_DB:root+'/db.sqlite',OPENCODE_CONFIG_DIR:root+'/config',OPENCODE_SERVER_PASSWORD:'private',OPENCODE_CONFIG_PROJECT_DISABLE:'1',OPENCODE_DISABLE_MODELS_FETCH:'1',OPENCODE_DISABLE_FFF:'1'})
for(const k of ['XDG_DATA_HOME','XDG_CONFIG_HOME','XDG_STATE_HOME','XDG_CACHE_HOME','XDG_RUNTIME_DIR'])env[k]=root+'/'+k
await new Promise(r=>provider.listen(0,'127.0.0.1',r))
env.OPENCODE_CONFIG_CONTENT=JSON.stringify({model:'fixture/fixture',snapshots:false,update:'disable',experimental:{subagent_depth:3},permissions:[{action:'execute',resource:'*',effect:'deny'}],plugins:[root+'/plugin'],providers:{fixture:{package:'@opencode/ai/providers/openai-compatible',settings:{apiKey:'private',baseURL:'http://127.0.0.1:'+provider.address().port+'/v1'},models:{fixture:{}}}}})
const primary=id=>requests.filter(r=>r.sessionID===id&&r.kind==='primary')
const control=i=>client.rpc(rpc).control({token,...i},{location:{directory:root+'/project'},signal:AbortSignal.timeout(15000)})
const messages=async id=>(await client.message.list({sessionID:id,limit:{order:'asc',limit:100}})).data
const parts=rows=>rows.flatMap(m=>m.content??[]).filter(p=>p.type==='tool')
try{
 child=spawn('C:/Users/Admin/AppData/Roaming/npm/node_modules/@opencode/cli/bin/opencode.exe',['serve','--hostname','127.0.0.1','--port','0','--print-logs'],{cwd:root,env,windowsHide:true});child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);timer=setTimeout(()=>{failure=Error('Private deadline');child.kill();provider.closeAllConnections()},90000)
 const deadline=Date.now()+30000;while(!/http:\/\/127\.0\.0\.1:\d+/.test(output)){if(Date.now()>deadline)throw Error(output);await delay(40)}
 client=OpenCode.make({baseUrl:output.match(/http:\/\/127\.0\.0\.1:\d+/)[0],headers:{authorization:'Basic '+Buffer.from('opencode:private').toString('base64')}});results.server=await client.server.info();assert.equal(results.server.version,'2.0.22')
 void(async()=>{try{for await(const e of client.event.subscribe({signal:abort.signal}))events.push(e)}catch(e){if(!abort.signal.aborted)failure=e}})()
 results.agents=await control({action:'agents'});const p=await client.session.create({location:{directory:root+'/project'},title:'Default native permission root'});parentID=p.id
 const task=(key,parentTaskKey)=>({key,parentTaskKey,title:key,brief:'Private bounded contract',role:'prototype',blockedBy:[]})
 await control({action:'seed',plan:{missionID:'private_default',coordinatorID:parentID,expectedRevision:0,objective:'Default permissions and native storage reload',tasks:[task('general-work',null),task('forbidden','general-work')]}})
 steps.set(parentID,[sub('general-work'),'ROOT_DEFAULT_FINISHED'])
 stage='General defaults deny native recursion';await client.session.prompt({sessionID:parentID,text:'Real General default control'});await client.session.wait({sessionID:parentID},{signal:AbortSignal.timeout(30000)});if(failure)throw failure
 results.beforeReload=await control({action:'inspect'});assert(childID)
 assert(!primary(childID)[0].body.tools.some(t=>t.function.name==='subagent'),'Builtin General default excludes subagent')
 const childParts=parts(await messages(childID));assert(childParts.some(p=>p.name==='subagent'&&p.state.status==='error'))
 assert(!events.some(e=>e.type==='session.created'&&e.data.parentID===childID));assert(!results.beforeReload.entries.some(e=>e.key.includes('/owner/private_default/forbidden')))
 assert(primary(parentID).some(r=>JSON.stringify(r.body.messages).includes('GENERAL_DEFAULT_FINAL')));assert(primary(parentID).some(r=>JSON.stringify(r.body.messages).includes('MISSION_BUSINESS_REPORT_REFERENCE:')))
 assert.equal((await messages(parentID)).filter(m=>m.type==='synthetic').length,0)
 stage='private native reload persistence';await client.location.reload({signal:AbortSignal.timeout(20000)});results.afterReload=await control({action:'inspect'})
 assert.deepEqual(results.afterReload.entries,results.beforeReload.entries);assert.deepEqual(results.afterReload.snapshot.missions,results.beforeReload.snapshot.missions);assert.equal(results.afterReload.snapshot.discardedEvents,0)
 results.status='passed';results.confirmed={builtinGeneralDefaultDeny:true,noGrandchild:true,noContractEffectBypass:true,nativeParentConsumedReturnAndReportReference:true,persistedReload:true}
}catch(e){results.status='failed';results.failure={stage,error:String(e),detail:e,providerFailure:failure?String(failure):null};process.exitCode=1}
finally{
 clearTimeout(timer);abort.abort();if(client)for(const id of [parentID,childID].filter(Boolean))transcripts[id]=await messages(id)
 results.counts={providerRequests:requests.length,primaryRequests:requests.filter(r=>r.kind==='primary').length,nativeEvents:events.length,nativeSessions:[parentID,childID].filter(Boolean).length}
 results.sources=Object.fromEntries(await Promise.all(['scripts/native-subsession-spike/contract-wrapper/default-permissions.mjs','packages/server/src/missions/native-subsession-experiment/contract-wrapper.ts'].map(async file=>[file,createHash('sha256').update(await readFile(experiment+'/'+file)).digest('hex')])))
 await Promise.all([['results.json',results],['requests.json',requests],['events.json',events],['transcripts.json',transcripts]].map(([file,data])=>writeFile(root+'/'+file,JSON.stringify(data,null,2))));await writeFile(root+'/serve.log',output)
 const stopped=child&&new Promise(r=>{if(child.exitCode!==null)r();else child.once('close',r)});child?.kill();if(stopped)await stopped;provider.closeAllConnections();await new Promise(r=>provider.close(r));console.log(results.status.toUpperCase(),root,JSON.stringify(results.counts),results.failure??'')
}
