// OpenCode executes a real permitted edit through an exclusively loopback model.
import assert from 'node:assert/strict'
import {existsSync} from 'node:fs'
import {mkdir, mkdtemp, writeFile, readFile} from 'node:fs/promises'
import path from 'node:path'
import {parseArgs} from 'node:util'
import {setTimeout as delay} from 'node:timers/promises'
import {clientBinary, requireTestSupport, serverBinary} from './fixture-binaries.mjs'
import {journeyBrowser} from './journey-browser.mjs'
import {withJourneyHost,assertPrivateChild,credentialVariable} from './journey-host.mjs'
import {fixtureSystemEnvironment} from './private-profile.mjs'
import {launchFixture} from './fixture-host.mjs'
import {createAttestedRelay,redactSecrets,RELAY_PLACEHOLDER_PASSWORD} from '../../../scripts/native-fixture-http.mjs'

const {values}=parseArgs({options:{opencode:{type:'string'},mode:{type:'string',default:'both'}}})
assert(values.opencode&&path.isAbsolute(values.opencode),'Pass --opencode <absolute executable>; the shared service is forbidden')
assert(process.env.RUNE_SERVER_EXE,'Pass RUNE_SERVER_EXE from this checkout')
assert(['both','windows','web'].includes(values.mode),'Use --mode both, windows, or web')
const modes=values.mode==='both'?['windows','web']:[values.mode]
assert(!modes.includes('windows')||process.platform==='win32','The native journey needs Windows; use --mode web on other hosts')
const root=path.resolve(import.meta.dirname,'../../..')
const web=path.resolve(root,process.env.RUNE_WEB_DIR??'target/rune-web-journey')
const browserExecutable=process.env.CODENOMAD_BROWSER_PATH||undefined
const codenomad=path.basename(path.dirname(root))==='worktrees'?path.resolve(root,'../..'):path.join(root,'.codenomad')
const evidence=path.join(codenomad,'cargo-targets','e2e-journey')
// esbuild's worker and any OS helper inherit only this allowlist.
const jobSuffix=process.platform==='win32'?'.exe':''
const jobExecutable=process.env.CODENOMAD_FIXTURE_JOB_EXE
  || path.resolve(root,process.env.CARGO_TARGET_DIR||'target','debug',`codenomad-fixture-job${jobSuffix}`)
const system=assertPrivateChild(fixtureSystemEnvironment())
const stripped=Object.keys(process.env).filter(key=>!Object.hasOwn(system,key))
for(const key of stripped)delete process.env[key]
const filtered=stripped.filter(credentialVariable).sort()
if(filtered.length)console.error(`Fixture filtered environment variables: ${JSON.stringify(filtered)}`)
// Runner-only executable selection; fixture children receive their explicit private env.
if(process.platform==='win32'||existsSync(jobExecutable))process.env.CODENOMAD_FIXTURE_JOB_EXE=jobExecutable
await mkdir(evidence,{recursive:true})

async function journeyDesktop({origin,rustPid,password,project,profile,env},report){
  const probe='--probe-e2e-journey'
  requireTestSupport(clientBinary,{probe,env:assertPrivateChild(env),cwd:profile,output:profile})
  const state=path.join(profile,'rune-state')
  const session=path.join(profile,'session.txt')
  const rustRelay=await createAttestedRelay(origin,rustPid,{requireClientAttestation:true,substitutePassword:password,isolateSessionCookie:true})
  try{
  for(const phase of ['start','reopen']){
    const child=launchFixture(clientBinary,[probe],{cwd:profile,redact:[password],env:assertPrivateChild({
      ...env,RUNE_BACKEND:`${rustRelay.origin}/`,RUNE_PASSWORD:RELAY_PLACEHOLDER_PASSWORD,RUNE_TEST_FOLDER:project,RUNE_LOCALE:'en',
      RUNE_STATE_DIR:state,RUNE_JOURNEY_OUTPUT:report.output,RUNE_JOURNEY_PHASE:phase,RUNE_JOURNEY_SESSION_FILE:session,
    },{RUNE_PASSWORD:RELAY_PLACEHOLDER_PASSWORD})})
    rustRelay.allowClientPid(child.pid(),child.closed)
    let windowClosed=false,result
    try{
      result=await Promise.race([child.closed,delay(220000,124,{ref:false})])
    }finally{
      await child.stop()
      await writeFile(path.join(report.output,`windows-${phase}.log`),redactSecrets(child.output(),[password]))
    }
    for(const line of redactSecrets(child.stdout(),[password]).split(/\r?\n/)){
      let event
      try{event=JSON.parse(line)}catch{continue}
      if(event.step)report.steps.push(event)
      if(event.nativeWindowClosed)windowClosed=true
    }
    assert.equal(result,0,`Native journey ${phase} failed (${result}); see windows-${phase}.log`)
    if(phase==='start'){
      assert(windowClosed,'The hidden Windows close callback did not run')
      report.nativeWindowClosed=true
    }
  }
  }finally{await rustRelay.close().catch(()=>{})}
  report.sessionID=await readFile(session,'utf8')
  assert.match(report.sessionID,/^ses_[\w-]+$/)
}

const reports=[]
for(const mode of modes){
  const report={mode,ok:false,steps:[],output:await mkdtemp(path.join(evidence,`journey-${mode}-`))}
  report.stage='private-host'
  try{
    await withJourneyHost({cli:values.opencode,rust:serverBinary,web,mode},report,host=>{
      report.stage=mode==='windows'?'native-runtime':'browser-launch'
      return mode==='windows'?journeyDesktop(host,report):journeyBrowser(host,web,report,browserExecutable)
    })
    report.ok=true
    delete report.stage
  }catch(error){
    report.error=error.message
    report.failedStep=report.steps.findLast(row=>!row.ok)?.name??report.stage
  }
  await writeFile(path.join(report.output,'journey-report.json'),JSON.stringify(report,null,2)+'\n')
  reports.push(report)
  console.log(JSON.stringify(report))
}
if(reports.some(report=>!report.ok))process.exitCode=1
