// Actual shared Rune menu, through the offscreen application gallery and host poll.
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {createHash} from 'node:crypto'
import {mkdir,readFile,writeFile} from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {parseArgs} from 'node:util'
import {privateEnvironment} from '../../../packages/rune-app/private-profile.mjs'

const root=fileURLToPath(new URL('../../../',import.meta.url))
const {values}=parseArgs({options:{binary:{type:'string'}}})
assert(values.binary&&path.isAbsolute(values.binary),'--binary requires an absolute test-support application path')
const out=path.join(root,'target/rune-action-menu');await mkdir(out,{recursive:true})
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
const provenance={binary:{path:values.binary,sha256:hash(await readFile(values.binary))},
  fixtureSha256:hash(await readFile(fileURLToPath(import.meta.url))),
  themeSha256:hash(await readFile(path.join(root,'crates/rune-theme-codenomad/assets/theme.json')))}
async function run(args,profile,mode='standard'){
  const env={...await privateEnvironment(path.join(out,'profiles',profile)),RUNE_MENU_CASE:mode,RUNE_MENU_LOCALE:'en'}
  return new Promise((resolve,reject)=>{
    const child=spawn(values.binary,['--gallery-action-menu',...args],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']})
    let log=''
    const timer=setTimeout(()=>{child.kill();reject(Error('Owned offscreen menu gallery exceeded 60 seconds'))},60000)
    for(const pipe of [child.stdout,child.stderr])pipe.on('data',bytes=>log=(log+bytes).slice(-1048576))
    child.on('error',error=>{clearTimeout(timer);reject(error)})
    child.on('close',code=>{clearTimeout(timer);resolve({code,log})})
  })
}
const key=(t,name)=>({t,type:'key',name})
const up=(t,name)=>({t,type:'key-up',name})
const opening=[key(0.1,'Tab'),key(0.2,'ArrowDown'),up(0.25,'ArrowDown')]
async function capture(name,events,theme='light',mode='standard',checkpoints=[1,2,4]){
  const base=path.join(out,`native-${name}`),script=`${base}.script.json`,tree=`${base}.json`,image=`${base}.png`
  await writeFile(script,JSON.stringify({events},null,2)+'\n')
  let result,data,simulatedSceneSeconds
  for(const at of checkpoints){
    result=await run(['--script',script,'--tree',tree,'--snap',image,'--size','480x360','--theme',theme,'--scale','1','--at',String(at)],name,mode)
    await writeFile(`${base}.log`,result.log);assert.equal(result.code,0,result.log)
    data=JSON.parse(await readFile(tree,'utf8'));simulatedSceneSeconds=at
    if(!data.animating&&!data.elements.some(e=>e.moving||e.exiting))break
  }
  assert.deepEqual(data.viewport,[480,360]);assert.equal(data.animating,false,'Capture requires settled actual component')
  assert(!data.elements.some(e=>e.moving||e.exiting),'Capture requires completed transitions')
  const trace=result.log.split(/\r?\n/).filter(line=>line.startsWith('action-menu-event:')).map(line=>JSON.parse(line.slice('action-menu-event:'.length)))
  return {theme,name,image,tree,script,log:`${base}.log`,simulatedSceneSeconds,trace,data}
}
const records=[],deferredHelp=[],interaction={provenance,safeFlags:[],keyboard:[],actions:[],dialogClose:[],
  sourceContract:{fixture:'action-menu.fixture.tsx',mode:'alert-immediate-target',
    observed:'Actual Solid AlertDialog keeps Cancel focused when focusAfterSelect resolves Accept, for keyboard and pointer in both appearances.'}}
for(const flags of [[],['--tree',path.join(out,'must-not-exist.json')]]){
  const result=await run(flags,'rejected-flags');assert.equal(result.code,2,result.log)
  interaction.safeFlags.push({flags,status:result.code,error:result.log})
}
for(const [name,events] of Object.entries({Enter:[key(0.1,'Tab'),key(0.2,'Enter'),up(0.25,'Enter')],
  ArrowDown:opening,ArrowUp:[key(0.1,'Tab'),key(0.2,'ArrowUp'),up(0.25,'ArrowUp')],
  Space:[key(0.1,'Tab'),key(0.2,' '),up(0.25,' ')]})){
  const record=await capture(`trigger-${name}`,events)
  assert(record.data.elements.some(e=>e.key==='actions:menu'),`${name} must open the real menu`)
  const focused=record.data.elements.find(e=>e.focused)?.key
  assert.equal(focused,name==='ArrowUp'?'actions:item:checked':'actions:item:open')
  interaction.keyboard.push({key:name,status:0,opened:true,focus:focused,tree:record.tree,script:record.script})
}
for(const theme of ['light','dark'])for(const [name,events] of Object.entries({open:opening,
  hover:[...opening,{t:0.4,type:'move',key:'actions:item:open'}],focus:[...opening,key(0.4,'End')]})){
  const record=await capture(`${theme}-${name}`,events,theme,'standard',name==='hover'?[0.55]:[1,2,4]),data=record.data
  const menu=data.elements.find(e=>e.key==='actions:menu');assert(menu,'Actual shared menu required')
  const rows=data.elements.filter(e=>e.key?.startsWith('actions:item:'))
  assert.deepEqual(rows.map(e=>e.label),['Open','Disabled','Copy'])
  assert.equal(rows.find(e=>e.focused)?.key,name==='focus'?'actions:item:checked':'actions:item:open')
  records.push({...record,name,data:undefined,geometry:{menu:menu.rect,rows:rows.map(e=>({key:e.key,label:e.label,rect:e.rect,focused:e.focused,checked:e.itemChecked})),
    trigger:data.elements.find(e=>e.key==='actions:trigger')?.rect}})
  if(name==='hover'){
    assert(!data.tooltip,'Immediate hover comparison precedes deferred help')
    const help=await capture(`${theme}-hover-help`,events,theme)
    assert.equal(help.data.tooltip?.text,'Details','Keep the mature native tooltip as separate evidence')
    deferredHelp.push({...help,data:undefined})
  }
}
for(const mode of ['standard','immediate','focus-after']){
  const record=await capture(mode,[...opening,key(0.4,'Enter'),up(0.45,'Enter')],'light',mode)
  const order=record.trace.map(e=>e.event)
  assert.deepEqual(order,mode==='standard'?['open','close','select','restored']:['open','select','close','restored'])
  assert.equal(record.trace.find(e=>e.event==='select').focus,mode==='standard'?'actions:trigger':'actions:item:open')
  // The actual Solid AlertDialog fixture resolves Accept while retaining Cancel's established focus.
  assert.equal(record.trace.at(-1).focus,'dialog-cancel')
  interaction.actions.push({mode,trace:record.trace,tree:record.tree,image:record.image,script:record.script})
}
for(const mode of ['immediate','focus-after']){
  const record=await capture(`${mode}-close`,[...opening,key(0.4,'Enter'),up(0.45,'Enter'),
    {t:0.8,type:'tap',key:'dialog-cancel'}],'light',mode)
  assert.equal(record.trace.at(-1).event,'dialog-close')
  assert(!record.data.elements.some(e=>e.key==='dialog'),'Closed dialog must leave the actual scene')
  assert.equal(record.data.elements.find(e=>e.focused)?.key,undefined,'Source returns to BODY after this immediate dialog closes')
  interaction.dialogClose.push({mode,trace:record.trace,focus:null,tree:record.tree,script:record.script})
}
await writeFile(path.join(out,'native-captures.json'),JSON.stringify({provenance,viewport:[480,360],records,deferredHelp,
  limitations:['Hover pixels compare the initial state before deferred help. Mature Rune help is captured separately; Chromium screenshots omit native title tooltips.',
    'Pixel budgets and complete Source interaction parity require separate qualification.']},null,2)+'\n')
await writeFile(path.join(out,'native-interaction-proof.json'),JSON.stringify(interaction,null,2)+'\n')
console.log(out)
