import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { OpenCode } from '@opencode/client'
const root = await mkdtemp('C:/Users/Admin/AppData/Local/Temp/opencode/native-contract-shape-')
await mkdir(root + '/config'); await mkdir(root + '/project'); await mkdir(root + '/plugin')
await writeFile(root + '/config/opencode.json', '{}')
await writeFile(root + '/plugin/index.ts', `export default {id:'private.contract.shape',async setup(ctx){
 const shape = value => ({type:typeof value,keys:value && Object.keys(value),json:JSON.stringify(value,(_,v)=>typeof v==='function'?'FUNCTION':v)});
 await ctx.tool.transform(e=>e.update('subagent',d=>{ctx.storage.set('shape',{keys:Object.keys(d),input:shape(d.input),parameters:shape(d.parameters),options:d.options});}));
 await ctx.session.hook('context',async e=>{await ctx.storage.set('context',shape(e.tools.subagent));});
 await ctx.rpc.register({id:'private.contract.shape',methods:{read:{input:{type:'object'},output:{type:'object'}}},events:{}},{read:async()=>({shape:await ctx.storage.get('shape'),context:await ctx.storage.get('context')})});
}}`)
let requestBody, output = '', child
const provider = createServer(async (req,res)=>{let raw='';for await(const c of req)raw+=c;requestBody=JSON.parse(raw);res.setHeader('content-type','text/event-stream');res.end('data: '+JSON.stringify({id:'shape',object:'chat.completion.chunk',choices:[{index:0,delta:{role:'assistant',content:'DONE'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n')})
await new Promise(r=>provider.listen(0,'127.0.0.1',r))
const env = Object.fromEntries(Object.entries(process.env).filter(([k])=>/^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS)$/i.test(k)))
Object.assign(env,{HOME:root,USERPROFILE:root,APPDATA:root,LOCALAPPDATA:root,OPENCODE_TEST_HOME:root,OPENCODE_DB:root+'/db.sqlite',OPENCODE_CONFIG_DIR:root+'/config',OPENCODE_SERVER_PASSWORD:'private',OPENCODE_CONFIG_PROJECT_DISABLE:'1',OPENCODE_DISABLE_MODELS_FETCH:'1',OPENCODE_DISABLE_FFF:'1'})
for(const k of ['XDG_DATA_HOME','XDG_CONFIG_HOME','XDG_STATE_HOME','XDG_CACHE_HOME','XDG_RUNTIME_DIR'])env[k]=root+'/'+k
env.OPENCODE_CONFIG_CONTENT=JSON.stringify({model:'fixture/fixture',snapshots:false,update:'disable',plugins:[root+'/plugin'],providers:{fixture:{package:'@opencode/ai/providers/openai-compatible',settings:{apiKey:'private',baseURL:'http://127.0.0.1:'+provider.address().port+'/v1'},models:{fixture:{}}}}})
try{
 child=spawn('C:/Users/Admin/AppData/Roaming/npm/node_modules/@opencode/cli/bin/opencode.exe',['serve','--hostname','127.0.0.1','--port','0','--print-logs'],{cwd:root,env,windowsHide:true})
 child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d)
 const deadline=Date.now()+45000;while(!/http:\/\/127\.0\.0\.1:\d+/.test(output)){if(Date.now()>deadline)throw Error(output);await delay(50)}
 const client=OpenCode.make({baseUrl:output.match(/http:\/\/127\.0\.0\.1:\d+/)[0],headers:{authorization:'Basic '+Buffer.from('opencode:private').toString('base64')}})
 const server=await client.server.info();const location={directory:root+'/project'};const s=await client.session.create({location});await client.session.prompt({sessionID:s.id,text:'Private shape only'});await client.session.wait({sessionID:s.id},{signal:AbortSignal.timeout(30000)})
 const result=await client.rpc({id:'private.contract.shape',methods:{read:{input:{type:'object'},output:{type:'object'}}},events:{}}).read({}, {location})
 await writeFile(root+'/shape.json',JSON.stringify({server,result,requestBody},null,2));console.log(root,JSON.stringify(result))
}finally{child?.kill();provider.closeAllConnections();await new Promise(r=>provider.close(r));await writeFile(root+'/serve.log',output)}
