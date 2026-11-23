import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {readFile} from 'node:fs/promises'
import path from 'node:path'
import {chromium} from 'playwright'
import {bundleAssetPaths} from '../../../scripts/rune/web-workspace-policy.mjs'

const bundle = path.resolve(process.argv[2] ?? 'target/rune-web-settings-providers')
const loseHeaders = process.argv.includes('--lost-headers')
const opencodeMode = process.argv.find(arg => arg === '--local-opencode' || arg === '--remote-opencode')
const remoteAccess = process.argv.includes('--remote-access')
const notifications = process.argv.includes('--notifications')
const noDeviceRegistry = process.argv.includes('--no-device-registry')
const local = opencodeMode === '--local-opencode' || remoteAccess
const files = await bundleAssetPaths(bundle)
const directory = '/fixture/project'
const project = {id:'catalogue',path:directory,location:{directory}}
const base = '/workspaces/catalogue/instance/api/'
const streams = new Map()
const unexpected = []
const reads = []
const mime = {'.html':'text/html','.js':'text/javascript','.wasm':'application/wasm','.css':'text/css','.json':'application/json','.woff2':'font/woff2'}
let account = 'First fixture account', detached = false
let contrast = 'on', permissions = 'autonomous'
let notificationRouting, notifyFocused
const writes = []
const memoryRequests = []
const opencodeRequests = []
const logLevelWrites = []
const remoteRequests = []
const directOrigin = 'https://fixture.example:444'
const deviceId = '004633fb-53c4-477c-8b01-4cc5c177724b'
let deviceExists = true
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
let memoryEnabled = false
let releaseState
const stateReady = new Promise(resolve => { releaseState = resolve })
const server = createServer(async (req,res) => {
  const url = new URL(req.url,'http://localhost')
  const p = url.pathname
  const json = value => res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(value))
  try {
    if (p === '/api/meta') return json({apiContract:1,serverId:'fixture-settings',capabilities:['integrations'],localRequest:local})
    if (p === '/api/opencode/update') {
      opencodeRequests.push(`${req.method}${url.search}`)
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
        latestVersion:'2.3.2',updateAvailable:!installed,canUpgrade:!installed,binaryPath:'/fixture/opencode'})
    }
    if (p === '/api/auth/status') return json({authenticated:true})
    if (p.startsWith('/api/remote-control/')) {
      assert(remoteAccess && local)
      remoteRequests.push(`${req.method} ${p.slice('/api/remote-control/'.length)}`)
      if (p === '/api/remote-control/status') {
        return json({manageable:true,enabled:false,state:'stopped',directOrigins:noDeviceRegistry?[]:[directOrigin]})
      }
      if (p === '/api/remote-control/devices') {
        if (noDeviceRegistry) return res.writeHead(501).end()
        return json({devices:deviceExists?[{id:deviceId,name:'Fixture Tablet',lastSeenAt:date}]:[]})
      }
      if (p === '/api/remote-control/pairings') {
        assert.equal(req.method,'POST')
        let body = ''
        for await (const chunk of req) body += chunk
        assert.deepEqual(JSON.parse(body),{origin:directOrigin})
        return json({url:`${directOrigin}/remote-pair#abcdefghijklmnopqrstuv`,expiresAt:new Date(Date.now()+240000).toISOString()})
      }
      assert.equal(p,`/api/remote-control/devices/${deviceId}`)
      assert.equal(req.method,'DELETE')
      deviceExists = false
      return res.writeHead(204).end()
    }
    if (p === '/api/workspaces' && req.method === 'GET') return json([project])
    if (p === '/api/workspaces' && req.method === 'POST') {
      let body = ''
      for await (const chunk of req) body += chunk
      const {path:requested,requestId} = JSON.parse(body)
      assert.equal(requested,directory)
      return json({...project,requestId})
    }
    if (p === '/api/workspaces/catalogue' && req.method === 'DELETE') return res.writeHead(204).end()
    if (p === '/api/events') {
      const client = url.searchParams.get('clientId')
      if (detached && !client.endsWith('-preferences')) return res.writeHead(503).end()
      res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'})
      res.write(': ready\n\n')
      streams.set(client,res)
      res.on('close',()=>{if(streams.get(client)===res) streams.delete(client)})
      return
    }
    if (p === '/api/storage/config/ui') {
      if (req.method === 'PATCH') {
        let body = ''
        for await (const chunk of req) body += chunk
        const patch = JSON.parse(body)
        writes.push(patch)
        contrast = patch.settings.highContrast ?? contrast
        permissions = patch.settings.newConversationPermissions ?? permissions
        if (patch.settings.notificationRouting) {
          notificationRouting ??= {}
          for (const [category, row] of Object.entries(patch.settings.notificationRouting)) {
            notificationRouting[category] = {...notificationRouting[category],...row}
          }
        }
        notifyFocused = patch.settings.osNotificationsAllowWhenVisible ?? notifyFocused
      }
      return json({settings:{locale:'en',highContrast:contrast,newConversationPermissions:permissions,
        notificationRouting,osNotificationsAllowWhenVisible:notifyFocused}})
    }
    if (p === '/api/storage/state/ui') {
      await stateReady
      return json({appearancePreferences:{mode:'light',light:{scheme:{id:'light'}}}})
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
  browser = await chromium.launch({headless:true,executablePath:process.env.CODENOMAD_BROWSER_PATH||undefined,args:['--enable-unsafe-webgpu','--use-angle=swiftshader']})
  page = await browser.newPage({viewport:{width:390,height:844},hasTouch:true,isMobile:true})
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
  const click = name => page.getByRole('button',{name,exact:true}).click({force:true,timeout:15000})
  const afterPaint = () => page.evaluate(() => new Promise(resolve =>
    requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const radio = name => page.getByRole('radio',{name,exact:true})
  const visible = name => page.getByText(name,{exact:true}).waitFor({state:'attached',timeout:15000})
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
  if (notifications) await checkNotifications()
  else if (remoteAccess) await checkRemoteAccess()
  else if (opencodeMode) await checkOpenCode()
  else await checkProviders()

  async function checkNotifications() {
    const stream = Array.from(streams).find(([client])=>!client.endsWith('-preferences'))?.[1]
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
    await radio('Remote Access').click({force:true})
    if (noDeviceRegistry) {
      await visible('Remote Control is off')
      assert.equal(await page.getByRole('heading',{name:'Paired devices',exact:true}).count(),0)
      assert.equal(await page.getByRole('button',{name:'Create HTTPS pairing link',exact:true}).count(),0)
      assert.deepEqual(remoteRequests,['GET status','GET devices'])
      console.log(JSON.stringify({fixture:'remote-access-without-device-registry',remoteRequests}))
      return
    }
    await visible('Fixture Tablet')
    assert.deepEqual(remoteRequests,['GET status','GET devices'])
    assert.equal(await page.getByRole('button',{name:'Start Remote Control',exact:true}).count(),0)
    await click('Create HTTPS pairing link')
    await page.getByRole('button',{name:'Copy link',exact:true}).waitFor({state:'attached'})
    assert.equal(await page.getByText(/abcdefghijklmnopqrstuv/).count(),0)
    assert.deepEqual(remoteRequests,['GET status','GET devices','POST pairings'])
    await page.context().grantPermissions(['clipboard-read','clipboard-write'])
    await click('Copy link')
    await page.waitForFunction(async expected => await navigator.clipboard.readText() === expected,
      `${directOrigin}/remote-pair#abcdefghijklmnopqrstuv`)
    await click('Revoke · Fixture Tablet')
    await visible('No devices are paired yet.')
    assert.deepEqual(remoteRequests,['GET status','GET devices','POST pairings',`DELETE devices/${deviceId}`,'GET status','GET devices'])
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
      await openCode.click({force:true})
      await update.waitFor({state:'attached'})
      assert.deepEqual(opencodeRequests,['GET'])
      const logging = page.getByRole('button',{name:'OpenCode Log Level',exact:true})
      await page.locator('button[aria-description="Debug"]').waitFor({state:'attached'})
      await logging.click({force:true})
      await page.getByRole('option',{name:'Warn',exact:true}).click({force:true})
      await page.locator('button[aria-description="Warn"]').waitFor({state:'attached'})
      assert.deepEqual(logLevelWrites,[{logLevel:'WARN'}])
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
    }
    console.log(JSON.stringify({fixture:'opencode-web',channel:local?'local':'remote',opencodeRequests,logLevelWrites}))
  }

  async function checkProviders() {
  await click('Settings')
  const memory = page.getByRole('switch',{name:'Memory',exact:true})
  await memory.waitFor({state:'attached'})
  assert.equal(await memory.getAttribute('aria-checked'),'false')
  await memory.click({force:true})
  await page.locator('[role="switch"][aria-checked="true"]').waitFor({state:'attached'})
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
  const edit = async (label, value) => {
    for (let i=0; i<24; i++) {
      const field = page.locator('textarea:focus')
      if (await field.count() && await field.getAttribute('aria-label') === label) {
        await field.fill(value)
        return
      }
      await page.keyboard.press('Tab')
      await page.waitForTimeout(20)
    }
    assert.fail(`Missing editable field: ${label}`)
  }
  const editedTitle = 'Edited project memory'
  await edit('Title',editedTitle)
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
  assert.equal(await radio('Off').getAttribute('aria-checked'),'true')
  const permissionTrigger = page.getByRole('button',{name:'New conversation permissions',exact:true})
  assert.equal(await permissionTrigger.getAttribute('aria-description'),'Autonomous')
  await permissionTrigger.click({force:true})
  const savedPermissions = page.waitForResponse(response => new URL(response.url()).pathname === '/api/storage/config/ui' && response.request().method() === 'PATCH')
  await page.getByRole('option',{name:'Supervised',exact:true}).click({force:true})
  await savedPermissions
  assert.deepEqual(writes.at(-1),{settings:{newConversationPermissions:'supervised'}})
  await page.locator('button[aria-description="Supervised"]').waitFor({state:'attached'})
  assert.equal(reads.length,0,'General does not load the provider catalogue')
  await radio('Providers').click({force:true})
  await visible(account)
  const nonConversation = () => Array.from(streams).find(([client])=>!client.endsWith('-preferences'))?.[1]
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
  console.error(JSON.stringify({opencodeRequests,mirror:await page?.locator('body').innerText()}))
  throw error
} finally {
  releaseInstall()
  releaseState()
  await browser?.close()
  server.closeAllConnections()
  await new Promise(resolve=>server.close(resolve))
}
