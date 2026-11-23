// OpenCode executes a real permitted edit through an exclusively loopback model.
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {writeFile, readFile} from 'node:fs/promises'
import path from 'node:path'
import {parseArgs} from 'node:util'
import {setTimeout as delay} from 'node:timers/promises'
import {stopFixtureChild} from '../../../scripts/native-fixture-guards.mjs'
import {clientBinary, requireTestSupport, serverBinary} from './fixture-binaries.mjs'
import {journeyBrowser} from './journey-browser.mjs'
import {withJourneyHost} from './journey-host.mjs'

const {values}=parseArgs({options:{opencode:{type:'string'},mode:{type:'string',default:'both'}}})
assert(values.opencode&&path.isAbsolute(values.opencode),'Pass --opencode <absolute executable>; the shared service is forbidden')
assert(process.env.RUNE_SERVER_EXE,'Pass RUNE_SERVER_EXE from this checkout')
assert(['both','windows','web'].includes(values.mode),'Use --mode both, windows, or web')
const modes=values.mode==='both'?['windows','web']:[values.mode]
assert(!modes.includes('windows')||process.platform==='win32','The native journey needs Windows; use --mode web on other hosts')
const web=path.resolve(import.meta.dirname,'../../..',process.env.RUNE_WEB_DIR??'target/rune-web-journey')

async function journeyDesktop({origin,password,project,profile,env},report){
  requireTestSupport(clientBinary)
  const state=path.join(profile,'rune-state')
  const session=path.join(profile,'session.txt')
  for(const phase of ['start','reopen']){
    const child=spawn(clientBinary,['--probe-e2e-journey'],{cwd:profile,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{
      ...env,RUNE_BACKEND:`${origin}/`,RUNE_PASSWORD:password,RUNE_TEST_FOLDER:project,RUNE_LOCALE:'en',
      RUNE_STATE_DIR:state,RUNE_JOURNEY_OUTPUT:profile,RUNE_JOURNEY_PHASE:phase,RUNE_JOURNEY_SESSION_FILE:session,
    }})
    let output='',diagnostics='',spawnError,windowClosed=false
    const closed=new Promise(resolve=>{child.once('close',resolve);child.once('error',error=>{spawnError=error;resolve(1)})})
    child.stdout.on('data',data=>{output=(output+data).slice(-65536)})
    child.stderr.on('data',data=>{diagnostics=(diagnostics+data).slice(-65536)})
    try{
      const result=await Promise.race([closed,delay(220000,124,{ref:false})])
      await writeFile(path.join(profile,`windows-${phase}.log`),diagnostics.replaceAll(password,'<private>'))
      for(const line of output.split(/\r?\n/)){
        let event
        try{event=JSON.parse(line)}catch{continue}
        if(event.step)report.steps.push(event)
        if(event.nativeWindowClosed)windowClosed=true
      }
      assert.equal(result,0,spawnError?.message??`Native journey ${phase} failed (${result}); see windows-${phase}.log`)
      if(phase==='start'){
        assert(windowClosed,'The hidden Windows close callback did not run')
        report.nativeWindowClosed=true
      }
    }finally{
      if(child.pid&&child.exitCode===null&&child.signalCode===null)await stopFixtureChild(child,closed)
    }
  }
  report.sessionID=await readFile(session,'utf8')
  assert.match(report.sessionID,/^ses_[\w-]+$/)
}

const reports=[]
for(const mode of modes){
  const report={mode,ok:false,steps:[]}
  report.stage='private-host'
  try{
    await withJourneyHost({cli:values.opencode,rust:serverBinary,web,mode},report,host=>{
      report.stage=mode==='windows'?'native-runtime':'browser-launch'
      return mode==='windows'?journeyDesktop(host,report):journeyBrowser(host,web,report)
    })
    report.ok=true
    delete report.stage
  }catch(error){
    report.error=error.message
    report.failedStep=report.steps.findLast(row=>!row.ok)?.name??report.stage
  }
  if(report.profile)await writeFile(path.join(report.profile,'journey-report.json'),JSON.stringify(report,null,2)+'\n')
  reports.push(report)
  console.log(JSON.stringify(report))
}
if(reports.some(report=>!report.ok))process.exitCode=1
