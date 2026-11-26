// Real CodeNomad Rust + synthetic OpenCode; no native window or user profile.
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {spawn,execFile} from 'node:child_process'
import {spawnFixtureChild,stopFixtureChild,stopFixtureHandle,fixtureChildPid} from '../../../scripts/native-fixture-guards.mjs'
import {RELAY_PLACEHOLDER_PASSWORD,createAttestedRelay,createStreamRedactor,stripFixtureServerSecrets,withoutFixtureProxy} from '../../../scripts/native-fixture-http.mjs'
import {promisify} from 'node:util'
import {existsSync,renameSync,writeFileSync} from 'node:fs'
import {lstat,mkdir,readFile,writeFile,rename,unlink,access,realpath} from 'node:fs/promises'
import {createHash,randomUUID} from 'node:crypto'
import path from 'node:path'
import {FixtureStore} from './fixture-store.mjs'
import {seedHistory,historyResponse,historyPreview} from './launcher-history.mjs'
import {responseFor,textStream} from './fixture-response.mjs'
import {privateEnvironment} from './private-profile.mjs'
import {controlsFixture} from './controls-fixture.mjs'
import {pendingOpenFixture} from './pending-open-fixture.mjs'
import {requireTestSupport,clientBinary,serverBinary} from './fixture-binaries.mjs'
import {webLiveFixture} from './web-live-fixture.mjs'
import {seedGitImages} from '../../../scripts/rune/web-git-images.mjs'
import {androidTsServer} from './android-ts-server.mjs'
import {launchWeb} from './launcher-web.mjs'
import {rustOrigin,signInFixture,until} from './fixture-host.mjs'
import {assertWorktreeTestRoot} from '../../../scripts/rune/web-workspace-policy.mjs'
import {claimOwnedWorkerProfile,needsOwnedWindowsWorker,publishWorkerProof} from './launcher-worker-guard.mjs'
const webMoreActions=process.argv.includes('--web-mobile-more-actions')
const webAndroid=process.argv.includes('--web-android'),webMobile=webAndroid||webMoreActions||process.argv.includes('--web-mobile')
const webMobileDrawers=process.argv.includes('--web-mobile-drawers')
const webKeyboard=process.argv.includes('--web-keyboard-viewport')
const webSse7Tabs=process.argv.includes('--web-sse-7tabs')
const mobileSessionSearch=process.argv.includes('--mobile-session-search')
const historyReturnOnly=process.argv.includes('--history-return-only')
assert(!mobileSessionSearch||webMobile&&!webAndroid,'Session search isolation requires the Chromium mobile smoke')
assert(!historyReturnOnly || webMobile&&!webAndroid)
assert(!webMoreActions||!webAndroid&&!historyReturnOnly&&!process.argv.includes('--web-mobile'))
const root=path.resolve(import.meta.dirname,'../../..')
const ownedWorker=process.argv.includes('--owned-mobile-worker')
const workerProfileEnv=process.env.CODENOMAD_LAUNCHER_WORKER_PROFILE
if(ownedWorker)delete process.env.CODENOMAD_LAUNCHER_WORKER_PROFILE
const validatedWorkerProfile=ownedWorker&&workerProfileEnv
  ?await claimOwnedWorkerProfile(workerProfileEnv,(await assertWorktreeTestRoot(root)).testsReal)
  :undefined
if(needsOwnedWindowsWorker(process.argv)||((webMobile||webKeyboard||webMobileDrawers||webSse7Tabs)&&!ownedWorker)){
  const testsReal=(await assertWorktreeTestRoot(root)).testsReal
  const workerProfile=path.join(testsReal,`launcher-${randomUUID()}`)
  await mkdir(workerProfile,{recursive:true})
  const workerEnv={...process.env,CODENOMAD_LAUNCHER_WORKER_PROFILE:workerProfile}
  const workerStartedFile=path.join(workerProfile,'.worker-started')
  const graceMs=webAndroid?150000:25000
  const spawnPosixBridge=()=>{
    const guardsUrl=new URL('../../../scripts/native-fixture-guards.mjs',import.meta.url).href
    const bridgeCode=`
      import {spawnFixtureChild,stopFixtureChild} from ${JSON.stringify(guardsUrl)}
      const workerArgs=JSON.parse(process.env.CODENOMAD_POSIX_WORKER_ARGS)
      const graceMs=Number(process.env.CODENOMAD_POSIX_WORKER_GRACE_MS)
      delete process.env.CODENOMAD_POSIX_WORKER_ARGS
      delete process.env.CODENOMAD_POSIX_WORKER_GRACE_MS
      const child=spawnFixtureChild(process.execPath,workerArgs,{windowsHide:true,stdio:['pipe','inherit','inherit'],env:process.env})
      child.stdin?.on('error',()=>{})
      const closed=new Promise(resolve=>{
        child.once('close',(code,signal)=>resolve({code,signal}))
        child.once('error',error=>resolve({code:null,signal:null,error}))
      })
      let stopping,stopError,stopSettled
      const stopDone=new Promise(resolve=>{stopSettled=resolve})
      const stop=line=>{
        stopping??=(async()=>{
          try{
            try{child.stdin?.end(line)}catch{}
            let t
            try{await Promise.race([closed,new Promise(r=>{t=setTimeout(r,graceMs)})])}
            finally{clearTimeout(t)}
            await stopFixtureChild(child,closed,5500,2000)
          }catch(error){
            stopError=error
            console.error(error.message)
          }finally{
            stopSettled({exited:false})
          }
        })()
      }
      process.on('SIGTERM',()=>stop('shutdown:SIGTERM\\n'))
      process.stdin.resume()
      process.stdin.on('data',chunk=>{
        const text=String(chunk)
        if(text.includes('shutdown:SIGINT'))stop('shutdown:SIGINT\\n')
        else if(text.includes('shutdown'))stop('shutdown:SIGTERM\\n')
      })
      process.stdin.once('end',()=>stop('shutdown:SIGTERM\\n'))
      const outcome=await Promise.race([closed.then(exit=>({exited:true,exit})),stopDone])
      let exit=outcome.exited?outcome.exit:null
      if(outcome.exited){await stopping}
      else{
        let timer
        try{exit=await Promise.race([closed,new Promise(r=>{timer=setTimeout(()=>r(null),500)})])}
        finally{clearTimeout(timer)}
      }
      if(exit?.error){console.error(exit.error?.message??exit.error);process.exit(1)}
      if(!exit||stopError||exit.code===86||exit.signal)process.exit(86)
      process.exit(exit.code??1)
    `
    return spawn(process.execPath,['--input-type=module','-e',bridgeCode],{
      cwd:root,
      detached:true,
      windowsHide:true,
      stdio:['pipe','inherit','inherit'],
      env:{
        ...workerEnv,
        CODENOMAD_POSIX_WORKER_ARGS:JSON.stringify([...process.execArgv,...process.argv.slice(1),'--owned-mobile-worker']),
        CODENOMAD_POSIX_WORKER_GRACE_MS:String(graceMs),
      },
    })
  }
  let worker
  try{
    worker=process.platform==='win32'
      ?spawnFixtureChild(process.execPath,[...process.execArgv,...process.argv.slice(1),'--owned-mobile-worker'],{windowsHide:true,stdio:['pipe','inherit','inherit'],env:workerEnv})
      :spawnPosixBridge()
  }catch(spawnError){
    console.error(spawnError?.message??spawnError)
    const finalResult=publishWorkerProof({workerProfile,exit:{code:null,signal:null,error:spawnError},workerStarted:false})
    process.exit(finalResult)
  }
  worker.stdin?.on('error',()=>{})
  const closed=new Promise(resolve=>{
    worker.once('close',(code,signal)=>resolve({code,signal}))
    worker.once('error',error=>resolve({code:null,signal:null,error}))
  })
  const outerGraceMs=process.platform==='win32'?graceMs:graceMs+15000
  let stopping,stopError,outerSignal,stopSettled,unconfirmedStop=false
  const stopDone=new Promise(resolve=>{stopSettled=resolve})
  const stop=signal=>{
    outerSignal??=signal
    const shutdownLine=signal==='SIGINT'?'shutdown:SIGINT\n':'shutdown:SIGTERM\n'
    stopping??=(process.platform==='win32'
      ?stopFixtureChild(worker,closed,outerGraceMs,2000,{
          close:()=>{try{worker.stdin?.end(shutdownLine)}catch{}},
        })
      :(async()=>{
          try{worker.stdin?.end(shutdownLine)}catch{}
          let t
          let bridgeExited=false
          try{bridgeExited=await Promise.race([closed.then(()=>true),new Promise(r=>{t=setTimeout(()=>r(false),outerGraceMs)})])}
          finally{clearTimeout(t)}
          if(!bridgeExited){
            unconfirmedStop=true
            // Terminate only the bridge handle (never the bridge process group) so the inner fixture supervisor stays alive to detect parent death and clean up descendants.
            await stopFixtureHandle(worker,closed,2000,2000).catch(()=>{})
            throw Error('Owned POSIX bridge did not confirm worker exit before escalation')
          }
        })()
    ).catch(error=>{
      stopError=error
      console.error(error.message)
    }).finally(()=>{stopSettled({exited:false})})
  }
  process.on('SIGINT',stop)
  process.on('SIGTERM',stop)
  const outcome=await Promise.race([
    closed.then(exit=>({exited:true,exit})),
    stopDone,
  ])
  let exit=outcome.exited?outcome.exit:null
  if(outcome.exited){
    await stopping
  }else{
    let timer
    try{
      exit=await Promise.race([closed,new Promise(resolve=>{timer=setTimeout(()=>resolve(null),500)})])
    }finally{clearTimeout(timer)}
  }
  process.off('SIGINT',stop)
  process.off('SIGTERM',stop)
  const finalResult=publishWorkerProof({workerProfile,exit,workerStarted:existsSync(workerStartedFile),unconfirmedStop,stopError,outerSignal})
  process.exit(finalResult)
}
const webMissions=process.argv.includes('--web-missions')
const webGitImages=process.argv.includes('--web-git-images')
const solid=webAndroid&&process.env.RUNE_ANDROID_SOLID_DIR
const compare=webAndroid&&process.env.RUNE_ANDROID_COMPARE
const probeGpu=webAndroid&&process.env.RUNE_ANDROID_GPU_PROBE==='only'
const sampleScroll=webAndroid&&process.env.RUNE_ANDROID_SAMPLE==='scroll'
const useTs=webAndroid&&process.env.RUNE_ANDROID_TS_SERVER==='1'
assert(!useTs||solid&&compare,'The TS restart control runs the same Solid build and conversation')
const sameOriginPairing=process.argv.includes('--same-origin-pairing')
const webTouchHistory=process.argv.includes('--web-touch-history')
const webTimeline=process.argv.includes('--web-timeline')||webTouchHistory
const webSearch=process.argv.includes('--web-history-search')
const webOutline=process.argv.includes('--web-outline-restore')
assert(!sameOriginPairing || webMobile&&!webAndroid,'Same-origin control is only for the Chromium mobile smoke')
const webFileWrap=process.argv.includes('--web-file-wrap')
const webPending=process.argv.includes('--web-pending-open'),webRestore=process.argv.includes('--web-restore')||webPending||webFileWrap||webMobileDrawers||webOutline||webKeyboard,web=process.argv.includes('--web')||webRestore||webMobile||webMissions||webGitImages||webTimeline||webSearch||webSse7Tabs
assert(!webFileWrap||(!webPending&&!webMobile),'File wrap uses the loopback Chromium restoration fixture')
assert(!webMobileDrawers||(!webPending&&!webFileWrap&&!webMobile&&!webOutline&&!webTimeline&&!webSearch&&!webKeyboard&&!process.argv.includes('--web-restore')),'Mobile drawers uses its own loopback Chromium fixture mode')
assert(!webKeyboard||(!webPending&&!webFileWrap&&!webMobile&&!webOutline&&!webTimeline&&!webSearch&&!webMobileDrawers&&!process.argv.includes('--web-restore')),'Keyboard viewport uses its own loopback Chromium fixture mode')
assert(!webSse7Tabs||(!webRestore&&!webMobile&&!webMissions&&!webGitImages&&!webTimeline&&!webSearch&&!process.argv.includes('--web')),'7-tab SSE bench uses its own HTTPS fixture mode')
assert(!webMissions||!webRestore&&!webMobile)
assert(!webGitImages||!webRestore&&!webMobile&&!webMissions)
if(!web)requireTestSupport()
const gitPanel=process.argv.includes('--git-panel'),gitOutput=gitPanel?process.env.RUNE_TEST_GIT_OUTPUT:undefined
const placeWorktree=process.argv.includes('--place-worktree'),moves=[]
const placementAmbiguous=process.argv.includes('--placement-ambiguity')
const placementBusy=process.argv.includes('--placement-busy')
let activePlacementChecks=0
let failedPlacementActivity=false
assert(!placeWorktree||gitPanel,'Placement uses the isolated Git panel fixture')
assert(!placementAmbiguous||placeWorktree,'Ambiguity requires placement mode')
assert(!placementBusy||placeWorktree&&!placementAmbiguous,'Busy refusal requires normal placement mode')
if(gitOutput)assert(path.isAbsolute(gitOutput),'Git fixture output must be absolute')
const restoreFileDrafts=process.argv.includes('--file-draft-restart')
const draftOutput=restoreFileDrafts?process.env.RUNE_TEST_FILES_OUTPUT:undefined
if(draftOutput)assert(path.isAbsolute(draftOutput),'Files fixture output must be absolute')
const here=path.resolve(import.meta.dirname,'..')
let output=draftOutput??gitOutput??(web?path.join(root,'target/rune-web-tests'):path.join(here,'fixture-profile'))
if(web&&!draftOutput&&!gitOutput){
  output=(await assertWorktreeTestRoot(root)).testsReal
}else if(draftOutput||gitOutput){
  const parent=path.dirname(output)
  const parentReal=await realpath(parent)
  output=path.join(parentReal,path.basename(output))
  const existing=await lstat(output).catch(error=>{if(error.code!=='ENOENT')throw error;return null})
  assert(!existing||(!existing.isSymbolicLink()&&existing.isDirectory()),`Fixture output root must be a real directory: ${output}`)
}
let run=`launcher-${randomUUID()}`
let profile=path.join(output,run)
if(validatedWorkerProfile){
  assert.equal(path.dirname(validatedWorkerProfile),output,`Worker profile must reside under ${output}`)
  run=path.basename(validatedWorkerProfile)
  profile=validatedWorkerProfile
}
if(webSearch){
  await mkdir(output,{recursive:true})
  profile=path.join(await realpath(output),run)
}
const browserOutput=path.join(output,run,'browser')
const project=path.join(profile,'projects','synthetic');await mkdir(project,{recursive:true})
if(webFileWrap)await writeFile(path.join(project,'wrap.txt'),'Workspace word wrap fixture: '+'wide source '.repeat(24)+'\n')
if(webMobileDrawers)await writeFile(path.join(project,'drawer-probe.txt'),'Mobile drawer fixture file\n')
const forbidden=path.join(profile,'forbidden');if(web)await mkdir(forbidden)
const ui=path.resolve(root,process.env.RUNE_WEB_DIR??'target/rune-web-connected')
const manifest=web?JSON.parse(await readFile(path.join(ui,'bundle-manifest.json'),'utf8')):null
if(web){assert.equal(manifest.generator,'scripts/rune/bundle-web.mjs');assert.equal(manifest.testSupport,false,'Connected qualification requires the default product bundle')}
const gitCount=Number(process.env.RUNE_TEST_GIT_COUNT??0)
const review=path.join(path.dirname(project),'review')
const gitBaseEnv=gitPanel||webGitImages||gitCount||((webMobile&&!webAndroid)||webSearch||webMobileDrawers)?await privateEnvironment(profile):undefined
const gitEnv=gitPanel||webGitImages?gitBaseEnv:undefined
const git=async (...args)=>(await promisify(execFile)('git',['-C',project,...args],{windowsHide:true,env:gitEnv})).stdout
if(webGitImages)await seedGitImages(project,git)
if(gitPanel){
  assert(!gitCount,'Git panel uses real worktrees')
  await git('init','--quiet','-b','main')
  await git('config','user.name','Rune Fixture')
  await git('config','user.email','fixture@example.invalid')
  await writeFile(path.join(project,'git-panel.txt'),'git-panel initial\n')
  await git('add','--','git-panel.txt')
  await git('commit','--quiet','-m','Initial Git panel fixture')
  await git('worktree','add','--quiet','-b','review',review)
  await writeFile(path.join(project,'git-panel.txt'),'git-panel edited\n')
}
if(gitCount)await promisify(execFile)('git',['init','--quiet',project],{windowsHide:true,env:gitBaseEnv})
const linked=(webMobile&&!webAndroid||webSearch||webMobileDrawers)?path.join(path.dirname(project),'linked'):null
if(linked){
  const hooks=path.join(profile,'empty-hooks')
  await mkdir(hooks)
  const git=(...args)=>promisify(execFile)('git',['-c',`core.hooksPath=${hooks}`,'-C',project,...args],{
    windowsHide:true,env:gitBaseEnv,
  })
   await git('init','--quiet',...(webSearch?['-b','history-fixture']:[]))
  await git('-c','user.name=Fixture','-c','user.email=fixture@invalid','commit','--quiet','--allow-empty','-m','synthetic')
   await git('worktree','add','--quiet',...(webSearch?['-b','history-linked']:['--detach']),linked,'HEAD')
}
const records=new Map(),stores=new Map(),streams=new Set(),requests=[]
const stats={created:0,prompts:0,lists:0}
const fixtureModel={id:'fixture',providerID:'fixture',name:'Fixture',limit:{context:100000,output:4096},cost:[],variants:[]}
const fixtureTokens={input:0,output:0,reasoning:0,cache:{read:0,write:0}}
const uncertain=process.argv.includes('--uncertain-create')
const withTools=process.argv.includes('--with-tools')
const controls=process.argv.includes('--controls')
const workspaceClaims=process.argv.includes('--workspace-claims')
const restoreState=process.argv.includes('--restore-state')
const pendingOpen=process.argv.includes('--pending-open')
const documentState=process.argv.includes('--document-state')
const filesState=process.argv.includes('--files-state')||documentState
assert(!gitPanel||(!web&&!controls&&!withTools&&!uncertain&&!workspaceClaims&&!restoreState&&!pendingOpen&&!filesState),'Git panel uses its own qualification mode')
assert(!filesState||(!web&&!controls&&!withTools&&!uncertain&&!workspaceClaims&&!restoreState&&!pendingOpen),'Files state uses its own qualification mode')
if(filesState){await mkdir(path.join(project,'src'));await writeFile(path.join(project,'initial.txt'),'initial');await writeFile(path.join(project,'src/initial.ts'),'initial')}
assert(!workspaceClaims||(!web&&!controls&&!withTools&&!uncertain),'Workspace claims use their own qualification mode')
assert(!restoreState||(!web&&!controls&&!withTools&&!uncertain&&!workspaceClaims),'Restore uses its own qualification mode')
assert(!restoreFileDrafts||restoreState,'File draft restart requires --restore-state')
if(restoreFileDrafts)await writeFile(path.join(project,'draft.txt'),'original')
const gates=new Map(),visibleProof=[],restoreStages=[],restorePrompts=[]
const filesStages=[],filesExpected=['reader-visible','create','rename','delete','collapsed','hidden','tabbed']
if(documentState)filesExpected.push('document-external','document-cancelled','document-race','document-conflict','document-saved')
const documentDraft='Rune saved · été 🦀\nsecond line',documentExternal='External change · 日本語',documentRace='Changed after confirmation'
const readerTexts=['initial','Reader visible · été 🦀\nsecond version','Reader hidden · 日本語\nthird version','Reader resumed · quatrième\nversion after suspension']
let filesChain=Promise.resolve(),filesProof
async function filesStage(ack) {
  assert.equal(ack.stage,filesExpected[filesStages.length]);filesStages.push(ack)
  switch(ack.stage){
    case 'reader-visible': await writeFile(path.join(project,'src/initial.ts'),readerTexts[1]);break
    case 'create': await writeFile(path.join(project,'new.txt'),'created');await writeFile(path.join(project,'src/nested.ts'),'nested');break
    case 'rename': await rename(path.join(project,'new.txt'),path.join(project,'renamed.txt'));break
    case 'delete': await unlink(path.join(project,'renamed.txt'));await unlink(path.join(project,'src/nested.ts'));break
    case 'collapsed': await writeFile(path.join(project,'src/collapsed.ts'),'collapsed');break
    case 'hidden': await writeFile(path.join(project,'hidden.txt'),'hidden');await writeFile(path.join(project,'src/initial.ts'),readerTexts[2]);break
    case 'tabbed': await writeFile(path.join(project,'tabbed.txt'),'tabbed');await writeFile(path.join(project,'src/initial.ts'),readerTexts[3]);break
    case 'document-external': await writeFile(path.join(project,'src/initial.ts'),documentExternal);break
    case 'document-cancelled': assert.equal(await readFile(path.join(project,'src/initial.ts'),'utf8'),documentExternal);break
    case 'document-race': await writeFile(path.join(project,'src/initial.ts'),documentRace);break
    case 'document-conflict': assert.equal(await readFile(path.join(project,'src/initial.ts'),'utf8'),documentRace);break
    case 'document-saved': assert.equal(await readFile(path.join(project,'src/initial.ts'),'utf8'),documentDraft);break
  }
  client.stdin.write(`${JSON.stringify({stage:ack.stage})}\n`)
}
let clientLog='',clientLines=''
let removeReview, reviewRemoved=false, allowReviewRemoval
const readerClosedBeforeRemoval=new Promise(resolve=>{allowReviewRemoval=resolve})
function visibleGate(turn,replyID) {
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{gates.delete(turn);reject(Error(`Missing visible streaming ACK for turn ${turn}`))},10000)
    gates.set(turn,{replyID,resolve:()=>{clearTimeout(timer);gates.delete(turn);resolve()},reject:()=>{clearTimeout(timer);gates.delete(turn);reject(Error('Launcher probe ended before visible streaming ACK'))}})
  })
}
function clientOutput(chunk) {
  clientLog=(clientLog+chunk).slice(-262144);process.stdout.write(chunk)
  clientLines+=chunk
  if(clientLines.length>65536){for(const gate of gates.values())gate.reject();clientLines='';return}
  for(let at;(at=clientLines.indexOf('\n'))>=0;){
    const line=clientLines.slice(0,at);clientLines=clientLines.slice(at+1)
    let ack;try{ack=JSON.parse(line)}catch{continue}
    if(gitPanel&&ack.type==='files-evacuation'){
      removeReview=(async()=>{
        const inventory=await http.get(`/api/workspaces/${encodeURIComponent(ack.workspace)}/worktrees`)
        assert(inventory.ok(),await inventory.text())
        const checkout=(await inventory.json()).worktrees.find(row=>path.resolve(row.directory)===review)
        assert(checkout&&checkout.slug!=='root')
        const response=await http.delete(`/api/workspaces/${encodeURIComponent(ack.workspace)}/worktrees/${encodeURIComponent(checkout.slug)}`)
        assert.equal(response.status(),204,await response.text())
        client.stdin.write('removed\n')
      })()
      removeReview.catch(error=>{console.error(error);client.kill()});continue
    }
    if(gitPanel&&ack.type==='files-reader-closed'){allowReviewRemoval();continue}
    if(filesState&&ack.type==='files-state-stage'){filesChain=filesChain.then(()=>filesStage(ack));filesChain.catch(error=>{console.error(error);client.kill()});continue}
    if(filesState&&ack.type==='files-state-proof'){filesProof=ack;continue}
    if(restoreState&&ack.type==='window-restore-stage'){restoreStages.push(ack);continue}
    if(restoreState&&ack.type==='window-restore-stream-visible'){visibleProof.push(ack);continue}
    if(controls&&ack.type==='controls-stopped'){control.onStopped();continue}
    if(ack.type!=='launcher-stream-visible')continue
    const gate=gates.get(ack.turn)
    if(!gate||ack.assistantMessageID!==gate.replyID||ack.phase!=='Streaming'||ack.afterTool!==withTools){for(const item of gates.values())item.reject();continue}
    visibleProof.push(ack);gate.resolve()
  }
}
function add(id,title,directory=project) {
  const row={id,title,projectID:linked||gitPanel?'fixture_project':'global',location:{directory},permissions:[{action:'*',resource:'*',effect:'deny'}],time:{created:1,busy:0,idle:1}}
  if(compare)Object.assign(row,{tokens:fixtureTokens,cost:0,agent:'build',model:{id:'fixture',providerID:'fixture'}})
  records.set(id,row)
  stores.set(id,new FixtureStore(0,compare?{agent:row.agent,model:row.model}:undefined))
  return row
}
add('ses_existing','Existing history')
if(webKeyboard)for(let i=0;i<36;i++)stores.get('ses_existing').append('assistant',`Keyboard passage ${i} — enough prose to wrap across narrow portrait viewports.`)
add('ses_another','Another session',webSearch?linked:gitPanel&&!placeWorktree?review:project)
if(webKeyboard)for(let i=0;i<36;i++)stores.get('ses_another').append('assistant',`Question passage ${i} — enough prose to wrap across narrow portrait viewports.`)
if(webSse7Tabs){
  for(let i=1;i<=7;i++){
    add(`ses_tab_${i}`,`Tab ${i} session`)
    stores.get(`ses_tab_${i}`).append('assistant',`Tab ${i} initial history`)
  }
}
seedHistory({stores,webTimeline:webTimeline||webOutline,webMobile,webAndroid,webSearch})
if(gitPanel)for(let i=0;i<50;i++)stores.get('ses_another').append('assistant',`Reading position ${i}\n\nA second paragraph in the fixture.`)
if(placeWorktree){
  add('ses_child','Child session').parentID='ses_existing'
  for(const row of records.values())row.projectID='fixture_project'
  for(let i=0;i<32;i++)stores.get('ses_existing').append('assistant',`Placement history ${i}`)
}
if(linked&&!webSearch){
  add('ses_linked','Linked checkout session',linked)
  add('ses_linked_next','Linked checkout next page',linked)
  stores.get('ses_linked_next').append('assistant','Linked checkout answer')
}
const mobile=webMobile?webLiveFixture({stores,project,streams,compare}):null
let keyboardPermissionSettled=false,keyboardFormSettled=false
if(withTools)stores.get('ses_existing').rows[1].content.push({type:'tool',id:'historical-read',name:'read',state:{status:'completed',input:{file:'synthetic.rs'},content:[{type:'text',text:'fn historical() {}'}]}})
const control=controls?controlsFixture({records,stores,streams,project,stats}):null
const backendPassword=randomUUID(),nativePassword=randomUUID()
const upstream=createServer(async(req,res)=>{
  try {
    const url=new URL(req.url,'http://127.0.0.1');requests.push(`${req.method} ${url.pathname}`)
    if(filesState||gitPanel)assert(!(url.pathname==='/api/session'&&req.method==='POST')&&!url.pathname.endsWith('/prompt'),'Read-only native session fixture')
    assert.equal(req.headers.authorization,`Basic ${Buffer.from(`opencode:${nativePassword}`).toString('base64')}`)
    let raw='';for await(const chunk of req){raw+=chunk;assert(raw.length<262144)}
    const json=data=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(data))}
    if(useTs&&url.pathname==='/api/info')return json({version:'2.3.2',pid:process.pid})
    if(web){
      assert(!(url.pathname.endsWith('/interrupt')||url.pathname.endsWith('/prompt')&&!webAndroid&&!webMoreActions)&&
        !(url.pathname==='/api/session'&&req.method==='POST'),'Web fixture admits prompts only in the Android and mobile menu scenes')
      if(url.pathname==='/api/config')return json([{type:'directory',path:project}])
      if(url.pathname==='/api/model')return json({location:{directory:url.searchParams.get('location[directory]')??project},data:compare?[fixtureModel]:webKeyboard?[{...fixtureModel,enabled:true}]:[]})
      if(url.pathname==='/api/command'&&webSearch)return json({location:{directory:project},data:[]})
      if(webKeyboard){
        const keyboardPermission={id:'permission-keyboard',sessionID:'ses_existing',action:'edit',
          resources:Array.from({length:12},(_,i)=>`/synthetic/keyboard-${i}.rs`),message:'Approve synthetic edit'}
        const keyboardForm={id:'form-keyboard',sessionID:'ses_another',title:'Synthetic keyboard question',
          fields:Array.from({length:8},(_,i)=>({key:`q${i}`,type:'string',title:`Question field ${i}`}))}
        if(req.method==='GET'&&url.pathname==='/api/session/ses_existing/permission')return json({data:keyboardPermissionSettled?[]:[keyboardPermission]})
        if(req.method==='GET'&&url.pathname==='/api/session/ses_existing/permission/permission-keyboard'){
          if(keyboardPermissionSettled){res.statusCode=404;return json({_tag:'PermissionNotFoundError',requestID:'permission-keyboard',message:'Permission is no longer pending for this session'})}
          return json({data:keyboardPermission})
        }
        if(req.method==='POST'&&url.pathname==='/api/session/ses_existing/permission/permission-keyboard/reply'){keyboardPermissionSettled=true;return json({data:{}})}
        if(req.method==='GET'&&url.pathname==='/api/session/ses_another/form')return json({data:keyboardFormSettled?[]:[keyboardForm]})
        if(req.method==='GET'&&url.pathname==='/api/session/ses_another/form/form-keyboard'){
          if(keyboardFormSettled){res.statusCode=404;return json({_tag:'FormNotFoundError',id:'form-keyboard',message:'Question is no longer pending for this session'})}
          return json({data:{...keyboardForm,state:{status:'pending'}}})
        }
        if(req.method==='DELETE'&&url.pathname==='/api/session/ses_another/form/form-keyboard'){keyboardFormSettled=true;return json({data:{}})}
      }
      if(/^\/api\/session\/[^/]+\/(permission|form)$/.test(url.pathname))return json({data:[]})
    }
    if(control&&await control.route(req,url,raw,json,res))return
    if(url.pathname==='/api/event') {
      if(mobile?.held){res.statusCode=503;return json({})}
      res.writeHead(200,{'content-type':'text/event-stream'});res.write(`data: ${JSON.stringify({id:randomUUID(),type:'server.connected',created:Date.now(),data:{}})}\n\n`)
      // Match OpenCode's idle heartbeat; only the explicit outage stops this fixture's stream.
      const heartbeat=setInterval(()=>res.write(': heartbeat\n\n'),15000).unref()
      streams.add(res)
      res.once('close',()=>{clearInterval(heartbeat);streams.delete(res)})
      return
    }
    if((webMobile||compare||webMobileDrawers||webSse7Tabs)&&req.method==='GET'&&url.pathname==='/api/command')return json({data:[]})
    if(compare){
      if(url.pathname==='/api/session/active')return json({data:{}})
      if(url.pathname==='/api/project')return json([])
      if(url.pathname==='/api/provider')return json({data:[{id:'fixture',name:'Fixture'}]})
      if(url.pathname==='/api/model/default')return json({data:fixtureModel})
      if(url.pathname==='/api/agent')return json({data:[{id:'build',name:'Build',mode:'primary'},{id:'plan',name:'Plan',mode:'primary'}]})
      if(url.pathname==='/api/mcp')return json({location:{directory:project},data:[]})
      if(/^\/api\/experimental\/session\/ses_existing\/instructions\/entries\/[a-z0-9._-]+$/i.test(url.pathname)&&
        ['PUT','DELETE'].includes(req.method)){res.statusCode=204;res.end();return}
      if(url.pathname==='/api/rpc/codenomad.pending-requests/snapshot'){
        assert.deepEqual(JSON.parse(raw).input.directories,[project])
        return json({output:{originDirectory:project,data:[{directory:project,status:'complete',
          locations:[{location:{directory:project},permissions:[],forms:[]}]}]}})
      }
    }
    if(url.pathname==='/api/location'){
      if(gitPanel){
        const directory=url.searchParams.get('location[directory]')??project
        assert([project,review].some(owned=>path.resolve(directory)===owned))
        return json({directory,project:{id:'fixture_project',canonical:project,directory}})
      }
      const directory=url.searchParams.get('location[directory]')??project
      return json(gitCount||linked||webSearch||webGitImages?{directory,project:{id:'fixture_project',canonical:project,directory}}:
        compare?{directory:project,project:{id:'global',canonical:project,directory:project}}:{data:{directory:project}})
    }
    if(linked&&url.pathname==='/api/worktree')return json([{directory:project},{directory:linked}])
    if(webGitImages&&url.pathname==='/api/worktree')return json([{directory:project}])
    if((linked||webGitImages)&&url.pathname==='/api/worktree/refresh'){res.writeHead(204);res.end();return}
    if(webSearch&&url.pathname==='/api/worktree')return json([{directory:project}])
    if(webSearch&&url.pathname==='/api/worktree/refresh')return json({})
    if(gitPanel&&url.pathname==='/api/worktree'&&req.method==='DELETE'){
      const body=JSON.parse(raw);assert.deepEqual(body,{projectID:'fixture_project',directory:review,force:false})
      // Hold physical removal (and its inventory announcement) until Rune acknowledges the move.
      await readerClosedBeforeRemoval
      await git('worktree','remove',review)
      reviewRemoved=true
      return json({})
    }
    if(gitPanel&&url.pathname==='/api/worktree')return json([{directory:project},...(!reviewRemoved?[{directory:review}]:[])])
    if(gitPanel&&url.pathname==='/api/worktree/refresh'&&req.method==='POST')return json({})
    if(gitPanel&&url.pathname==='/api/debug/location')return json([{directory:project},{directory:review}])
    if(gitPanel&&url.pathname==='/api/project')return json([{id:'fixture_project'}])
    if(gitPanel&&/^\/api\/experimental\/session\/[^/]+\/terminal$/.test(url.pathname))return json({data:[]})
    if(gitPanel&&['/api/pty','/api/shell'].includes(url.pathname))return json({data:[]})
    if(gitPanel&&url.pathname==='/api/session/active'){
      if(placementAmbiguous&&moves.length>=3&&!failedPlacementActivity){
        failedPlacementActivity=true
        res.statusCode=503
        return json({error:'Synthetic activity outage'})
      }
      return json({data:placementBusy&&activePlacementChecks++===0?{ses_child:{}}:{}})
    }
    if(gitCount&&url.pathname==='/api/worktree')return json(Array.from({length:gitCount},(_,i)=>({directory:i?path.join(profile,`absent-checkout-${i}`):project})))
    if(url.pathname==='/api/session'&&req.method==='GET') {
      stats.lists++
      const cursor=url.searchParams.get('cursor')
      if(gitPanel&&url.searchParams.get('project')==='fixture_project'){
        assert.equal(url.searchParams.get('directory'),null)
        const order=url.searchParams.get('order')
        if(order==='asc')assert.equal(url.searchParams.get('limit'),'100')
        else assert.equal(order,'desc')
        return json({data:[...records.values()],cursor:{}})
      }
      const directory=cursor?JSON.parse(Buffer.from(cursor,'base64url')).directory:url.searchParams.get('directory')
      assert(directory===project||linked&&directory===linked||gitPanel&&directory===review,'An ordinary page uses its own checkout')
      let rows=[...records.values()].filter(row=>row.location.directory===directory)
      let next
      if(!cursor){
        assert.equal(url.searchParams.get('limit'),'200')
        const search=url.searchParams.get('search')
        if((webMobile||webMobileDrawers)&&search!==null)return json({data:rows.filter(row=>row.title.toLowerCase().includes(search.toLowerCase())),cursor:{}})
        if(webSse7Tabs)return json({data:rows,cursor:{}})
        if(rows.length>1)next=Buffer.from(JSON.stringify({directory,anchor:{id:rows[0].id,time:1,direction:'next'}})).toString('base64url')
        rows=rows.slice(0,1)
      }else rows=rows.slice(1)
      return json({data:rows,cursor:next?{next}:{}})
    }
    if(url.pathname==='/api/session'&&req.method==='POST') {
      const body=JSON.parse(raw);assert.equal(body.location.directory,project)
      const created=add(`ses_created_${++stats.created}`,body.title)
      if(uncertain&&stats.created===1){res.statusCode=500;return json({error:'simulated response lost after creation'})}
      return json({data:created})
    }
    if(url.pathname==='/api/plugin')return json({location:{directory:url.searchParams.get('location[directory]')??project},data:[{id:'codenomad-session-pruning',state:{status:'active'}}]})
    const history=historyResponse(url.pathname,raw,{stores,records,project,linked,directory:url.searchParams.get('location[directory]'),webSearch,webTouchHistory,webOutline,compare})
    if(history)return json(history)
    if(url.pathname==='/api/rpc/codenomad.missions/scheduleCarrierRead')return json({output:{owned:false}})
    if(placeWorktree&&url.pathname==='/api/model')return json({data:[]})
    const match=url.pathname.match(/^\/api\/session\/([^/]+)(?:\/(.*))?$/)
    if(match){
      const [,id,action]=match,record=records.get(id),store=stores.get(id);assert(record,'known fixture session')
      if(!action)return json({data:record})
      if(webSearch&&action.startsWith('message/'))return json(historyPreview(store,action))
      if(action==='message'){
        const ascending=url.searchParams.get('order')==='asc'
        const limit=Number(url.searchParams.get('limit'))
        const data=store.rows.slice(-limit)
        return json({data:compare&&!ascending?data.reverse():data,cursor:ascending?{next:'future-read-anchor'}:{}})
      }
      if(placeWorktree&&['permission','form'].includes(action))return json({data:[]})
      if(placeWorktree&&action==='move'){
        assert.equal(req.method,'POST')
        assert(['ses_existing','ses_child'].includes(id))
        const directory=JSON.parse(raw).directory
        moves.push(id)
        if(placementAmbiguous&&(id==='ses_child'||directory===project)){
          // Native has answered; verification finds the child and rollback did not move.
          return json({data:record})
        }
        assert.equal(directory,review)
        const previous=record.location
        record.location={directory:review}
        const event={id:randomUUID(),type:'session.moved',created:Date.now(),location:previous,data:{sessionID:id,location:record.location}}
        for(const stream of streams)stream.write(`data: ${JSON.stringify(event)}\n\n`)
        return json({data:record})
      }
      if(action==='environment'){res.statusCode=204;res.end();return}
      if(gitPanel&&id==='ses_another'&&action==='move'){
        assert.equal(req.method,'POST');assert.equal(record.location.directory,review)
        assert.deepEqual(JSON.parse(raw),{directory:project})
        const previous=record.location
        record.location={directory:project}
        const event={id:randomUUID(),type:'session.moved',created:Date.now(),location:previous,data:{sessionID:id,location:record.location}}
        for(const stream of streams)stream.write(`data: ${JSON.stringify(event)}\n\n`)
        return json({data:record})
      }
      if(compare&&action==='inbox')return json({data:[]})
      if(compare&&['agent','model'].includes(action)&&req.method==='POST'){res.statusCode=204;res.end();return}
      if(action==='prompt'){
        if(webMoreActions){
          const body=JSON.parse(raw)
          assert.equal(id,'ses_existing')
          assert.equal(++stats.prompts,1)
          assert.equal(body.delivery,'queue')
          assert.equal(body.resume,false)
          assert.equal(body.files?.[0]?.name,'mobile-menu.txt')
          return json({data:{id:'inbox-mobile-menu'}})
        }
        if(webAndroid){
          assert.equal(++stats.prompts,1)
          mobile.androidTurn(record,JSON.parse(raw))
          return json({data:{id:JSON.parse(raw).id??'inbox-android'}})
        }
        const turn=++stats.prompts;assert(id.startsWith('ses_created_'),'send belongs to selected created session')
        const body=JSON.parse(raw),reply=store.append('assistant','',false)
        if(restoreState){assert.equal(id,turn===1?'ses_created_2':'ses_created_1');assert.equal(body.text,turn===1?'Bêta · 日本語 🦀\nsecond brouillon':'Alpha · été 🦀\npremier brouillon');restorePrompts.push({sessionID:id,turn,utf16Length:body.text.length})}
        // Authoritative user precedes assistant.
        store.rows.pop();store.append('user',body.text);reply.id=`reply-${id}-${turn}`;store.rows.push(reply)
        const emit=(type,data)=>{for(const stream of streams)stream.write(`data: ${JSON.stringify({id:randomUUID(),type,created:Date.now(),location:{directory:project},data:{sessionID:id,...data}})}\n\n`)}
        record.time.busy=Date.now();emit('session.step.started',{assistantMessageID:reply.id,agent:'fixture',model:{providerID:'fixture',id:'fixture'}})
        json({data:{id:`inbox-${turn}`}})
        let tool
        if(withTools){
          const preface=textStream(reply,emit);preface.append(`Preparing turn ${turn}`);preface.close()
          tool={type:'tool',id:`tool-${turn}`,name:'bash',state:{status:'streaming'}};reply.content.push(tool)
          emit('session.tool.input.started',{assistantMessageID:reply.id,id:tool.id,name:tool.name})
          emit('session.tool.input.delta',{assistantMessageID:reply.id,id:tool.id,delta:'{"command":'})
          emit('session.tool.input.delta',{assistantMessageID:reply.id,id:tool.id,delta:'"fixture"}'})
          await new Promise(r=>setTimeout(r,350))
          tool.state={status:'running',input:{command:'fixture'}}
          emit('session.tool.called',{assistantMessageID:reply.id,id:tool.id,input:tool.state.input,executed:true})
          // These snapshots exist only in SSE, never in the HTTP history fixture.
          for(const output of ['\x1b[31',`\x1b[31mLive output ${turn}`]){
            emit('session.tool.progress',{assistantMessageID:reply.id,id:tool.id,metadata:{output}})
            await new Promise(r=>setTimeout(r,350))
          }
          tool.state={...tool.state,status:'completed',content:[{type:'text',text:`Synthetic output ${turn}`}]}
          emit('session.tool.success',{assistantMessageID:reply.id,id:tool.id,content:tool.state.content,executed:true})
        }
        const characters=Array.from(responseFor(turn,body.text)),size=withTools?3:1
        const text=textStream(reply,emit,withTools?1:0)
        for(let i=0;i<characters.length;i+=size){
          const gate=!restoreState&&i<7&&i+size>=7?visibleGate(turn,reply.id):null
          text.append(characters.slice(i,i+size).join(''))
          if(gate)await gate
          await new Promise(r=>setTimeout(r,15))
        }
        text.close()
        reply.time.completed=Date.now();record.time.idle=Date.now();emit('session.execution.succeeded',{});return
      }
    }
    res.statusCode=404;json({_tag:'RpcError',type:'rpc.method_not_found',message:'Unsupported fixture route'})
  }catch(error){console.error(error);if(!res.writableEnded){res.statusCode=500;res.end('{}')}}
})
await new Promise(r=>upstream.listen(0,'127.0.0.1',r))
const env=await privateEnvironment(profile)
if(gitPanel)env.CODENOMAD_PROFILE='trial-git-panel'
Object.assign(env,{CNRS_SERVER_PASSWORD:backendPassword,CNRS_FIXTURE_URL:`http://127.0.0.1:${upstream.address().port}/`,CNRS_FIXTURE_PASSWORD:nativePassword,CNRS_FIXTURE_STDIN_STOP:'1',GIT_CEILING_DIRECTORIES:profile,CODENOMAD_REMOTE_CONTROL:'disabled'})
if(web)env.CNRS_FIXTURE_UI_DIR=solid||ui
if(webMobile||webSse7Tabs)Object.assign(env,{CODENOMAD_REMOTE_CONTROL:'',CNRS_HTTPS_BIND:'127.0.0.1:0',CNRS_HTTPS_NAME:'127.0.0.1',CNRS_FIXTURE_INGRESS:'1'})
const ts=useTs?await androidTsServer({root,profile,project,ui:solid,env}):null
let host,server,log='',client,clientRelay,androidCleanup,result=1,http,expired=false
const webState={diagnostic:''}
function launchOwnedServer(binary,args,{cwd,env:childEnv,shutdown,graceMs=3000,redact=[]}){
  const group=process.platform!=='win32'
  const child=spawnFixtureChild(binary,args,{cwd,env:withoutFixtureProxy(childEnv),detached:group,graceMs,windowsHide:true,stdio:[shutdown?'pipe':'ignore','pipe','pipe']})
  const startedBy=new Date()
  let output='',stdout='',spawnError,stopping
  const outRedactor=createStreamRedactor(redact)
  const errRedactor=createStreamRedactor(redact)
  const appendOut=chunk=>{if(chunk){stdout=(stdout+chunk).slice(-1048576);output=(output+chunk).slice(-1048576)}}
  const appendErr=chunk=>{if(chunk){output=(output+chunk).slice(-1048576)}}
  const closed=new Promise(resolve=>{
    child.once('close',code=>{
      appendOut(outRedactor.flush())
      appendErr(errRedactor.flush())
      resolve(code)
    })
    child.once('error',cause=>{spawnError=cause;resolve(1)})
  })
  child.stdout.on('data',data=>{appendOut(outRedactor.push(data))})
  child.stderr.on('data',data=>{appendErr(errRedactor.push(data))})
  child.stdin?.on('error',()=>{})
  const currentStdout=()=>stdout+outRedactor.peek()
  const currentOutput=()=>output+outRedactor.peek()+errRedactor.peek()
  return {
    child,
    pid:()=>fixtureChildPid(child),
    closed,
    output:currentOutput,
    stdout:currentStdout,
    ready:(match,ms)=>until(()=>{
      if(spawnError)throw spawnError
      if(interruptedSignal)throw Error(`Launcher interrupted by ${interruptedSignal}`)
      assert(child.exitCode===null&&child.signalCode===null,`Fixture child exited: ${currentOutput().slice(-2000)}`)
      return match(currentStdout())
    },'owned listener',ms),
    stop(close){
      stopping??=(async()=>{
        if(child.pid)await stopFixtureChild(child,closed,graceMs,2000,{
          group,startedBy,close:close??(shutdown?()=>child.stdin.end(shutdown):undefined),
        })
      })()
      return stopping
    },
  }
}
async function startServer(){
  const blockedCli=path.join(profile,'disabled-opencode-cli.exe')
  host=launchOwnedServer(ts?.command??serverBinary,ts?.args??[path.dirname(project),path.join(profile,'identity.json'),'0',blockedCli],
    {cwd:profile,env,shutdown:ts?'codenomad:shutdown\n':'shutdown\n',graceMs:ts?15000:3000,redact:[backendPassword,nativePassword]})
  server=host.child
  return host.ready(ts?stdout=>ts.ready(stdout):rustOrigin)
}
async function stopServer(){
  if(!host)return
  try{await host.stop()}finally{log=(log+host.output()).slice(-1048576);host=undefined}
}
async function signIn(origin){
  await http?.dispose()
  const serverPid=await host.pid()
  assert(Number.isSafeInteger(serverPid)&&serverPid>0,'Owned fixture server PID unavailable')
  http=await signInFixture(origin,backendPassword,serverPid)
}
async function restartWeb(previous,uiOrigin){
  const {serverId}=await (await previous.get('/api/meta')).json()
  const older=(await (await previous.get('/api/workspaces')).json()).map(row=>row.id)
  assert(older.length>=(ts?1:2))
  mobile.restartHistory()
  await stopServer()
  assert.equal(server.exitCode,0,'The original listener must actually exit')
  if(!ts)env.CNRS_HTTPS_BIND=new URL(uiOrigin).host
  await signIn(await startServer())
  if(!ts)assert(host.stdout().includes(`HTTPS ${uiOrigin}`))
  assert.equal((await (await http.get('/api/meta')).json()).serverId,serverId)
  const opened=await http.post('/api/workspaces',{data:{path:project}})
  assert(opened.ok())
  return {http,value:{older,witness:(await opened.json()).id,serverPid:await host.pid()}}
}
let clientStopPromise,clientStopError,interruptedSignal,abortClientWait
const stopClientOnce=child=>{
  if(!child)return Promise.resolve()
  if(!clientStopPromise){
    const stopped=webState.clientClosed??new Promise(resolve=>child.once('close',resolve))
    clientStopPromise=(async()=>{
      try{
        if(webState.clientUseIpc&&process.platform==='win32'){
          if(webSse7Tabs&&child.exitCode===null&&child.signalCode===null&&child.connected){
            try{child.send({type:'shutdown'},()=>{})}catch{}
            let timer
            try{
              await Promise.race([stopped,new Promise(r=>{timer=setTimeout(r,6000)})])
            }finally{clearTimeout(timer)}
          }
          await stopFixtureHandle(child,stopped,1000,2000)
        }else{
          await stopFixtureChild(child,stopped,8000,2000,{startedBy:webState.clientStartedBy})
        }
      }catch(error){
        clientStopError=String(error?.message??error)
      }
    })()
  }
  return clientStopPromise
}
let finalizePromise,proofPublished=false,publishedResult=1,runError
const teardownErrors=[]
const recordTeardown=async(label,fn)=>{
  try{await fn()}catch(error){teardownErrors.push(`${label}: ${error?.message??error}`)}
}
let pairingStopPromise,pairingStopError
const stopPairingOnce=()=>{
  if(pairingStopPromise)return pairingStopPromise
  const helper=webState.pairingChild
  if(!helper)return Promise.resolve()
  const stopped=webState.pairingClosed??new Promise(resolve=>helper.once('close',resolve))
  const resolveStop=webState.resolvePairingStop
  pairingStopPromise=stopFixtureChild(helper,stopped,5000,2000,{startedBy:webState.pairingStartedBy})
    .catch(error=>{pairingStopError=String(error?.message??error)})
    .finally(()=>{resolveStop?.()})
  return pairingStopPromise
}
function finalize(){
  return finalizePromise??=(async()=>{
    try{control?.close()}catch(error){teardownErrors.push(`control close: ${error?.message??error}`)}
    for(const gate of gates.values())gate.reject()
    await stopPairingOnce()
    if(pairingStopError)teardownErrors.push(`pairing stop: ${pairingStopError}`)
    let leaseOpenFailed=false
    if(webState.deviceLeaseOpen){
      try{await webState.deviceLeaseOpen}catch{leaseOpenFailed=true}
    }
    client??=webState.client
    if(client&&client.exitCode===null&&client.signalCode===null){
      await stopClientOnce(client)
    }
    const activeLease=webState.deviceLease??(!leaseOpenFailed?webState.pendingDeviceLease:undefined)
    if(activeLease){
      await stopClientOnce(client)
      await recordTeardown('android device lease',async()=>{androidCleanup=await activeLease.close()})
    }else if(webState.androidRelay){
      await recordTeardown('android relay',async()=>{
        try{await webState.androidRelay.close()}catch(error){
          androidCleanup=[`relay close: ${error?.message??error}`]
          throw error
        }
      })
    }
    if(webState.androidRelayCloseError){
      androidCleanup=[...(androidCleanup??[]),webState.androidRelayCloseError]
      teardownErrors.push(`android relay rollback: ${webState.androidRelayCloseError}`)
    }
    if(webState.mobileAction)await recordTeardown('mobile action',()=>webState.mobileAction)
    if(clientRelay)await recordTeardown('client relay',()=>clientRelay.close())
    if(http)await recordTeardown('http dispose',()=>http.dispose())
    await recordTeardown('server stop',()=>stopServer())
    for(const stream of streams)stream.destroy()
    try{upstream.closeAllConnections();upstream.close()}catch(error){teardownErrors.push(`upstream close: ${error?.message??error}`)}
    await recordTeardown('server log',()=>writeFile(path.join(profile,ts?'ts.log':'rust.log'),log))
    if(!web)await recordTeardown('client log',()=>writeFile(path.join(profile,'client.log'),clientLog))
    if(web)await recordTeardown('browser log',()=>writeFile(path.join(profile,'browser-run.log'),webState.diagnostic))
    const interrupted=interruptedSignal??null
    const serverFailed=server?.exitCode!==0
    const finalResult=result===0&&!interrupted&&!serverFailed&&!clientStopError&&!androidCleanup?.length&&teardownErrors.length===0?0:1
    const proofPayload=JSON.stringify({result:finalResult,stats,visibleProof,restoreStages,restorePrompts,filesStages,filesProof,requests,static:webState.staticProof,profile,project,forbidden,androidCleanup,expired,interruptedSignal:interrupted,clientStopError,teardownErrors:teardownErrors.length?teardownErrors:undefined,clientExitSignal:client?.signalCode,serverExitCode:server?.exitCode,serverExitSignal:server?.signalCode},null,2)
    if(ownedWorker){
      const workerPart=path.join(profile,'proof.worker.json.part')
      const workerTmp=path.join(profile,'proof.worker.json.tmp')
      writeFileSync(workerPart,proofPayload)
      renameSync(workerPart,workerTmp)
    }else{
      const proofTmp=path.join(profile,'proof.json.tmp')
      const proofFile=path.join(profile,'proof.json')
      writeFileSync(proofTmp,proofPayload)
      renameSync(proofTmp,proofFile)
    }
    proofPublished=true
    publishedResult=finalResult
    process.exitCode=finalResult
    process.off('SIGINT',onLauncherSignal)
    process.off('SIGTERM',onLauncherSignal)
    return finalResult
  })()
}
const onLauncherSignal=signal=>{
  if(proofPublished||interruptedSignal)return
  interruptedSignal=signal
  if(webState.pairingChild)void stopPairingOnce()
  const activeClient=client??webState.client
  if(activeClient)void stopClientOnce(activeClient)
  abortClientWait?.(signal)
}
process.on('SIGINT',onLauncherSignal)
process.on('SIGTERM',onLauncherSignal)
if(ownedWorker){
  process.stdin.resume()
  process.stdin.on('data',chunk=>{
    const text=String(chunk)
    if(text.includes('shutdown:SIGINT'))onLauncherSignal('SIGINT')
    else if(text.includes('shutdown'))onLauncherSignal('SIGTERM')
  })
  process.stdin.once('end',()=>onLauncherSignal('SIGTERM'))
  process.stdin.unref()
}
try{
  const origin=await startServer()
  if(interruptedSignal)throw Error(`Launcher interrupted by ${interruptedSignal}`)
  const serverPid=await host.pid()
  const clientEnv=stripFixtureServerSecrets(env)
  if(web){
    await signIn(origin)
    let liveSseSeq=0
    const emitMultiplexSse=targets=>{
      assert(streams.size>0,'Expected active upstream SSE stream to codenomad-rs')
      assert(Array.isArray(targets)&&targets.length>0&&targets.length<=7,'Expected 1..7 SSE targets')
      const emitted=[]
      for(const {sessionID,text} of targets){
        assert(typeof sessionID==='string'&&/^ses_tab_[1-7]$/.test(sessionID),`Unexpected sessionID: ${sessionID}`)
        assert(typeof text==='string'&&text.length>0&&text.length<=256,'Invalid SSE payload text')
        assert(stores.has(sessionID),`Unknown session store: ${sessionID}`)
        const live={id:`sse-live-${++liveSseSeq}-${randomUUID().slice(0,8)}`,content:[]}
        const emit=(type,data)=>{
          const row={id:randomUUID(),type,created:Date.now(),location:{directory:project},data:{sessionID,...data}}
          for(const stream of streams)stream.write(`data: ${JSON.stringify(row)}\n\n`)
        }
        emit('session.step.started',{assistantMessageID:live.id,agent:'fixture',model:{providerID:'fixture',id:'fixture'}})
        textStream(live,emit).append(text)
        emitted.push({sessionID,assistantMessageID:live.id,text})
      }
      return emitted
    }
    const appendHistory=({sessionID,text})=>{
      assert(typeof sessionID==='string'&&/^ses_tab_[1-7]$/.test(sessionID),`Unexpected sessionID: ${sessionID}`)
      assert(typeof text==='string'&&text.length>0&&text.length<=256,'Invalid history text')
      const store=stores.get(sessionID)
      assert(store,`Unknown session store: ${sessionID}`)
      const row=store.append('assistant',text,true)
      return {sessionID,messageID:row.id,text}
    }
    await launchWeb({root,profile,project,browserOutput,ui,manifest,solid,ts,env:clientEnv,origin,serverPid,runLog:host.stdout(),http,mobile,restart:restartWeb,isInterrupted:()=>Boolean(interruptedSignal),
      webMobile,webAndroid,webMoreActions,historyReturnOnly,menuLive:()=>mobile.menuLive(records.get('ses_existing')),mobileSessionSearch,webMissions,webGitImages,sameOriginPairing,webPending,webFileWrap,webMobileDrawers,webKeyboard,resetKeyboard:()=>{keyboardPermissionSettled=false;keyboardFormSettled=false},webRestore,webTimeline,webTouchHistory,webSearch,webOutline,webSse7Tabs,emitMultiplexSse,appendHistory},webState)
    client=webState.client
    if(interruptedSignal)throw Error(`Launcher interrupted by ${interruptedSignal}`)
  }else if(pendingOpen){
    await pendingOpenFixture({origin,serverPid,backendPassword,profile,project,env,clientBinary});result=0
  }else if(restoreState){
    if(restoreFileDrafts)await signIn(origin)
    clientRelay=await createAttestedRelay(origin,serverPid,{requireClientAttestation:true,substitutePassword:backendPassword,isolateSessionCookie:true})
    for(const stage of ['prepare','resume','verify']){
      if(restoreFileDrafts&&stage==='verify')await writeFile(path.join(project,'draft.txt'),'external')
      clientLines=''
      client=spawnFixtureChild(clientBinary,['--probe-window-restore'],{cwd:profile,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...clientEnv,RUNE_BACKEND:`${clientRelay.origin}/`,RUNE_PASSWORD:RELAY_PLACEHOLDER_PASSWORD,RUNE_TEST_FOLDER:project,RUNE_LOCALE:'fr',RUNE_STATE_DIR:path.join(profile,'rune-state'),RUNE_TEST_RESTORE_STAGE:stage,RUNE_TEST_FILE_DRAFTS:restoreFileDrafts?'1':'0'}})
      const stageClosed=new Promise((resolve,reject)=>{client.on('close',resolve);client.on('error',reject)})
      clientRelay.allowClientPid(fixtureChildPid(client),stageClosed)
      client.stdout.on('data',clientOutput);client.stderr.on('data',d=>{clientLog=(clientLog+d).slice(-262144);process.stderr.write(d)})
      const timer=setTimeout(()=>client.kill(),120000)
      try{result=await stageClosed}finally{clearTimeout(timer)}
      assert.equal(result,0,`Restore stage ${stage}`)
      assert.equal(restoreStages.at(-1)?.stage,stage,'Each process publishes its stage proof')
      if(restoreFileDrafts){
        assert.equal(restoreStages.at(-1)?.fileDrafts,true)
        assert.equal(restoreStages.at(-1)?.nativeWindow,process.platform==='win32')
        assert.equal(await readFile(path.join(project,'draft.txt'),'utf8'),stage==='verify'?'external':'original')
        assert.deepEqual(await (await http.get('/api/workspaces')).json(),[])
      }
      assert.equal(stats.created,2,'Restore must not create native sessions');assert.equal(stats.prompts,stage==='prepare'?0:2,'Only explicit resumed sends submit prompts')
    }
  }else {
    if(gitPanel)await signIn(origin)
    clientRelay=await createAttestedRelay(origin,serverPid,{requireClientAttestation:true,substitutePassword:backendPassword,isolateSessionCookie:true})
    const args=gitPanel?'--probe-git-panel':filesState?'--probe-files-state':workspaceClaims?'--probe-workspace-claims':controls?'--probe-controls':'--probe-launcher'
    client=spawnFixtureChild(clientBinary,[args],{cwd:profile,windowsHide:true,stdio:[filesState||gitPanel?'pipe':'ignore','pipe','pipe'],env:{...clientEnv,RUNE_BACKEND:`${clientRelay.origin}/`,RUNE_PASSWORD:RELAY_PLACEHOLDER_PASSWORD,RUNE_TEST_FOLDER:project,RUNE_LOCALE:'fr',...(filesState||gitPanel?{RUNE_STATE_DIR:path.join(profile,'rune-state'),RUNE_TEST_DOCUMENT_STATE:documentState?'1':'0'}:{}),...(uncertain?{RUNE_TEST_CREATE_UNCERTAIN:'1'}:{}),...(withTools?{RUNE_TEST_TOOLS:'1'}:{}),...(placeWorktree?{RUNE_TEST_PLACE_WORKTREE:placementAmbiguous?'ambiguous':placementBusy?'busy':'1'}:{})}})
    webState.clientStartedBy=new Date()
    const clientClosed=new Promise(resolve=>client.once('exit',resolve))
    clientRelay.allowClientPid(fixtureChildPid(client),clientClosed)
    client.stdout.on('data',clientOutput);client.stderr.on('data',d=>{clientLog=(clientLog+d).slice(-262144);process.stderr.write(d)})
    client.on('close',()=>{for(const gate of gates.values())gate.reject()})
  }
  if(!restoreState&&!pendingOpen){
    const maxBudget=webMobile?480000:300000
    const budget=webAndroid?Number(process.env.RUNE_ANDROID_CLIENT_BUDGET_MS??300000):webMobile?480000:web||filesState||gitPanel?300000:120000
    assert(Number.isInteger(budget)&&budget>0&&budget<=maxBudget,'Invalid client deadline')
    const exited=webState.clientClosed??new Promise((resolve,reject)=>{client.once('close',code=>resolve(code??1));client.once('error',reject)})
    webState.clientClosed=exited
    let timer
    try{
      const outcome=interruptedSignal
        ?{timedOut:false,interrupted:interruptedSignal,code:1}
        :await Promise.race([
          exited.then(code=>({timedOut:false,interrupted:null,code})),
          new Promise(resolve=>{timer=setTimeout(()=>resolve({timedOut:true,interrupted:null,code:1}),budget)}),
          new Promise(resolve=>{abortClientWait=signal=>resolve({timedOut:false,interrupted:signal,code:1})}),
        ])
      if(outcome.timedOut||outcome.interrupted){
        if(outcome.timedOut)expired=true
        await stopClientOnce(client)
      }
      if(outcome.interrupted)throw Error(`Launcher interrupted by ${outcome.interrupted}`)
      result=outcome.code
    }finally{clearTimeout(timer);abortClientWait=null}
    assert(!expired,`Client probe exceeded ${budget}ms; last Files stage: ${filesStages.at(-1)?.stage??'none'}`)
  }
  assert.equal(result,0,webState.diagnostic||undefined);if(web){assert.equal(stats.created,0);assert.equal(stats.prompts,webMoreActions||webAndroid&&!probeGpu&&!sampleScroll?1:0);if(!webRestore&&!probeGpu)assert(stats.lists>=(webAndroid||mobileSessionSearch||historyReturnOnly||webMoreActions?1:webTouchHistory?4:webMissions||webGitImages?2:webSse7Tabs?7:webMobile?6:12))}else if(workspaceClaims||pendingOpen||filesState||gitPanel){assert.equal(stats.created,0);assert.equal(stats.prompts,0)}else if(controls){control.done()}else{assert.equal(stats.created,restoreState?2:1);assert.equal(stats.prompts,2)}
  if(gitPanel){
    if(!placeWorktree){
      await removeReview
      assert(reviewRemoved)
      await assert.rejects(access(review),{code:'ENOENT'})
    }
    assert(clientLog.split(/\r?\n/).includes('{"type":"git-panel-proof","mounted":true}'))
    assert.equal((await git('log','-1','--format=%s','main')).trim(),'Commit from Rune')
    assert.equal((await git('show','main:git-panel.txt')).trim(),'git-panel edited')
    assert.equal((await git('show','review:git-panel.txt')).trim(),'git-panel initial')
    assert.equal(await git('status','--porcelain'),'')
    if(placeWorktree){
      assert(!requests.some(route=>route.endsWith('/prompt')), 'No native prompt request during placement qualification')
      assert.deepEqual(moves,placementAmbiguous?['ses_existing','ses_child','ses_existing']:['ses_existing','ses_child'])
      assert.equal(records.get('ses_another').location.directory,project)
      assert.equal(records.get('ses_child').location.directory,placementAmbiguous?project:review)
      assert(clientLog.includes(`{"type":"worktree-placement-proof","draftRetained":true,"unconfirmed":${placementAmbiguous}}`))
    }
  }
  if(filesState){
    await filesChain;assert(filesProof);assert.deepEqual(filesStages.map(s=>s.stage),filesExpected)
    const version=text=>`"${createHash('sha256').update(text).digest('hex')}"`
    assert.deepEqual(filesProof.readerVersions.map(p=>p.text),readerTexts)
    assert.deepEqual(filesProof.readerVersions.map(p=>p.version),readerTexts.map(version))
    for(const preview of filesProof.readerVersions){assert.equal(preview.path,'src/initial.ts');assert.equal(path.resolve(preview.directory),project);assert.equal(preview.session,'ses_existing');assert(preview.workspace)}
    assert.equal(new Set(filesProof.readerVersions.map(p=>p.workspace)).size,1)
    assert.equal(filesProof.readerReplacement.path,'initial.txt');assert.equal(filesProof.readerReplacement.text,'initial');assert.equal(filesProof.readerReplacement.version,version('initial'))
    for(const key of ['readerHiddenLive','readerSuspensionRetained','readerQueuedCloseAndReplacementFenced','readerClosed'])assert.equal(filesProof[key],true)
    if(documentState)assert.deepEqual(filesProof.document,{cancelled:true,versionConflict:true,saved:documentDraft,draftRetained:true,lateEditRejected:true,discarded:true,interfaceQualified:false})
    assert(!requests.includes('POST /api/session'));assert(!requests.some(r=>r.endsWith('/prompt')))
    await signIn(origin);assert.deepEqual(await (await http.get('/api/workspaces')).json(),[])
  }
  if(!web&&!controls&&!workspaceClaims&&!pendingOpen&&!filesState&&!gitPanel)assert.deepEqual(visibleProof.map(p=>p.turn),[1,2],'Both distinct assistant turns must be visible before their endings')
  if(restoreState){assert.deepEqual(restoreStages.map(s=>s.stage),['prepare','resume','verify']);assert.deepEqual(restorePrompts.map(p=>p.sessionID),['ses_created_2','ses_created_1']);for(const id of ['ses_created_1','ses_created_2']){const rows=stores.get(id).rows;assert.deepEqual(rows.map(r=>r.type),['user','assistant']);assert(rows[1].time.completed)}}
  console.log(JSON.stringify({fixture:'launcher',uncertain,withTools,workspaceClaims,restoreState,webRestore,filesState,documentState,...stats,profile}))
}catch(error){result=1;runError=error;console.error(JSON.stringify({profile,stats}));throw error}finally{
  const finalResult=await finalize()
  result=finalResult
  if(!runError&&finalResult!==0&&!interruptedSignal){
    if(clientStopError)assert.fail(`Owned client cleanup failed: ${clientStopError}`)
    if(teardownErrors.length)assert.fail(`Fixture teardown failed: ${teardownErrors.join('; ')}`)
    if(androidCleanup?.length)assert.deepEqual(androidCleanup,[],'Android fixture cleanup must complete')
    assert.equal(server?.exitCode,0,'Owned server must exit cleanly')
  }
}
process.exitCode=publishedResult
