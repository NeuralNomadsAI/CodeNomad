import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {createHash} from 'node:crypto'
import {chmod,readFile} from 'node:fs/promises'
import {chromium} from 'playwright'
import path from 'node:path'
import {spawnFixtureChild} from '../../../scripts/native-fixture-guards.mjs'
import {createAttestedTcpRelay,fixtureAttestationEnv,resolveLoopbackListenerPid,stripFixtureServerSecrets,verifyExecutableMatches,verifyLoopbackListenerOwner,verifyPrivateFixtureServer} from '../../../scripts/native-fixture-http.mjs'
import {pairFixture} from '../../../scripts/rune/web-mobile.mjs'
import {androidDevice,androidLease} from './android-device.mjs'
import {serverBinary} from './fixture-binaries.mjs'

export async function launchWeb({
  root,profile,project,browserOutput,ui,manifest,solid,ts,env,origin,serverPid,runLog,http,mobile,restart,
  webMobile,webAndroid,webMoreActions,historyReturnOnly,menuLive,mobileSessionSearch,webMissions,webGitImages,sameOriginPairing,webPending,webFileWrap,webMobileDrawers,webKeyboard,resetKeyboard,webRestore,webTimeline,webTouchHistory,webSearch,webOutline,
}, state) {
  if(webTimeline||webSearch||webOutline){
    const config=await http.patch('/api/storage/config/ui',{data:{settings:{showThinkingBlocks:true,systemMessagesVisibility:'expanded',
      ...(webSearch?{toolGroupVisibility:'collapsed',toolInputsVisibility:'hidden'}:{})}}})
    assert(config.ok(),`Configure the history fixture: ${await config.text()}`)
  }
  const storage=path.join(profile,'browser-storage.json')
  let uiOrigin=origin,paired
  if(webMobile){
    uiOrigin=ts?.https??runLog.match(/^HTTPS (https:\/\/127\.0\.0\.1:\d+)\r?$/m)?.[1]
    assert(uiOrigin,'HTTPS fixture missing')
    if(!webAndroid){
      const issue=await http.post('/api/remote-control/pairings')
      assert.equal(issue.status(),200)
      paired=await pairFixture({origin:uiOrigin,targetPid:serverPid,profile,pairingUrl:(await issue.json()).url,storage,manifest,ui,fromLink:!sameOriginPairing})
    }
  }else{
    await http.storageState({path:storage})
    await chmod(storage,0o600).catch(()=>{})
  }
  let workspace
  if(!webRestore){
    const opened=await http.post('/api/workspaces',{data:{path:project}})
    assert(opened.ok(),`Open isolated workspace: ${await opened.text()}`)
    workspace=(await opened.json()).id
    assert(workspace)
  }
  const asset=await http.get(solid?'/index.html':'/app_bg.wasm')
  assert.equal(asset.status(),200)
  const sha256=createHash('sha256').update(await asset.body()).digest('hex')
  assert.equal(sha256,solid?createHash('sha256').update(await readFile(path.join(solid,'index.html'))).digest('hex'):
    manifest.files.find(file=>file.file==='app_bg.wasm').sha256)
  state.staticProof={sha256,testSupport:manifest.testSupport,origin,workspace,backend:ts?'ts':'rust',serverBinary:ts?.args[0]??serverBinary,ui:solid||ui,paired}

  const runner=webAndroid?'web-android.mjs':webRestore?'web-restore.mjs':'web-smoke.mjs'
  const args=webAndroid
    ?[uiOrigin,profile,project,ui,String(serverPid),String(process.pid)]
    :['--url',`${uiOrigin}/`,...(Number.isSafeInteger(serverPid)&&serverPid>0?['--target-pid',String(serverPid)]:[]),'--launcher-pid',String(process.pid),...(webMobile?['--mobile']:[]),...(webMissions?['--missions']:[]),...(sameOriginPairing?['--same-origin-pairing']:[]),...(webPending?['--pending-open']:[]),...(webFileWrap?['--file-wrap']:[]),...(webMobileDrawers?['--mobile-drawers']:[]),...(webRestore?[]:['--connected','--workspace',workspace]),'--project',project,'--storage-state',storage,'--out',browserOutput,'--executable',process.env.CODENOMAD_BROWSER_PATH||chromium.executablePath()]
  if(webTimeline)args.push(webTouchHistory?'--touch-history':'--timeline')
  if(webSearch)args.push('--history-search')
  if(webOutline)args.push('--outline')
  if(webKeyboard)args.push('--keyboard-viewport')
  if(mobileSessionSearch)args.push('--mobile-session-search')
  if(historyReturnOnly)args.push('--history-return-only')
  if(webGitImages)args.push('--git-images')
  if(webMoreActions)args.push('--more-actions-only')
  const androidEnv=webAndroid?Object.fromEntries(Object.entries(process.env).filter(([key])=>key.startsWith('RUNE_ANDROID_'))):{}
  if(webAndroid){
    androidEnv.NODE_EXTRA_CA_CERTS=path.join(profile,'identity.data/tls/ca-cert.pem')
    // Validate ADB config and attest the private ADB server PID and executable before opening the TCP relay.
    const device=androidDevice(androidEnv)
    const adbPid=await resolveLoopbackListenerPid(Number(device.port))
    await verifyExecutableMatches(adbPid,androidEnv.RUNE_ANDROID_ADB)
    const androidRelay=await createAttestedTcpRelay(Number(new URL(uiOrigin).port),serverPid,{
      requireClientAttestation:true,
      allowedClientPids:[adbPid],
    })
    state.androidRelay=androidRelay
    const lease=androidLease(device,uiOrigin,{
      localPort:androidRelay.port,
      closeRelay:()=>androidRelay.close(),
    })
    try{
      await lease.open()
      state.deviceLease=lease
    }catch(error){
      try{await androidRelay.close()}catch(closeError){console.error(`Failed to close Android relay after open failure: ${closeError.message}`)}
      state.androidRelay=undefined
      throw error
    }
  }
  const safeClientEnv=stripFixtureServerSecrets(env)
  const attestationEnv=fixtureAttestationEnv(process.env,{includeServerRoots:true})
  const launch=(webMobile||webKeyboard)?spawn:spawnFixtureChild
  const client=launch(process.execPath,[path.join(root,`scripts/rune/${runner}`),...args],{cwd:root,env:{...safeClientEnv,...androidEnv,...attestationEnv,RUNE_WEB_DIR:ui},windowsHide:true,stdio:['ignore','pipe','pipe',...(webMobile||webKeyboard?['ipc']:[])]})
  state.client=client
  if(webKeyboard)client.on('message',action=>{
    if(action==='reset-keyboard'){
      resetKeyboard()
      if(client.connected)client.send({ok:true},()=>{})
    }
  })
  if(webAndroid)state.clientClosed=new Promise(resolve=>client.once('close',resolve))
  if(mobile)client.on('message',action=>{
    state.mobileAction=(async()=>{
      try{
        if(webMoreActions&&action==='menu-live'){
          menuLive()
          return {value:true}
        }
        if(action==='restart'){
          const resumed=await restart(http,uiOrigin)
          http=resumed.http
          if(state.androidRelay){
            await verifyLoopbackListenerOwner(Number(new URL(uiOrigin).port),resumed.value.serverPid)
            const attested=await verifyPrivateFixtureServer({targetPid:resumed.value.serverPid,launcherPid:process.pid,profile,root})
            state.androidRelay.setTargetPid(resumed.value.serverPid,attested.targetStartId)
          }
          return {value:resumed.value}
        }
        return {value:await mobile.command(action,http,ts?.https)}
      }catch(error){return {error:String(error.message)}}
    })().then(reply=>{if(client.connected)client.send(reply,()=>{})})
  })
  for(const stream of [client.stdout,client.stderr])stream.on('data',d=>{if(state.diagnostic.length<262144)state.diagnostic+=d})
}
