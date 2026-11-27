import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {readFile} from 'node:fs/promises'
import path from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import {activateControl,launchChromium} from '../../../scripts/rune/web-chromium.mjs'
import {bundleAssetPaths} from '../../../scripts/rune/web-workspace-policy.mjs'

const bundle = path.resolve(process.argv[2] ?? 'target/rune-web-settings-providers')
const loseHeaders = process.argv.includes('--lost-headers')
const opencodeMode = process.argv.find(arg => arg === '--local-opencode' || arg === '--remote-opencode')
const remoteAccess = process.argv.includes('--remote-access')
const remoteReceipts = process.argv.includes('--remote-receipts')
const notifications = process.argv.includes('--notifications')
const shortcuts = process.argv.includes('--shortcuts')
const about = process.argv.includes('--info')
const configFiles = process.argv.includes('--config-files')
const releasePage = 'https://github.com/NeuralNomadsAI/CodeNomad/releases/tag/v9.1.0-dev'
const stats = process.argv.includes('--stats')
const noDeviceRegistry = process.argv.includes('--no-device-registry')
const local = opencodeMode === '--local-opencode' || remoteAccess
const files = await bundleAssetPaths(bundle)
const directory = '/fixture/project'
const project = {id:'catalogue',path:directory,location:{directory}}
const base = '/workspaces/catalogue/instance/api/'
const streams = new Map()
const unexpected = []
const reads = []
const aggregates = []
let statsRead
let selectedPeriod = 7
let startHeld, closeHeld
const held = new Promise(resolve => {startHeld = resolve})
const heldClosed = new Promise(resolve => {closeHeld = resolve})
const usageRoute = `/api/workspaces/${project.id}/service-usage`
const proof = {owner:'fixture-owner',identity:'fixture-root',connection:'fixture-live'}
const day = 86_400_000
function snapshot(to, days, id) {
  const tokens = {input:12345,output:102,reasoning:44,cache:{read:12,write:3}}
  return {scope:'service',...proof,stats:{range:{from:to-days*day,to},sessions:12,subagents:3,prompts:38,
    steps:52,tokens,cost:0.0025,tools:{mode:'none'},activeDays:2,streak:1,
    models:id ? [{model:{providerID:'fixture',id,variant:'fast'},steps:52,tokens,cost:0.0025}]:[],
    activity:id ? [{date:'2026-11-20',steps:52}]:[]}}
}
const mime = {'.html':'text/html','.js':'text/javascript','.wasm':'application/wasm','.css':'text/css','.json':'application/json','.woff2':'font/woff2'}
let account = 'First fixture account', detached = false
const configPath = '/api/config-files'
const configFile = `${configPath}/opencode-global-config-jsonc/content`
const configOther = `${configPath}/opencode-global-config/content`
let configContent = '{\r\n  // comment\r\n}\r\n', configWrites = 0, hideWhitespace = true
let environmentVariables = {}, secureEnvVars = []
let contrast = 'on', permissions = 'autonomous', locale = 'en'
let showMessageTimeline, scrollControlsInTimelineCorner, diffViewMode, autoExpandActiveSubsessions, followUpBehavior
let transcriptSettings = {}, failEverythingOnce = false, failConfigReadOnce = false
let appearancePreferences = {mode:'light',light:{scheme:{id:'light'}}}
const stateWrites = []
let notificationRouting, notifyFocused
let hotkeyOverrides = { 'new-instance': [{key:'n',mod:true}], 'file-save': [{key:'n',mod:true}] }
let updateFeed = 'stable', infoReads = 0, invalidOffer = false, failFeed = false
const feedWrites = []
const writes = []
const memoryRequests = []
const opencodeRequests = []
const logLevelWrites = []
const loginStartWrites = []
let loginStartState = 'off'
let opencodeLogsReads = 0
const remoteRequests = []
const directOrigin = 'https://fixture.example:444'
const deviceId = '004633fb-53c4-477c-8b01-4cc5c177724b'
let deviceExists = true
let losePair = remoteReceipts, failDeviceRead = false
let logLevel = 'DEBUG'
let releaseInstall, installed = false
const installReady = new Promise(resolve => { releaseInstall = resolve })
const reviews = []
const date = '2026-01-01T00:00:00.000Z'
const entry = {id:'project-entry',title:'Project memory',type:'fact',text:'Project-only entry text',revision:'a'.repeat(64),createdAt:date,updatedAt:date,flagged:true}
const personal = {...entry,id:'global-entry',title:'Personal memory',text:'Personal entry text',flagged:false}
let projectEntries = [entry]
let cleanupCreates = 0, cleanupPrompts = 0, cleanupSession
const promptIds = new Set()
const projectClaims = new Set()
let memoryEnabled = false
let releaseState
const stateReady = new Promise(resolve => { releaseState = resolve })
const server = createServer(async (req,res) => {
  const url = new URL(req.url,'http://localhost')
  const p = url.pathname
  const json = value => res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(value))
  try {
    if (p === '/api/meta') {
      const meta = {apiContract:1,serverId:'fixture-settings',
        capabilities:['integrations','settings-atomic-patches',...(configFiles?['config-files']:[]),...(stats?['service-usage']:[])],localRequest:local}
      if (!about) return json(meta)
      infoReads++
      return json({...meta,updateFeed,serverVersion:'9.0.1',ui:{version:'9.0.2',source:'fixture'},
        listeningMode:'all',host:'192.0.2.10',localUrl:'http://127.0.0.1:3456',
        remoteUrl:'https://192.0.2.10:3457',workspaceRoot:directory,system:{platform:'win32',arch:'x64'},
        addresses:[{ip:'192.0.2.10',family:'ipv4',scope:'internal',remoteUrl:'https://192.0.2.10:3457'},
          {ip:'192.0.2.11',family:'ipv4',scope:'internal',remoteUrl:'https://192.0.2.11:3457'}],
        update:updateFeed!=='preview'?null:invalidOffer?
          {version:'9.2.0-dev',tag:'v9.2.0-dev',channel:'preview',url:'https://example.test/release'}:
          {version:'9.1.0-dev',tag:'v9.1.0-dev',channel:'preview',url:releasePage}})
    }
    if (p.startsWith(configPath)) {
      assert(configFiles)
      if (p === configPath) return json([
        {id:'opencode-global-config-jsonc',label:'OpenCode Global Config (JSONC)',path:'~/.config/opencode/opencode.jsonc',language:'jsonc'},
        {id:'opencode-global-config',label:'OpenCode Global Config',path:'~/.config/opencode/opencode.json',language:'json'},
      ])
      if (p === configFile && req.method === 'PUT') {
        let body = ''
        for await (const chunk of req) body += chunk
        configWrites++
        configContent = JSON.parse(body).contents
        return res.writeHead(204).end()
      }
      if (p === configFile) return json({id:'opencode-global-config-jsonc',contents:configContent,exists:true})
      if (p === configOther) return json({id:'opencode-global-config',contents:'',exists:false})
    }
    if (p === '/api/opencode/update') {
      opencodeRequests.push(`${req.method}${url.search}`)
      if (about) {
        assert.equal(req.method,'GET')
        return json({state:'ready',serviceState:'ready',currentVersion:'2.3.2',daemonVersion:'2.3.1'})
      }
      assert(local,'The remote pane must not try to read or mutate OpenCode')
      if (req.method === 'POST') {
        let body = ''
        for await (const chunk of req) body += chunk
        assert.deepEqual(JSON.parse(body),{})
        await installReady
        installed = true
        return json({success:true,version:'2.3.2'})
      }
      assert.equal(req.method,'GET')
      return json({state:'ready',serviceState:'ready',currentVersion:installed?'2.3.2':'2.3.0',
        latestVersion:'2.3.2',updateAvailable:!installed,canUpgrade:!installed,installationSource:'managed',binaryPath:'/fixture/opencode'})
    }
    if (p === '/api/opencode/login-start') {
      assert(local,'The remote pane must not read or mutate login-start')
      if (req.method === 'POST') {
        let body = ''
        for await (const chunk of req) body += chunk
        const change = JSON.parse(body)
        loginStartWrites.push(change)
        loginStartState = change.enabled ? 'on' : 'off'
      }
      return json({state:loginStartState})
    }
    if (p === '/api/opencode/logs') {
      assert(local,'The remote pane must not read OpenCode logs')
      opencodeLogsReads++
      return json({path:'/fixture/opencode.log',text:'fixture opencode log line\n',truncated:false})
    }
    if (p === '/api/storage/binaries/validate') {
      assert(local,'The remote pane must not validate OpenCode binaries')
      return json({valid:true,version:'2.3.2'})
    }
    if (p === '/api/auth/status') return json({authenticated:true})
    if (stats && p.startsWith(usageRoute)) {
      assert.equal(req.method,'GET')
      if (p === `${usageRoute}/owner`) return json(proof)
      assert.equal(url.searchParams.get('timezone'),'Europe/Paris')
      if (p === `${usageRoute}/cache`) {
        const days = Number(url.searchParams.get('days') ?? selectedPeriod)
        const id = days === 90 ? 'other-window' : days === 7 ? 'cached' : undefined
        return json({days,...proof,...(id && {snapshot:snapshot(1_800_000_000_000,days,id)})})
      }
      assert.equal(p,usageRoute)
      const query = url.searchParams
      const to = Number(query.get('to')), days = (to-Number(query.get('from')))/day
      const restore = query.get('restorePeriod') === 'true'
      assert([7,30,90,365].includes(days))
      const index = aggregates.push({days,restore}) - 1
      if (index === 0) return statsRead = () => json(snapshot(to,7,'fresh'))
      if (index === 2) return res.writeHead(503).end()
      if (index === 4) {
        res.on('close',()=>closeHeld(!res.writableEnded))
        startHeld()
        return
      }
      if (!restore) selectedPeriod = days
      return json(snapshot(to,restore ? selectedPeriod : days,index === 1 ? 'updated' : undefined))
    }
    if (p.startsWith('/api/remote-control/')) {
      assert(remoteAccess && local)
      remoteRequests.push(`${req.method} ${p.slice('/api/remote-control/'.length)}`)
      if (p === '/api/remote-control/status') {
        return json({manageable:true,enabled:false,state:'stopped',directOrigins:noDeviceRegistry?[]:[directOrigin]})
      }
      if (p === '/api/remote-control/devices') {
        if (noDeviceRegistry) return res.writeHead(501).end()
        if (failDeviceRead) {
          failDeviceRead = false
          return res.writeHead(503).end()
        }
        return json({devices:deviceExists?[{id:deviceId,name:'Fixture Tablet',origin:directOrigin,lastSeenAt:date}]:[]})
      }
      if (p === '/api/remote-control/pairings') {
        assert.equal(req.method,'POST')
        let body = ''
        for await (const chunk of req) body += chunk
        assert.deepEqual(JSON.parse(body),{origin:directOrigin})
        if (losePair) {
          losePair = false
          res.writeHead(200,{'content-type':'application/json','content-length':'80'})
          res.write('{"url":')
          return setTimeout(()=>res.destroy(),50)
        }
        return json({url:`${directOrigin}/remote-pair#abcdefghijklmnopqrstuv`,expiresAt:new Date(Date.now()+240000).toISOString()})
      }
      assert.equal(p,`/api/remote-control/devices/${deviceId}`)
      assert.equal(req.method,'DELETE')
      deviceExists = false
      if (remoteReceipts) {
        failDeviceRead = true
        res.writeHead(200,{'content-type':'application/json','content-length':'80'})
        res.write('{')
        return setTimeout(()=>res.destroy(),50)
      }
      return res.writeHead(204).end()
    }
    if (p === '/api/workspaces' && req.method === 'GET') return json([project])
    if (p === '/api/workspaces' && req.method === 'POST') {
      let body = ''
      for await (const chunk of req) body += chunk
      const {path:requested,requestId} = JSON.parse(body)
      assert.equal(requested,directory)
      projectClaims.add(requestId)
      return json({...project,requestId})
    }
    if (p === `/api/workspaces/${project.id}/creation/release` && req.method === 'POST') {
      let body = ''
      for await (const chunk of req) body += chunk
      assert(projectClaims.delete(JSON.parse(body).requestId),'Release must match a fixture project claim')
      return res.writeHead(204).end()
    }
    if (p === '/api/workspaces/catalogue' && req.method === 'DELETE') return res.writeHead(204).end()
    if (p === '/api/events') {
      const client = url.searchParams.get('clientId')
      if (detached) return res.writeHead(503).end()
      res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'})
      res.write(': ready\n\n')
      streams.set(client,res)
      res.on('close',()=>{if(streams.get(client)===res) streams.delete(client)})
      return
    }
    if (p === '/api/storage/config/ui') {
      if (req.method === 'GET' && failConfigReadOnce) {
        failConfigReadOnce = false
        return res.writeHead(503).end()
      }
      if (req.method === 'PATCH') {
        let body = ''
        for await (const chunk of req) body += chunk
        const patch = JSON.parse(body)
        writes.push(patch)
        hideWhitespace = patch.settings.hideDiffWhitespaceChanges ?? hideWhitespace
        if (shortcuts && Array.isArray(patch.settings.hotkeyOverrides?.['close-instance'])) {
          return res.writeHead(503).end()
        }
        contrast = patch.settings.highContrast ?? contrast
        locale = patch.settings.locale ?? locale
        permissions = patch.settings.newConversationPermissions ?? permissions
        showMessageTimeline = patch.settings.showMessageTimeline ?? showMessageTimeline
        scrollControlsInTimelineCorner = patch.settings.scrollControlsInTimelineCorner ?? scrollControlsInTimelineCorner
        diffViewMode = patch.settings.diffViewMode ?? diffViewMode
        if (failEverythingOnce && patch.settings.toolCallExpansionDefaults?.preset === 'everything') {
          failEverythingOnce = false
          return res.writeHead(503).end()
        }
        autoExpandActiveSubsessions = patch.settings.autoExpandActiveSubsessions ?? autoExpandActiveSubsessions
        followUpBehavior = patch.settings.followUpBehavior ?? followUpBehavior
        for (const key of [
          'toolGroupVisibility',
          'systemMessagesVisibility',
          'showThinkingBlocks',
          'diagnosticsExpansion',
          'toolInputsVisibility',
          'showUsageMetrics',
          'usageMetricsExpansion',
          'thinkingBlocksExpansion',
          'toolOutputExpansion',
        ]) {
          if (key in patch.settings) transcriptSettings[key] = patch.settings[key]
        }
        if (patch.settings.toolCallExpansionDefaults && typeof patch.settings.toolCallExpansionDefaults === 'object') {
          const prev = transcriptSettings.toolCallExpansionDefaults ?? {}
          const next = patch.settings.toolCallExpansionDefaults
          const prevTools = prev.tools ?? {}
          const p = prev.preset ?? 'balanced'
          const transitioning = next.preset === 'custom' && prev.preset !== 'custom'
          const baseTools = transitioning
            ? Object.fromEntries([
                'bash','read','write','edit','patch','webfetch','websearch','glob','grep','task','execute','skill','question','invalid','other',
              ].map((tool) => {
                const def = p === 'nothing' ? 'hidden'
                  : p === 'everything' ? 'expanded'
                  : p === 'minimal' ? 'collapsed'
                  : p === 'detailed' ? (['read','skill','invalid'].includes(tool) ? 'collapsed' : 'expanded')
                  : (['bash','write','edit','patch','task','execute','question'].includes(tool) ? 'expanded' : 'collapsed')
                return [tool, prevTools[tool] ?? def]
              }))
            : prevTools
          if (transitioning && !('usageMetricsExpansion' in patch.settings) && transcriptSettings.usageMetricsExpansion === undefined) {
            transcriptSettings.usageMetricsExpansion = (p === 'everything' || p === 'detailed') ? 'expanded' : 'collapsed'
          }
          transcriptSettings.toolCallExpansionDefaults = {
            ...prev,
            ...(transitioning && !('thinking' in next) && prev.thinking === undefined
              ? {thinking: (p === 'everything' || p === 'detailed') ? 'expanded' : 'collapsed'}
              : {}),
            ...next,
            ...(next.tools || Object.keys(baseTools).length ? {tools:{...baseTools, ...(next.tools ?? {})}} : {}),
          }
        }
        if (patch.settings.notificationRouting) {
          if (!notificationRouting) {
            const sysCats = new Set(['needsInput','sessionDone','updates'])
            const histCats = new Set(['updates','files','projects','opencode'])
            notificationRouting = Object.fromEntries(
              ['needsInput','sessionDone','updates','files','projects','sessions','opencode','copy','settings'].map((cat) => [
                cat,
                {screen:cat!=='needsInput'&&cat!=='sessionDone',history:histCats.has(cat),system:sysCats.has(cat)},
              ]),
            )
          }
          for (const [category, row] of Object.entries(patch.settings.notificationRouting)) {
            if (row === null) delete notificationRouting[category]
            else notificationRouting[category] = {...notificationRouting[category],...row}
          }
        }
        notifyFocused = patch.settings.osNotificationsAllowWhenVisible ?? notifyFocused
        if (patch.settings.hotkeyOverrides === null) hotkeyOverrides = {}
        else for (const [id, binding] of Object.entries(patch.settings.hotkeyOverrides ?? {})) {
          if (binding === null) delete hotkeyOverrides[id]
          else hotkeyOverrides[id] = binding
        }
        const payload = {settings:{locale,highContrast:contrast,newConversationPermissions:permissions,
          ...(showMessageTimeline !== undefined && {showMessageTimeline}),
          ...(scrollControlsInTimelineCorner !== undefined && {scrollControlsInTimelineCorner}),
          ...(diffViewMode !== undefined && {diffViewMode}),
          ...(autoExpandActiveSubsessions !== undefined && {autoExpandActiveSubsessions}),
          ...(followUpBehavior !== undefined && {followUpBehavior}),
          ...transcriptSettings,
          notificationRouting,osNotificationsAllowWhenVisible:notifyFocused,hotkeyOverrides,
          hideDiffWhitespaceChanges:hideWhitespace,holdLongAssistantReplies:true}}
        // Mirror real server-rs: broadcast storage.configChanged after a successful PATCH.
        for (const stream of streams.values()) {
          stream.write(`data: ${JSON.stringify({type:'storage.configChanged',owner:'ui',value:payload})}\n\n`)
        }
        return json(payload)
      }
      return json({settings:{locale,highContrast:contrast,newConversationPermissions:permissions,
        ...(showMessageTimeline !== undefined && {showMessageTimeline}),
        ...(scrollControlsInTimelineCorner !== undefined && {scrollControlsInTimelineCorner}),
        ...(diffViewMode !== undefined && {diffViewMode}),
        ...(autoExpandActiveSubsessions !== undefined && {autoExpandActiveSubsessions}),
        ...(followUpBehavior !== undefined && {followUpBehavior}),
        ...transcriptSettings,
        notificationRouting,osNotificationsAllowWhenVisible:notifyFocused,hotkeyOverrides,
        hideDiffWhitespaceChanges:hideWhitespace,holdLongAssistantReplies:true}})
    }
    if (p === '/api/storage/state/ui') {
      await stateReady
      if (req.method === 'PATCH') {
        let body = ''
        for await (const chunk of req) body += chunk
        const patch = JSON.parse(body)
        stateWrites.push(patch)
        if (patch.appearancePreferences) {
          appearancePreferences = {
            ...appearancePreferences,
            ...patch.appearancePreferences,
          }
        }
      }
      return json({appearancePreferences})
    }
    if (p === '/api/memory/settings') {
      memoryRequests.push(req.method)
      if (req.method === 'PUT') {
        let body = ''
        for await (const chunk of req) body += chunk
        assert.deepEqual(JSON.parse(body),{enabled:true})
        memoryEnabled = true
      }
      return json({enabled:memoryEnabled})
    }
    if (p === '/api/memory' && req.method === 'POST') {
      let body = ''
      for await (const chunk of req) body += chunk
      const {operation,context} = JSON.parse(body)
      reviews.push({operation,context})
      if (operation.action === 'list') {
        assert.equal(context.workspaceId,'catalogue')
        return json({scopeKey:operation.scope,observedAt:date,cleanupDirectory:directory,cleanupWritable:operation.scope==='global',
          entries:operation.scope === 'project' ? projectEntries : [personal]})
      }
      assert.deepEqual(context,{workspaceId:'catalogue',directory})
      assert.equal(operation.scope,'project')
      assert.equal(operation.id,entry.id)
      assert.equal(operation.revision,projectEntries[0].revision)
      if (operation.action === 'save') {
        assert.deepEqual(operation.content,{title:'Edited project memory',type:'fact',text:entry.text})
        projectEntries = [{...entry,...operation.content,revision:'b'.repeat(64)}]
        return json({id:entry.id,revision:projectEntries[0].revision,flagged:true})
      }
      assert.equal(operation.action,'delete')
      projectEntries = []
      return json({deleted:true})
    }
    if (p === '/api/storage/config/server') {
      if (configFiles) {
        if (req.method === 'PATCH') {
          let body = ''
          for await (const chunk of req) body += chunk
          const patch = JSON.parse(body)
          assert.deepEqual(patch,{environmentVariables:{CN_FIXTURE:'fixture'},secureEnvVarsMask:{CN_FIXTURE:true}})
          environmentVariables = {...environmentVariables,...patch.environmentVariables}
          for (const [name,masked] of Object.entries(patch.secureEnvVarsMask ?? {})) {
            secureEnvVars = secureEnvVars.filter(k => k.toLowerCase() !== name.toLowerCase())
            if (masked) secureEnvVars.push(name)
          }
        }
        return json({environmentVariables,secureEnvVars})
      }
      if (about) {
        if (req.method === 'PATCH') {
          let body = ''
          for await (const chunk of req) body += chunk
          const patch = JSON.parse(body)
          assert.deepEqual(patch,{updateFeed:failFeed?'stable':'preview'})
          feedWrites.push(patch)
          if (failFeed) return res.writeHead(503).end()
          updateFeed = patch.updateFeed
        }
        return json({updateFeed})
      }
      assert(local,'Only the local OpenCode pane reads server configuration')
      if (req.method === 'PATCH') {
        let body = ''
        for await (const chunk of req) body += chunk
        const change = JSON.parse(body)
        assert.deepEqual(change,{logLevel:'WARN'})
        logLevelWrites.push(change)
        logLevel = change.logLevel
      }
      return json({logLevel})
    }
    if (p.startsWith('/api/storage/')) return json({})
    if (p === '/api/workspaces/catalogue/worktrees') return json({repository:'uninitialized',worktrees:[]})
    if (p === '/api/workspaces/catalogue/provider-accounts/example') {
      assert.equal(url.searchParams.get('directory'),directory)
      return json({logins:{active:'account@example.test',secondary:'other@example.test'}})
    }
    if (p === `${base}session` && req.method === 'POST') {
      let body = ''
      for await (const chunk of req) body += chunk
      assert.deepEqual(JSON.parse(body),{title:'Tidy up',location:{directory}})
      cleanupSession = 'ses_fixture'
      cleanupCreates++
      return json({data:{id:cleanupSession,title:'Tidy up',location:{directory}}})
    }
    if (cleanupSession && p === `${base}session/${cleanupSession}/prompt`) {
      let body = ''
      for await (const chunk of req) body += chunk
      const prompt = JSON.parse(body)
      assert(prompt.id)
      assert.match(prompt.text,/Review and tidy only the global scope/)
      assert(!prompt.text.includes(personal.text))
      cleanupPrompts++
      promptIds.add(prompt.id)
      if (loseHeaders && cleanupPrompts === 1) return res.destroy()
      // Deliver the response headers, then cut the receipt body. With no headers Chromium
      // can replay the HTTP request itself; this case checks the app's own recovery path.
      res.writeHead(200,{'content-type':'application/json','content-length':'80'})
      res.write('{"data":')
      return setTimeout(()=>res.destroy(),50)
    }
    if (cleanupSession && p === `${base}session/${cleanupSession}`) return json({data:{id:cleanupSession,title:'Tidy up',location:{directory},time:{}}})
    if (p === `${base}session`) return json({data:[],cursor:{}})
    if (p.startsWith(base) && ['integration','provider','model','websearch/provider'].includes(p.slice(base.length))) {
      reads.push(p)
      const data = {
        integration:[{id:'example',name:'Fixture Provider',connections:[{type:'credential',id:'active',label:account}]}],
        provider:[{id:'example',name:'Fixture Provider'}],
        model:[{id:'model',providerID:'example'}],
        'websearch/provider':[],
      }
      return json({location:{directory},data:data[p.slice(base.length)]})
    }
    if (files.has(p)) {
      const filename = p === '/' ? '/index.html' : p
      const bytes = await readFile(path.join(bundle, filename))
      return res.writeHead(200,{'content-type':mime[path.extname(filename)] ?? 'application/octet-stream'}).end(bytes)
    }
    unexpected.push(`${req.method} ${p}`)
    res.writeHead(404).end()
  } catch (error) {
    unexpected.push(String(error))
    res.writeHead(500).end()
  }
})

await new Promise(resolve => server.listen(0,'127.0.0.1',resolve))
let browser, page
try {
  browser = await launchChromium(process.env.CODENOMAD_BROWSER_PATH||undefined)
  page = await browser.newPage({viewport:{width:390,height:844},hasTouch:true,isMobile:true,
    ...(stats && {timezoneId:'Europe/Paris'})})
  if (configFiles) {
    // Drop the page's receipt after the PUT settles. A socket reset on a reused
    // connection would instead make Chromium retry the idempotent PUT itself.
    await page.route(`**${configFile}`, async route => {
      if (route.request().method() !== 'PUT') return route.continue()
      const response = await route.fetch({maxRetries:0})
      assert.equal(response.status(),204)
      await route.abort('failed')
    })
  }
  if (about) {
    await page.route('https://raw.githubusercontent.com/**',route=>route.abort())
    await page.addInitScript(() => {
      Object.defineProperty(navigator,'userAgentData',{value:{
        platform:'Windows',mobile:false,
        getHighEntropyValues:async()=>({platformVersion:'15.0.0',architecture:'x86',bitness:'64'}),
      }})
      window.openedInfoLinks = []
      window.open = url => { window.openedInfoLinks.push(String(url)); return null }
      window.diagnosticClipboard = null
      window.rejectDiagnosticClipboard = true
      Clipboard.prototype.writeText = function(text) {
        if (window.rejectDiagnosticClipboard) return Promise.reject(new DOMException('Fixture refusal','NotAllowedError'))
        window.diagnosticClipboard = text
        return Promise.resolve()
      }
    })
  }
  if (notifications) await page.addInitScript(() => {
    window.permissionGestures = []
    window.Notification = class {
      static permission = 'default'
      static requestPermission() {
        window.permissionGestures.push(navigator.userActivation.isActive)
        this.permission = 'granted'
        return Promise.resolve(this.permission)
      }
    }
  })
  if (remoteAccess) await page.addInitScript(() => {
    Clipboard.prototype.writeText = function(text) {
      if (window.rejectPairingCopy) return Promise.reject(new DOMException('Fixture refusal','NotAllowedError'))
      window.pairingClipboard = text
      return Promise.resolve()
    }
  })
  const click = name => activateControl(page,page.getByRole('button',{name,exact:true}),{timeout:15000})
  const afterPaint = () => page.evaluate(() => new Promise(resolve =>
    requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const radio = name => page.getByRole('radio',{name,exact:true})
  const visible = name => page.getByText(name,{exact:true}).waitFor({state:'attached',timeout:15000})
  const mirrorTextbox = label => page.locator(`[data-rune-a11y] [role="textbox"][aria-label="${label}"]`)
  const fillField = async (label, value) => {
    const mirror = mirrorTextbox(label)
    const focused = page.locator('textarea:focus').and(page.getByRole('textbox',{name:label,exact:true}))
    if (!await focused.count()) {
      await mirror.waitFor({state:'attached',timeout:15000})
      await mirror.evaluate(el => el.click())
      await focused.waitFor({state:'attached',timeout:15000})
    }
    await mirror.waitFor({state:'detached',timeout:15000})
    assert.equal(await page.getByRole('textbox',{name:label,exact:true}).count(),1,`Focused textbox ${label} must not duplicate its mirror`)
    await focused.fill(value)
  }
  await page.goto(`http://127.0.0.1:${server.address().port}/?locale=en`)
  await Promise.all([
    page.waitForResponse(response=>new URL(response.url()).pathname==='/api/storage/config/ui'),
    page.waitForRequest(request=>new URL(request.url()).pathname==='/api/storage/state/ui'),
    click('Connect'),
  ])
  await page.getByRole('button',{name:'Connect',exact:true}).waitFor({state:'detached'})
  assert.equal(await page.getByRole('button',{name:directory,exact:true}).count(),0,'No app content while appearance state is pending')
  releaseState()
  await click(directory)
  await visible('No session selected')
  if (configFiles) await checkConfigFiles()
  else if (about) await checkInfo()
  else if (shortcuts) await checkShortcuts()
  else if (stats) await checkStats()
  else if (notifications) await checkNotifications()
  else if (remoteAccess) await checkRemoteAccess()
  else if (opencodeMode) await checkOpenCode()
  else await checkProviders()

  async function checkConfigFiles() {
    await click('Settings')
    await radio('Config Files').press('Enter')
    await visible('~/.config/opencode/opencode.jsonc')
    await fillField('Config Files','{\n  // edited\n  "key": invalid\n}\n')
    await visible('Unsaved changes')
    await visible('Syntax error on line 3')
    await radio('OpenCode Global Config').press('Enter')
    await visible('Discard unsaved changes before continuing?')
    await page.getByRole('button',{name:'Keep editing',exact:true}).press('Enter')
    await visible('Unsaved changes')
    await page.getByRole('button',{name:'Save',exact:true}).press('Enter')
    await visible('Config file saved.')
    assert.equal(configWrites,1)
    assert.equal(configContent,'{\r\n  // edited\r\n  "key": invalid\r\n}\r\n')
    await radio('OpenCode Global Config').press('Enter')
    await visible('File will be created on save')
    await radio('Advanced').press('Enter')
    const whitespace = page.getByRole('switch',{name:'Hide whitespace-only changes',exact:true})
    assert.equal(await whitespace.getAttribute('aria-checked'),'true')
    await whitespace.press('Enter')
    await page.getByRole('switch',{name:'Hide whitespace-only changes',checked:false,exact:true}).waitFor({state:'attached'})
    assert.deepEqual(writes,[{settings:{hideDiffWhitespaceChanges:false}}])
    assert.equal(await page.getByRole('button',{name:'Focus existing window on second launch',exact:true}).count(),0)
    assert.deepEqual(await page.getByRole('switch').allTextContents(),[
      'Auto-cleanup blank sessions',
      'Keep subagent idle markers',
      'Provider credit balance',
      'Hide whitespace-only changes',
      'Hold long assistant replies',
    ])
    for (const name of ['Auto-cleanup blank sessions','Keep subagent idle markers','Provider credit balance','Hold long assistant replies']) {
      assert.equal(await page.getByRole('switch',{name,exact:true}).getAttribute('aria-disabled'),'true')
    }
    assert.equal(await whitespace.getAttribute('aria-disabled'),null)
    const info = page.getByRole('button',{name:'Hold long assistant replies',exact:true})
    assert.equal(await info.getAttribute('aria-description'),'Rune does not apply this setting yet.')
    await info.press('Enter')
    assert.deepEqual(writes,[{settings:{hideDiffWhitespaceChanges:false}}])
    await page.getByRole('button',{name:'Environment Variables (0 variables)',exact:true}).press('Enter')
    await page.getByRole('button',{name:'Show value',exact:true}).press('Enter')
    await fillField('Variable name','CN_FIXTURE')
    // Move directly from the name to the value on Rune's input bridge.
    await page.keyboard.press('Tab')
    // Blurring Variable name restores its unfocused mirror in [data-rune-a11y].
    await mirrorTextbox('Variable name').waitFor({state:'attached',timeout:15000})
    // Rune uses one private password input for secure editors, also when revealed.
    await page.locator('input[type=password]:focus').waitFor({state:'attached'})
    const valueMirror = mirrorTextbox('Variable value')
    await valueMirror.waitFor({state:'detached',timeout:15000})
    await page.keyboard.insertText('fixture')
    await page.keyboard.press('Tab')
    await valueMirror.waitFor({state:'attached',timeout:15000})
    assert.equal(await valueMirror.evaluate(el => el.textContent?.includes('fixture') || [...el.attributes].some(attr => attr.value.includes('fixture'))),false,'Blurred password mirror must not expose secret value')
    assert(!(await page.locator('[data-rune-a11y]').innerText()).includes('fixture'),'Mirror must never expose secret value')
    await page.getByRole('button',{name:'Add variable',exact:true}).press('Enter')
    await page.getByRole('button',{name:'Environment Variables (1 variable)',exact:true}).waitFor({state:'attached'})
    assert.deepEqual(secureEnvVars,['CN_FIXTURE'])
    assert.deepEqual(writes,[{settings:{hideDiffWhitespaceChanges:false}}])
    console.log(JSON.stringify({fixture:'config-files',configWrites,hideWhitespace,environmentStored:true}))
  }

  async function checkInfo() {
    await click('Settings')
    await radio('Info').press('Enter')
    await visible('9.0.1')
    await visible('9.0.2')
    await visible('WebAssembly')
    await visible('Firewall, router or certificate settings may prevent connections.')
    assert.equal(await page.getByText('https://192.0.2.10:3457',{exact:true}).count(),2)
    assert.equal(await page.getByText('https://192.0.2.11:3457',{exact:true}).count(),0)
    await visible('Specific network interface')
    const downloadRelease = page.getByRole('button',{name:'Download update',exact:true})
    assert.equal(await downloadRelease.count(),0)
    await page.getByRole('group',{name:'Update feed',exact:true}).waitFor({state:'attached'})
    const before = infoReads
    const preview = radio('Previews and stable releases')
    await preview.press('Enter')
    await page.getByRole('radio',{name:'Previews and stable releases',exact:true,checked:true}).waitFor({state:'attached'})
    assert.deepEqual(feedWrites,[{updateFeed:'preview'}])
    assert.equal(infoReads,before+1)
    await visible('9.1.0-dev')
    await downloadRelease.press('Enter')
    await page.waitForFunction(url=>window.openedInfoLinks.includes(url),releasePage)
    failFeed = true
    const reread = page.waitForResponse(response=>new URL(response.url()).pathname==='/api/meta')
    await radio('Stable releases').press('Enter')
    await reread
    await page.locator('[aria-live="assertive"]').filter({hasText:'Could not save the update feed.'}).waitFor({state:'attached'})
    assert.deepEqual(feedWrites,[{updateFeed:'preview'},{updateFeed:'stable'}])
    assert.equal(infoReads,before+2)
    await page.getByRole('radio',{name:'Previews and stable releases',exact:true,checked:true}).waitFor({state:'attached'})
    const copy = page.getByRole('button',{name:'Copy to clipboard',exact:true})
    await copy.press('Enter')
    await page.locator('[aria-live="assertive"]').filter({hasText:'Could not copy diagnostics.'}).waitFor({state:'attached'})
    assert.equal(await page.evaluate(()=>window.diagnosticClipboard),null)
    await page.evaluate(()=>{window.rejectDiagnosticClipboard=false})
    await copy.press('Enter')
    await page.locator('[aria-live="polite"]').filter({hasText:'Diagnostics copied.'}).waitFor({state:'attached'})
    const report = await page.evaluate(()=>window.diagnosticClipboard)
    assert(report.includes(directory) && report.includes('2.3.2') && report.includes('2.3.1'))
    assert(!report.includes('192.0.2.11'))
    const file = page.waitForEvent('download')
    await page.getByRole('button',{name:'Download .txt',exact:true}).press('Enter')
    const exported = await file
    assert.match(exported.suggestedFilename(),/^codenomad-diagnostics.*\.txt$/)
    const exportedText = await readFile(await exported.path(),'utf8')
    assert(exportedText.includes(directory) && !exportedText.includes('192.0.2.11'))
    await page.getByRole('button',{name:'Report a bug',exact:true}).press('Enter')
    await page.waitForFunction(()=>window.openedInfoLinks.some(url=>url.includes('/issues/new?')))
    const bug = new URL(await page.evaluate(()=>window.openedInfoLinks.find(url=>url.includes('/issues/new?'))))
    assert.equal(bug.searchParams.get('template'),'bug_report.yml')
    assert.equal(bug.searchParams.get('codenomad-version'),'9.0.1 (UI 9.0.2)')
    assert.equal(bug.searchParams.get('opencode-version'),'2.3.2 (running daemon 2.3.1)')
    assert.equal(bug.searchParams.get('os-version'),'Windows 11 x64')
    const context = bug.searchParams.get('extra')
    assert(context.includes('Web browser (desktop, remote window)') && context.includes('Server OS: Windows x64'))
    assert(context.includes(`- Browser: ${await page.evaluate(()=>navigator.userAgent)}`))
    assert(!decodeURIComponent(bug.href).includes(directory) && !bug.href.includes('192.0.2.10'))
    invalidOffer = true
    await page.getByRole('button',{name:'Refresh',exact:true}).press('Enter')
    await visible('9.2.0-dev')
    assert.equal(await downloadRelease.count(),0)
    console.log(JSON.stringify({fixture:'info-preferences',feedWrites,confirmedRead:true,release:true,diagnostics:true}))
  }

  async function checkShortcuts() {
    await page.evaluate(() => {
      window.shortcutAnnouncements = []
      new MutationObserver(records => {
        for (const record of records) {
          if (record.target.getAttribute?.('aria-live') !== 'polite') continue
          for (const node of record.addedNodes) {
            const spoken = node.textContent.replaceAll('\u200b','')
            if (spoken) window.shortcutAnnouncements.push(spoken)
          }
        }
      }).observe(document.body,{childList:true,subtree:true})
    })
    await click('Settings')
    await radio('Keyboard shortcuts').press('Enter')
    const save = page.getByRole('group',{name:'Save file',exact:true})
    const edit = save.getByRole('button',{name:'Edit',exact:true})
    await edit.waitFor({state:'attached'})
    assert.match(await save.getAttribute('aria-description'),/is also assigned to: New instance/)
    const inactive = page.getByRole('group',{name:'Open command palette',exact:true})
    assert.equal(await inactive.getAttribute('aria-description'),'This action has no configurable shortcut in Rune yet.')
    assert.equal(await inactive.getByRole('button',{name:'Edit',exact:true}).count(),0)
    const filter = page.locator('textarea:focus').and(page.getByRole('textbox',{name:'Filter shortcuts',exact:true}))
    const filterFocused = () => page.evaluate(() =>
      document.activeElement?.getAttribute('aria-label')==='Filter shortcuts')
    const capture = page.getByRole('button',{name:'Press a key combination',exact:true})
    await mirrorTextbox('Filter shortcuts').waitFor({state:'attached',timeout:15000})
    for (let i=0;i<24 && !await filterFocused();i++) await page.keyboard.press('Tab')
    assert(await filterFocused())
    await filter.waitFor({state:'attached',timeout:15000})
    await mirrorTextbox('Filter shortcuts').waitFor({state:'detached',timeout:15000})
    assert.equal(await page.getByRole('textbox',{name:'Filter shortcuts',exact:true}).count(),1,'Focused Filter shortcuts must not duplicate its mirror')
    const caret = await filter.boundingBox()
    assert(caret)
    await edit.press('Enter')
    await capture.waitFor({state:'attached'})
    await page.mouse.click(caret.x + 4, caret.y + caret.height / 2)
    await capture.waitFor({state:'detached'})
    assert.deepEqual(writes,[])
    await edit.press('Enter')
    await capture.waitFor({state:'attached'})
    await page.mouse.click(caret.x + 4, caret.y + caret.height / 2)
    await page.keyboard.insertText('Save file')
    await capture.waitFor({state:'detached'})
    await inactive.waitFor({state:'detached'})
    assert.deepEqual(writes,[])
    const confirm = expect => page.waitForResponse(response=>response.request().method()==='PATCH'
      && expect(response.request().postDataJSON()?.settings?.hotkeyOverrides))
    const editFocused = () => page.evaluate(() => {
      const id = document.activeElement?.getAttribute('aria-activedescendant')
      return id && document.getElementById(id)?.getAttribute('aria-label') === 'Edit'
    })
    for (let i=0;i<12 && !await editFocused();i++) await page.keyboard.press('Tab')
    assert(await editFocused())
    await page.keyboard.press('Space')
    await capture.waitFor({state:'attached',timeout:5000})
    await page.keyboard.press('F8')
    await page.locator('[aria-live="assertive"]').filter({hasText:'The editor reserves this shortcut.'}).waitFor({state:'attached'})
    assert.deepEqual(writes,[])
    await Promise.all([
      confirm(overrides=>overrides?.['file-save']?.[0]?.key==='f8'),
      page.keyboard.press('Control+F8'),
    ])
    await save.getByText('Ctrl+F8',{exact:true}).waitFor({state:'attached'})
    // An unrelated failed write must neither announce a conflict nor suppress the next one.
    await page.mouse.click(caret.x + 4, caret.y + caret.height / 2)
    await filter.waitFor({state:'attached',timeout:15000})
    await filter.press('Control+a')
    await filter.press('Backspace')
    const close = page.getByRole('group',{name:'Close app tab',exact:true})
    const clear = close.getByRole('button',{name:'Clear shortcut',exact:true})
    const failed = close.getByText('Could not save keyboard shortcuts. Try again.',{exact:true})
    await clear.press('Enter')
    await failed.waitFor({state:'attached'})
    assert.deepEqual(await page.evaluate(()=>window.shortcutAnnouncements),[])
    await edit.press('Enter')
    await capture.waitFor({state:'attached'})
    await page.getByRole('application',{name:'CodeNomad',exact:true}).focus()
    await Promise.all([
      confirm(overrides=>overrides?.['file-save']?.[0]?.key==='n'),
      page.keyboard.press('Control+n'),
    ])
    await page.locator('[aria-live="polite"]').filter({hasText:'Ctrl+N is also assigned to: New instance'}).waitFor({state:'attached'})
    assert.equal(await failed.count(),1)
    const reset = confirm(overrides=>overrides===null)
    await page.getByRole('button',{name:'Reset all',exact:true}).press('Enter')
    await reset
    assert.deepEqual(hotkeyOverrides,{})
    await failed.waitFor({state:'detached'})
    assert.deepEqual(await page.evaluate(()=>window.shortcutAnnouncements),['Ctrl+N is also assigned to: New instance'])
    console.log(JSON.stringify({fixture:'shortcuts-preferences',catalogue:true,conflict:true,recorded:true,reset:true}))
  }

  async function checkStats() {
    const stream = Array.from(streams).find(([client])=>!client.endsWith('-preferences'))?.[1] ?? Array.from(streams.values())[0]
    assert(stream,'Project catalogue stream must be attached')
    const emit = value => stream.write(`data: ${JSON.stringify({instanceId:project.id,...value})}\n\n`)
    const hint = type => emit({type:'instance.event',event:{type,data:{sessionID:'ses_unselected'}}})
    const model = id => page.getByRole('rowheader',{name:`fixture/${id} · fast`,exact:true})
    const dialog = page.getByRole('dialog',{name:'Settings',exact:true})
    const stale = dialog.getByText('Previous statistics · awaiting refresh',{exact:true})
    await click('Settings')
    assert.equal(aggregates.length,0)
    await Promise.all([
      page.waitForRequest(request=>new URL(request.url()).pathname===usageRoute),
      radio('Stats').press('Enter'),
    ])
    await model('cached').waitFor({state:'attached'})
    assert.deepEqual(aggregates,[{days:30,restore:true}])
    await stale.waitFor({state:'attached'})
    assert(statsRead)
    statsRead()
    await model('fresh').waitFor({state:'attached'})
    assert.equal(await model('cached').count(),0)
    assert.equal(await page.getByRole('columnheader',{name:'Model'}).count(),1)
    await visible('12,345')
    const activity = page.getByRole('group',{name:'2026-11-20 · Steps: 52'})
    await activity.waitFor({state:'attached'})
    if (process.env.RUNE_STATS_SCREENSHOT) await page.screenshot({path:process.env.RUNE_STATS_SCREENSHOT})
    hint('session.deleted')
    await model('updated').waitFor({state:'attached'})
    await stale.waitFor({state:'detached'})
    emit({type:'instance.eventStatus',status:'disconnected',generation:2})
    await stale.waitFor({state:'attached'})
    assert.equal(await model('updated').count(),1)
    selectedPeriod = 90 // The other window's successful aggregate selected this period on the backend.
    emit({type:'instance.eventStatus',status:'connected',generation:2})
    await dialog.getByText('Could not refresh statistics. Check the OpenCode connection.',{exact:true}).waitFor({state:'attached'})
    await model('other-window').waitFor({state:'attached'})
    assert.equal(await model('updated').count(),0)
    assert.deepEqual(aggregates[2],{days:7,restore:true})
    const period = page.getByRole('combobox',{name:'Period · Last 90 days',exact:true})
    await period.press('Enter')
    await page.getByRole('option',{name:'Last 365 days',exact:true}).press('Enter')
    await model('other-window').waitFor({state:'detached'})
    await visible('Daily activity')
    assert.deepEqual(aggregates.at(-1),{days:365,restore:false})
    assert.equal(await page.getByRole('rowheader').count(),0)
    assert.equal(await activity.count(),0)
    const setVisibility = state => page.evaluate(state => {
      Object.defineProperty(document, 'visibilityState', {configurable:true, get:()=>state})
      document.dispatchEvent(new Event('visibilitychange'))
    },state)
    hint('session.deleted')
    await Promise.race([held, delay(10000,undefined,{ref:false}).then(()=>assert.fail('In-flight aggregate did not start'))])
    await setVisibility('hidden')
    await stale.waitFor({state:'attached'})
    assert.equal(await Promise.race([heldClosed,delay(10000,false,{ref:false})]),true,'Hiding the document aborts the HTTP request')
    hint('session.execution.succeeded')
    hint('session.deleted')
    assert.equal(aggregates.length,5)
    await setVisibility('visible')
    await stale.waitFor({state:'detached'})
    assert.equal(aggregates.length,6)
    await radio('General').press('Enter')
    hint('session.deleted')
    await page.waitForFunction(()=>!document.body.innerText.includes('Daily activity'))
    assert.equal(aggregates.length,6)
    assert.deepEqual(unexpected,[])
    console.log(JSON.stringify({fixture:'settings-stats',mobile:true,aggregates,restoredOtherWindow:true,emptyBreakdowns:true,hiddenAbort:true,hiddenRefresh:false}))
  }

  async function checkNotifications() {
    const stream = Array.from(streams).find(([client])=>!client.endsWith('-preferences'))?.[1] ?? Array.from(streams.values())[0]
    assert(stream,'Project catalogue stream must be attached')
    const message = 'Short announcement from the fixture'
    const envelope = {type:'instance.event',instanceId:project.id,event:{
      id:'toast-fixture',type:'tui.toast.show',data:{title:'Fixture toast',message,variant:'info',duration:2000},
    }}
    stream.write(`data: ${JSON.stringify(envelope)}\n\n`)
    const live = page.locator('[role="status"][aria-live="polite"]').filter({hasText:message})
    await live.waitFor({state:'attached'})
    assert.equal(await live.textContent(),`Fixture toast\n${message}`)
    const bubble = page.getByText(message,{exact:true})
    await bubble.waitFor({state:'attached'})
    const bell = page.getByRole('button',{name:'Notification History · 1 unread',exact:true})
    await bell.waitFor({state:'attached'})
    await bubble.waitFor({state:'detached',timeout:4000})
    assert.equal(await bell.count(),1,'Expiration leaves the history entry unread')

    await click('Settings')
    await radio('Notifications').press('Enter')
    const switcher = page.getByRole('switch',{name:'Notify when the app is focused',exact:true})
    const table = page.getByRole('table',{name:'Where each notification appears',exact:true})
    await table.waitFor({state:'attached'})
    for (const heading of ['Notification','On screen','History','System']) {
      assert.equal(await table.getByRole('columnheader',{name:heading,exact:true}).count(),1)
    }
    const rows = table.getByRole('row').filter({has:page.getByRole('rowheader')})
    assert.equal(await rows.count(),9)
    for (const row of await rows.all()) {
      const cells = row.getByRole('cell')
      assert.equal(await cells.count(),3)
      for (const cell of await cells.all()) assert.equal(await cell.getByRole('checkbox').count(),1)
    }
    const focusedName = () => page.evaluate(() => {
      const root = document.activeElement
      const id = root?.getAttribute('aria-activedescendant')
      return (id ? document.getElementById(id) : root)?.getAttribute('aria-label')
    })
    const first = 'A session needs your answer · On screen'
    for (let i=0;i<45 && await focusedName()!==first;i++) await page.keyboard.press('Tab')
    assert.equal(await focusedName(),first)
    for (const name of ['A session needs your answer · History','A session needs your answer · System','A session finished · On screen']) {
      await page.keyboard.press('Tab')
      assert.equal(await focusedName(),name)
    }
    assert.deepEqual(await page.evaluate(()=>window.permissionGestures),[])
    const history = page.getByRole('checkbox',{name:'Copy confirmations · History',exact:true})
    const historySaved = page.waitForResponse(response=>response.request().method()==='PATCH'
      && response.request().postDataJSON()?.settings?.notificationRouting?.copy?.history===true)
    await history.press('Enter')
    await historySaved
    await page.getByRole('checkbox',{name:'Copy confirmations · History',exact:true,checked:true}).waitFor({state:'attached'})
    assert.deepEqual(await page.evaluate(()=>window.permissionGestures),[])
    await page.getByRole('checkbox',{name:'Copy confirmations · System',exact:true}).press('Enter')
    await page.getByRole('button',{name:'Request permission',exact:true}).waitFor({state:'detached'})
    assert.deepEqual(await page.evaluate(()=>window.permissionGestures),[true])
    const patch = page.waitForResponse(response=>response.request().method()==='PATCH'
      && response.request().postDataJSON()?.settings?.osNotificationsAllowWhenVisible===true)
    await switcher.press('Enter')
    await patch
    assert.equal(notificationRouting.copy.history,true)
    assert.equal(notificationRouting.copy.system,true)
    assert.equal(notifyFocused,true)
    console.log(JSON.stringify({fixture:'notifications-preferences',cells:27,permissionGesture:true,foregroundSaved:true,bubbleAnnounced:true,bubbleExpired:true,accessibleUnread:true}))
  }

  async function checkRemoteAccess() {
    await click('Settings')
    await radio('Remote Access').press('Enter')
    if (noDeviceRegistry) {
      await visible('Remote Control is off')
      assert.equal(await page.getByRole('heading',{name:'Paired devices',exact:true}).count(),0)
      assert.equal(await page.getByRole('button',{name:'Create HTTPS pairing link',exact:true}).count(),0)
      assert.deepEqual(remoteRequests,['GET status','GET devices'])
      console.log(JSON.stringify({fixture:'remote-access-without-device-registry',remoteRequests}))
      return
    }
    await visible('Fixture Tablet')
    await visible(`HTTPS · ${directOrigin}`)
    const seen = page.getByText(/^Last seen /)
    await seen.waitFor({state:'attached'})
    const revoke = page.getByRole('button',{name:/^Revoke · Fixture Tablet · HTTPS · https:\/\/fixture\.example:444 · Last seen /})
    await revoke.waitFor({state:'attached'})
    assert.deepEqual(remoteRequests,['GET status','GET devices'])
    assert.equal(await page.getByRole('button',{name:'Start Remote Control',exact:true}).count(),0)
    const pair = page.getByRole('button',{name:'Create HTTPS pairing link',exact:true})
    if (remoteReceipts) {
      await pair.press('Enter')
      await visible('Connection failed')
      assert.deepEqual(remoteRequests,['GET status','GET devices','POST pairings','GET status','GET devices'])
      assert.equal(await page.getByRole('button',{name:'Copy link',exact:true}).count(),0)
    }
    await pair.press('Enter')
    const copy = page.getByRole('button',{name:'Copy link',exact:true})
    await copy.waitFor({state:'attached'})
    const link = `${directOrigin}/remote-pair#abcdefghijklmnopqrstuv`
    await visible(link)
    await page.evaluate(()=>{window.rejectPairingCopy=true})
    await copy.press('Enter')
    await visible('Copy failed')
    await page.evaluate(()=>{window.rejectPairingCopy=false})
    await copy.press('Enter')
    await page.waitForFunction(expected=>window.pairingClipboard===expected,link)
    await visible('Copied')
    await revoke.press('Enter')
    if (remoteReceipts) {
      await visible('Revocation pending')
      // The pinned mirror omits disabled state. Exercise activation and verify
      // the complete request sequence below, including no second DELETE.
      await revoke.press('Enter')
      assert.equal(remoteRequests.filter(value=>value.startsWith('DELETE')).length,1)
      await page.getByRole('button',{name:'Refresh',exact:true}).press('Enter')
    }
    await visible('No devices are paired yet.')
    assert.equal(await page.getByText('Connection failed',{exact:true}).count(),0)
    assert.deepEqual(remoteRequests,remoteReceipts
      ? ['GET status','GET devices','POST pairings','GET status','GET devices','POST pairings',`DELETE devices/${deviceId}`,'GET status','GET devices','GET status','GET devices']
      : ['GET status','GET devices','POST pairings',`DELETE devices/${deviceId}`,'GET status','GET devices'])
    assert.deepEqual(opencodeRequests,[])
    console.log(JSON.stringify({fixture:'remote-access',remoteRequests}))
  }

  async function checkOpenCode() {
    await Promise.all([
      page.waitForResponse(response=>new URL(response.url()).pathname==='/api/meta'),
      click('Settings'),
    ])
    const openCode = radio('OpenCode')
    const update = page.getByRole('button',{name:'Update to OpenCode 2.3.2',exact:true})
    await openCode.waitFor({state:local?'attached':'detached'})
    assert.deepEqual(opencodeRequests,[],'No diagnostic until OpenCode is opened')
    if (local) {
      const loginLoaded = page.waitForResponse(
        response=>new URL(response.url()).pathname==='/api/opencode/login-start' && response.request().method()==='GET'
      )
      await openCode.click({force:true})
      await Promise.all([update.waitFor({state:'attached'}), loginLoaded])
      assert.deepEqual(opencodeRequests,['GET'])
      const logging = page.getByRole('combobox',{name:'OpenCode Log Level',exact:true})
      await logging.and(page.locator('[aria-description="Debug"]')).waitFor({state:'attached'})
      await logging.click({force:true})
      await page.getByRole('option',{name:'Warn',exact:true}).click({force:true})
      await logging.and(page.locator('[aria-description="Warn"]')).waitFor({state:'attached'})
      assert.deepEqual(logLevelWrites,[{logLevel:'WARN'}])
      const loginSwitch = page.getByRole('switch',{name:'Launch at startup',exact:true})
      await loginSwitch.and(page.locator(':not([disabled], [aria-disabled="true"])')).waitFor({state:'attached'})
      await loginSwitch.click({force:true})
      await loginSwitch.and(page.locator('[aria-checked="true"]')).waitFor({state:'attached'})
      assert.deepEqual(loginStartWrites,[{enabled:true}])
      const openLogs = page.getByRole('button',{name:'View OpenCode logs',exact:true})
      await openLogs.click({force:true})
      await visible('fixture opencode log line')
      assert.equal(opencodeLogsReads,1)
      await page.getByRole('button',{name:'Close',exact:true}).last().click({force:true})
      await Promise.all([
        page.waitForRequest(request=>new URL(request.url()).pathname==='/api/opencode/update' && request.method()==='POST'),
        update.click({force:true}),
      ])
      await click('Close settings')
      await openCode.waitFor({state:'detached'})
      const reread = page.waitForResponse(response=>new URL(response.url()).searchParams.get('recheck')==='1')
      releaseInstall()
      await reread
      await click('Settings')
      await openCode.click({force:true})
      await visible('2.3.2')
      assert.equal(await update.count(),0)
      assert.deepEqual(opencodeRequests,['GET','GET','POST','GET?recheck=1'])
    } else {
      await radio('Providers').click({force:true})
      await visible(account)
      assert.equal(await openCode.count(),0)
      assert.equal(await radio('Remote Access').count(),0)
      assert.deepEqual(remoteRequests,[])
      assert.deepEqual(opencodeRequests,[])
      assert.deepEqual(logLevelWrites,[])
      assert.deepEqual(loginStartWrites,[])
      assert.equal(opencodeLogsReads,0)
    }
    console.log(JSON.stringify({fixture:'opencode-web',channel:local?'local':'remote',opencodeRequests,logLevelWrites,loginStartWrites,opencodeLogsReads}))
  }

  async function checkProviders() {
  await click('Settings')
  const memory = page.getByRole('switch',{name:'Memory',exact:true})
  await memory.waitFor({state:'attached'})
  assert.equal(await memory.getAttribute('aria-checked'),'false')
  await memory.click({force:true})
  await page.getByRole('switch',{name:'Memory',checked:true,exact:true}).waitFor({state:'attached'})
  assert.equal(await memory.getAttribute('aria-checked'),'true')
  assert.equal(memoryRequests.filter(method=>method==='PUT').length,1)
  await page.getByRole('button',{name:'Entries 1/200 New Needs review',exact:true}).waitFor({state:'attached'})
  assert.equal(await page.getByRole('button',{name:'Project memory',exact:true}).count(),0)
  await click('Entries 1/200 New Needs review')
  await page.getByText('Needs review',{exact:true}).last().waitFor({state:'attached'})
  await click('Close settings')
  await click('Settings')
  await page.getByRole('button',{name:'Entries 1/200 Needs review',exact:true}).waitFor({state:'attached'})
  await click('Project memory')
  await visible('Excluded from agent context')
  const editedTitle = 'Edited project memory'
  await fillField('Title',editedTitle)
  // The DOM input updates before Rune draws the dirty form. The pinned mirror
  // exposes Save even while disabled; the counter confirms the edited frame.
  await visible(`${[...editedTitle].length}/60`)
  const save = page.getByRole('button',{name:'Save',exact:true}).and(page.locator(':not([disabled], [aria-disabled="true"])'))
  await save.click({force:true,timeout:15000})
  await page.getByRole('button',{name:'Edited project memory',exact:true}).waitFor({state:'attached'})
  await click('Edited project memory')
  // The mirror publishes a new modal before Rune paints its pointer hit regions.
  await visible('Excluded from agent context')
  await afterPaint()
  await click('Forget')
  await visible('Forget “Edited project memory”?')
  assert(!reviews.some(({operation})=>operation.action==='delete'),'Forget needs confirmation')
  await afterPaint()
  await page.getByRole('button',{name:'Forget',exact:true}).last().click({force:true})
  await visible('No memories yet')
  assert.equal(reviews.filter(({operation})=>operation.action==='save').length,1)
  assert.equal(reviews.filter(({operation})=>operation.action==='delete').length,1)
  await radio('About you').click({force:true})
  await page.getByRole('button',{name:'Personal memory',exact:true}).waitFor({state:'attached'})
  assert.equal(await page.getByText('Project-only entry text',{exact:true}).count(),0)
  assert(reviews.some(({operation})=>operation.scope==='global'))
  const preferencesStream = Array.from(streams).find(([client])=>client.endsWith('-preferences'))?.[1]
  assert(preferencesStream,'Memory observes the host stream without opening another connection')
  memoryEnabled = false
  preferencesStream.write('data: {"type":"memory.changed"}\n\n')
  await page.getByRole('switch',{name:'Memory',checked:false,exact:true}).waitFor({state:'attached'})
  await radio('On').waitFor({state:'attached'})
  assert.equal(await radio('On').getAttribute('aria-checked'),'true')
  const savedOff = page.waitForResponse(response => new URL(response.url()).pathname === '/api/storage/config/ui' && response.request().method() === 'PATCH')
  await radio('Off').click({force:true})
  await savedOff
  assert.deepEqual(writes,[{settings:{highContrast:'off'}}])
  await page.getByRole('radio',{name:'Off',checked:true,exact:true}).waitFor({state:'attached'})
  const permissionTrigger = page.getByRole('combobox',{name:'New conversation permissions',exact:true})
  await permissionTrigger.and(page.locator('[aria-description="Autonomous"]')).waitFor({state:'attached'})
  await permissionTrigger.click({force:true})
  const savedPermissions = page.waitForResponse(response => new URL(response.url()).pathname === '/api/storage/config/ui' && response.request().method() === 'PATCH')
  await page.getByRole('option',{name:'Supervised',exact:true}).click({force:true})
  await savedPermissions
  assert.deepEqual(writes.at(-1),{settings:{newConversationPermissions:'supervised'}})
  await permissionTrigger.and(page.locator('[aria-description="Supervised"]')).waitFor({state:'attached'})
  const languageTrigger = page.getByRole('combobox',{name:'Language',exact:true})
  await languageTrigger.and(page.locator('[aria-description="English"]')).waitFor({state:'attached'})
  await languageTrigger.click({force:true})
  const savedFrench = page.waitForResponse(response => new URL(response.url()).pathname === '/api/storage/config/ui' && response.request().method() === 'PATCH')
  await page.getByRole('option',{name:'Français',exact:true}).click({force:true})
  await savedFrench
  assert.deepEqual(writes.at(-1),{settings:{locale:'fr'}})
  const frenchLanguage = page.getByRole('combobox',{name:'Langue',exact:true})
  await frenchLanguage.and(page.locator('[aria-description="Français"]')).waitFor({state:'attached'})
  await frenchLanguage.click({force:true})
  const savedEnglish = page.waitForResponse(response => new URL(response.url()).pathname === '/api/storage/config/ui' && response.request().method() === 'PATCH')
  await page.getByRole('option',{name:'English',exact:true}).click({force:true})
  await savedEnglish
  assert.deepEqual(writes.at(-1),{settings:{locale:'en'}})
  await languageTrigger.and(page.locator('[aria-description="English"]')).waitFor({state:'attached'})

  const savedDark = page.waitForResponse(response => new URL(response.url()).pathname === '/api/storage/state/ui' && response.request().method() === 'PATCH')
  await radio('Dark').click({force:true})
  await savedDark
  assert.deepEqual(stateWrites.at(-1),{appearancePreferences:{mode:'dark'}})
  const paletteTrigger = page.getByRole('combobox',{name:'Color scheme',exact:true})
  await paletteTrigger.and(page.locator('[aria-description="Mist"]')).waitFor({state:'attached'})
  await paletteTrigger.click({force:true})
  const savedBasalt = page.waitForResponse(response => new URL(response.url()).pathname === '/api/storage/state/ui' && response.request().method() === 'PATCH')
  await page.getByRole('option',{name:'Basalt',exact:true}).click({force:true})
  await savedBasalt
  assert.deepEqual(stateWrites.at(-1),{appearancePreferences:{dark:{scheme:{id:'basalt',appearance:'dark',colors:null},presetId:null}}})
  await paletteTrigger.and(page.locator('[aria-description="Basalt"]')).waitFor({state:'attached'})
  const savedLight = page.waitForResponse(response => new URL(response.url()).pathname === '/api/storage/state/ui' && response.request().method() === 'PATCH')
  await radio('Light').click({force:true})
  await savedLight
  assert.deepEqual(stateWrites.at(-1),{appearancePreferences:{mode:'light'}})
  await paletteTrigger.and(page.locator('[aria-description="Classic"]')).waitFor({state:'attached'})
  await paletteTrigger.click({force:true})
  const savedLinen = page.waitForResponse(response => new URL(response.url()).pathname === '/api/storage/state/ui' && response.request().method() === 'PATCH')
  await page.getByRole('option',{name:'Linen',exact:true}).click({force:true})
  await savedLinen
  assert.deepEqual(stateWrites.at(-1),{appearancePreferences:{light:{scheme:{id:'linen',appearance:'light',colors:null},presetId:null}}})
  await paletteTrigger.and(page.locator('[aria-description="Linen"]')).waitFor({state:'attached'})

  assert.equal(await page.getByRole('checkbox',{name:'Keep the computer awake while CodeNomad is running',exact:true}).count(),0,'Keep awake is desktop-only')
  for (const [label, initial, expectedPatch] of [
    ['Show the message timeline', true, {showMessageTimeline:false}],
    ['Put the first/latest message arrows under the timeline', false, {scrollControlsInTimelineCorner:true}],
    ['Split tool-call diffs', true, {diffViewMode:'unified'}],
    ['Automatically expand subsessions', true, {autoExpandActiveSubsessions:false}],
    ['Queue sent prompts', false, {followUpBehavior:'queue'}],
  ]) {
    const box = page.getByRole('checkbox',{name:label,exact:true})
    assert.equal(await box.getAttribute('aria-checked'),String(initial),label)
    const saved = page.waitForResponse(response => new URL(response.url()).pathname === '/api/storage/config/ui' && response.request().method() === 'PATCH')
    await box.click({force:true})
    await saved
    assert.deepEqual(writes.at(-1),{settings:expectedPatch})
    await page.getByRole('checkbox',{name:label,checked:!initial,exact:true}).waitFor({state:'attached'})
  }
  await radio('Chat').click({force:true})
  await visible('Transcript detail presets')
  const presetGroup = page.getByRole('group',{name:'Transcript detail presets',exact:true})
  await presetGroup.waitFor({state:'attached'})
  const presetButton = name => presetGroup.getByRole('button',{name,exact:true})
  for (const name of ['Nothing','Minimal','Balanced','Everything']) {
    await presetButton(name).waitFor({state:'attached'})
  }
  assert.equal(await presetButton('Balanced').getAttribute('aria-description'),'Active')
  assert.equal(await presetButton('Nothing').getAttribute('aria-description'),null)
  await afterPaint()
  // At 390px mobile viewport (< 672px / 42rem), preset buttons fold into a 2×2 grid;
  // at 1100px desktop viewport, all 4 presets stay on one row.
  const b0Narrow = await presetButton('Nothing').boundingBox()
  const b2Narrow = await presetButton('Balanced').boundingBox()
  assert(b0Narrow && b2Narrow && b2Narrow.y > b0Narrow.y + b0Narrow.height * 0.5, 'mobile viewport must fold presets into 2x2')
  // Narrow table header and row columns stay aligned side-by-side without row wrapping.
  const itemHeaderBox = await page.getByRole('columnheader',{name:'Item',exact:true}).boundingBox()
  const stateHeaderBox = await page.getByRole('columnheader',{name:'Default state',exact:true}).boundingBox()
  const groupsRowBox = await page.getByRole('rowheader',{name:'Tool groups',exact:true}).boundingBox()
  const groupsPicker = page.getByRole('combobox',{name:'Default state for Tool groups',exact:true})
  assert.equal(await groupsPicker.textContent(),'Collapsed')
  const groupsBtnBox = await groupsPicker.boundingBox()
  assert(itemHeaderBox && stateHeaderBox && groupsRowBox && groupsBtnBox)
  assert(Math.abs(stateHeaderBox.x - groupsBtnBox.x) < 4, 'narrow table state column must align with row picker')
  assert(Math.abs(groupsRowBox.y - groupsBtnBox.y) < groupsBtnBox.height, 'narrow table row must not wrap picker below label')
  await page.setViewportSize({width:1100,height:760})
  let b0Wide, b2Wide
  for (const until = Date.now() + 2000; Date.now() < until;) {
    await afterPaint()
    b0Wide = await presetButton('Nothing').boundingBox()
    b2Wide = await presetButton('Balanced').boundingBox()
    if (b0Wide && b2Wide && Math.abs(b2Wide.y - b0Wide.y) < 2) break
  }
  assert(b0Wide && b2Wide && Math.abs(b2Wide.y - b0Wide.y) < 2, 'wide viewport must place all 4 presets on one row')
  await page.setViewportSize({width:390,height:844})
  await afterPaint()
  await afterPaint()
  // Tab into the first preset button via Rune's real keyboard focus, assert ArrowRight does NOT
  // save a preset (matches Solid buttons), then activate Nothing with Enter.
  const focusedName = () => page.evaluate(() => {
    const root = document.activeElement
    const id = root?.getAttribute('aria-activedescendant')
    return (id ? document.getElementById(id) : root)?.getAttribute('aria-label')
      ?? (id ? document.getElementById(id) : root)?.textContent
  })
  const writesBeforeArrow = writes.length
  for (let i = 0; i < 30 && await focusedName() !== 'Nothing'; i++) await page.keyboard.press('Tab')
  assert.equal(await focusedName(),'Nothing','Tab must reach the first Chat preset button in Rune focus')
  await page.keyboard.press('ArrowRight')
  await afterPaint()
  await afterPaint()
  assert.equal(writes.length,writesBeforeArrow,'ArrowRight on preset buttons must not trigger a write')
  assert.equal(await presetButton('Balanced').getAttribute('aria-description'),'Active','ArrowRight must leave Balanced active')
  assert.equal(await presetButton('Nothing').getAttribute('aria-description'),null,'ArrowRight must not activate Nothing')
  assert.equal(await page.getByRole('columnheader',{name:'Item',exact:true}).count(),1)
  assert.equal(await page.getByRole('columnheader',{name:'Default state',exact:true}).count(),1)
  assert.equal(await page.getByRole('rowheader').count(),21,'Chat renders all 21 expansion rows')
  const savedNothing = page.waitForResponse(response => new URL(response.url()).pathname === '/api/storage/config/ui' && response.request().method() === 'PATCH')
  await page.keyboard.press('Enter')
  await savedNothing
  assert.equal(writes.length,writesBeforeArrow + 1,'only Enter triggered a PATCH after ArrowRight')
  assert.equal(writes.at(-1).settings.toolCallExpansionDefaults.preset,'nothing')
  assert.equal(writes.at(-1).settings.diagnosticsExpansion,'hidden')
  await page.waitForFunction(() => {
    const group = document.querySelector('[role="group"][aria-label="Transcript detail presets"]')
    const btn = group && Array.from(group.querySelectorAll('button')).find(b => b.textContent === 'Nothing')
    return btn?.getAttribute('aria-description') === 'Active'
  })
  assert.equal(await presetButton('Balanced').getAttribute('aria-description'),null)
  // Rune mirrors Select triggers with ARIA role="combobox" in both native AccessKit and browser,
  // exposing the clean label as aria-label and the selected option as textContent.
  const groupsTrigger = page.getByRole('combobox',{name:'Default state for Tool groups',exact:true})
  await groupsTrigger.filter({hasText:/^Collapsed$/}).waitFor({state:'attached'})
  await groupsTrigger.click({force:true})
  const savedGroups = page.waitForResponse(response => new URL(response.url()).pathname === '/api/storage/config/ui' && response.request().method() === 'PATCH')
  const echoGroups = page.waitForResponse(async response => {
    if (new URL(response.url()).pathname !== '/api/storage/config/ui' || response.request().method() !== 'GET') return false
    const body = await response.json().catch(() => null)
    return body?.settings?.toolGroupVisibility === 'hidden'
  })
  await page.getByRole('option',{name:'Disabled',exact:true}).click({force:true})
  await savedGroups
  await echoGroups
  assert.deepEqual(writes.at(-1),{settings:{toolGroupVisibility:'hidden'}})
  await groupsTrigger.filter({hasText:/^Disabled$/}).waitFor({state:'attached'})
  // Concurrent edits on the server before a manual read edit must survive its merge patch.
  transcriptSettings.toolCallExpansionDefaults.tools.skill = 'expanded'
  transcriptSettings.showThinkingBlocks = true
  const readTrigger = page.getByRole('combobox',{name:'Default state for read',exact:true})
  await readTrigger.filter({hasText:/^Hidden$/}).waitFor({state:'attached'})
  await readTrigger.click({force:true})
  const savedRead = page.waitForResponse(response => new URL(response.url()).pathname === '/api/storage/config/ui' && response.request().method() === 'PATCH')
  const echoRead = page.waitForResponse(async response => {
    if (new URL(response.url()).pathname !== '/api/storage/config/ui' || response.request().method() !== 'GET') return false
    const body = await response.json().catch(() => null)
    return body?.settings?.toolCallExpansionDefaults?.tools?.read === 'expanded'
  })
  await page.getByRole('option',{name:'Expanded',exact:true}).click({force:true})
  await savedRead
  await echoRead
  assert.deepEqual(writes.at(-1),{settings:{toolCallExpansionDefaults:{preset:'custom',tools:{read:'expanded'}}}})
  assert.equal(transcriptSettings.toolCallExpansionDefaults.tools.skill,'expanded','concurrent skill edit survived')
  assert.equal(transcriptSettings.showThinkingBlocks,true,'concurrent thinking edit survived')
  const readExpanded = readTrigger.filter({hasText:/^Expanded$/})
  await readExpanded.waitFor({state:'attached'})
  // Wait for the client to finish settling echoRead before opening the picker and arming 503.
  await afterPaint()
  await readExpanded.click({force:true})
  await page.getByRole('option',{name:'Hidden',exact:true}).waitFor({state:'attached'})
  const prefStream = Array.from(streams).find(([client])=>client.endsWith('-preferences'))?.[1]
  assert(prefStream,'Preferences EventSource must be connected')
  failConfigReadOnce = true
  const failedRead = page.waitForResponse(response => new URL(response.url()).pathname === '/api/storage/config/ui' && response.request().method() === 'GET' && response.status() === 503)
  prefStream.write(`data: ${JSON.stringify({type:'storage.configChanged',owner:'ui'})}\n\n`)
  assert.equal((await failedRead).status(),503)
  await page.getByRole('option',{name:'Hidden',exact:true}).waitFor({state:'detached'})
  const settingsDialog = page.getByRole('dialog',{name:'Settings',exact:true})
  await settingsDialog.getByRole('button',{name:'Retry',exact:true}).waitFor({state:'attached'})
  await page.locator('[aria-atomic="true"][aria-live="assertive"]').filter({hasText:'Connection failed'}).waitFor({state:'attached'})
  assert.equal(await presetButton('Nothing').getAttribute('aria-description'),'Disabled')
  const writesDuringOutage = writes.length
  await presetButton('Nothing').click({force:true})
  await afterPaint()
  const disabledRead = readTrigger.filter({hasText:/^Expanded$/})
  assert.equal(await disabledRead.getAttribute('aria-disabled'),'true')
  await disabledRead.click({force:true})
  await afterPaint()
  const recoveredRead = page.waitForResponse(response => new URL(response.url()).pathname === '/api/storage/config/ui' && response.request().method() === 'GET')
  await settingsDialog.getByRole('button',{name:'Retry',exact:true}).click({force:true})
  assert.equal((await recoveredRead).status(),200)
  await settingsDialog.getByRole('button',{name:'Retry',exact:true}).waitFor({state:'detached'})
  await afterPaint()
  assert.equal(writes.length,writesDuringOutage,'Disabled preset and row picker stayed inert through recovery')
  failEverythingOnce = true
  const failedEverything = page.waitForResponse(response => new URL(response.url()).pathname === '/api/storage/config/ui' && response.request().method() === 'PATCH')
  await presetButton('Everything').click({force:true})
  assert.equal((await failedEverything).status(),503)
  await settingsDialog.getByText('Could not save the preference.',{exact:true}).waitFor({state:'attached'})
  await settingsDialog.getByRole('button',{name:'Retry',exact:true}).waitFor({state:'attached'})
  await page.locator('[aria-atomic="true"][aria-live="polite"]').filter({hasText:'Could not save the preference.'}).waitFor({state:'attached'})
  await afterPaint()
  const retriedEverything = page.waitForResponse(response => new URL(response.url()).pathname === '/api/storage/config/ui' && response.request().method() === 'PATCH')
  await settingsDialog.getByRole('button',{name:'Retry',exact:true}).click({force:true})
  assert.equal((await retriedEverything).status(),200)
  assert.equal(writes.at(-1).settings.toolCallExpansionDefaults.preset,'everything')
  assert.equal(writes.at(-1).settings.showThinkingBlocks,true)
  assert.equal(writes.at(-1).settings.showUsageMetrics,true)
  await groupsTrigger.filter({hasText:/^Expanded$/}).waitFor({state:'attached'})
  await settingsDialog.getByRole('button',{name:'Retry',exact:true}).waitFor({state:'detached'})
  await radio('General').click({force:true})
  assert.equal(reads.length,0,'General and Chat do not load the provider catalogue')
  await radio('Providers').click({force:true})
  await visible(account)
  const nonConversation = () => Array.from(streams).find(([client])=>!client.endsWith('-preferences'))?.[1] ?? Array.from(streams.values())[0]
  assert(nonConversation(),'The catalogue has an EventSource without a conversation')
  account = 'default'
  nonConversation().write(`data: ${JSON.stringify({type:'instance.event',instanceId:'catalogue',event:{type:'credential.switched'}})}\n\n`)
  await visible('account@example.test')
  detached = true
  nonConversation().destroy()
  await page.getByText('account@example.test',{exact:true}).waitFor({state:'detached',timeout:15000})
  const atDisconnect = reads.length
  account = 'Reconnected fixture account'
  detached = false
  await visible(account)
  assert.equal(reads.length-atDisconnect,4,'The reconnected catalogue reloads its four source lists once')
  assert(!unexpected.some(entry=>/\/session-history|\/prompt|\/session\//.test(entry)),unexpected.join('\n'))
  memoryEnabled = true
  await radio('General').click({force:true})
  await page.getByRole('button',{name:'Personal memory',exact:true}).waitFor({state:'attached'})
  const tidyButton = page.getByRole('button',{name:'Tidy up',exact:true})
  await tidyButton.and(page.locator(':not([disabled], [aria-disabled="true"])')).waitFor({state:'attached'})
  await click('Tidy up')
  await visible('Review and tidy “About you” in a new project session?')
  assert.equal(cleanupCreates,0,'No session before consent')
  await afterPaint()
  await page.getByRole('button',{name:'Tidy up',exact:true}).last().click({force:true})
  await page.waitForFunction(()=>document.body.innerText.includes('Cleanup could not be confirmed.'))
  assert.equal(cleanupCreates,1)
  if (!loseHeaders) assert.equal(cleanupPrompts,1)
  assert.equal(promptIds.size,1,'Browser transport retries retain the same native inbox identity')
  console.log(JSON.stringify({fixture:'providers-web',contrastSaved:true,defaultPermissionSaved:true,memoryReviewed:true,memoryEdited:true,cleanupCreates,cleanupPrompts,cleanupIdentities:promptIds.size,initialThemeGated:true,updated:true,revokedWhileDisconnected:true,reconnected:true,requests:reads.length}))
  }
} catch (error) {
  console.error(JSON.stringify({opencodeRequests,writes,focus:await page?.evaluate(() => ({
    tag:document.activeElement?.tagName,
    name:document.activeElement?.getAttribute('aria-label'),
    descendant:document.getElementById(document.activeElement?.getAttribute('aria-activedescendant'))?.getAttribute('aria-label'),
  })),mirror:await page?.locator('body').innerText()}))
  throw error
} finally {
  releaseInstall()
  releaseState()
  await browser?.close()
  server.closeAllConnections()
  await new Promise(resolve=>server.close(resolve))
}
