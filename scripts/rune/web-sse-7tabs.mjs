// 7-tab HTTPS HTTP/1.1 SSE multiplexing bench for the real Rune WASM bundle (B1 proof).
import assert from 'node:assert/strict'
import {mkdir, readFile, realpath, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {parseArgs} from 'node:util'
import {chromium} from 'playwright'
import {bundleAssetPaths, fulfillWorkspaceCreation, privateWebFixture, workspacePolicy} from './web-workspace-policy.mjs'

const TAB_COUNT = 7
const TAB_SESSION_RE = /^ses_tab_[1-7]$/

export function summarizeLatencies(samplesMs) {
  assert(Array.isArray(samplesMs) && samplesMs.length > 0, 'Expected non-empty latency samples')
  const sorted = [...samplesMs].map(v => {
    assert(Number.isFinite(v) && v >= 0, `Invalid latency sample: ${v}`)
    return v
  }).sort((a, b) => a - b)
  const at = p => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))]
  const totalMs = sorted.reduce((sum, v) => sum + v, 0)
  return {
    count: sorted.length,
    minMs: Math.round(sorted[0] * 10) / 10,
    medianMs: Math.round(at(0.5) * 10) / 10,
    p95Ms: Math.round(at(0.95) * 10) / 10,
    maxMs: Math.round(sorted.at(-1) * 10) / 10,
    totalMs: Math.round(totalMs * 10) / 10,
  }
}

export function assertSingleMultiplexedSse({
  constructorCalls,
  activeCount,
  cdpEventSourceRequests,
  protocols,
  connectionIds,
  expectedActive = 1,
}) {
  assert.equal(constructorCalls, 1, `Expected exactly 1 EventSource constructor call, got ${constructorCalls}`)
  assert.equal(activeCount, expectedActive, `Expected ${expectedActive} active EventSource(s), got ${activeCount}`)
  assert.equal(cdpEventSourceRequests, 1, `Expected exactly 1 CDP /api/events request, got ${cdpEventSourceRequests}`)
  assert(Array.isArray(protocols) && protocols.length === 1, `Expected 1 SSE protocol entry, got ${JSON.stringify(protocols)}`)
  assert.equal(protocols[0], 'http/1.1', `Expected HTTP/1.1 on HTTPS /api/events, got ${protocols[0]}`)
  const uniqueIds = [...new Set(connectionIds)]
  assert.equal(uniqueIds.length, 1, `Expected 1 shared connectionId, got ${JSON.stringify(uniqueIds)}`)
  assert.match(uniqueIds[0], /^hub-\d+$/, `Expected shared hub connectionId, got ${uniqueIds[0]}`)
  return {
    constructorCalls,
    activeCount,
    cdpEventSourceRequests,
    protocol: protocols[0],
    connectionId: uniqueIds[0],
  }
}

export function evaluateConcurrentBatch(results, {expectedCount, wallMs, maxWallMs = 10000}) {
  assert(Array.isArray(results) && results.length === expectedCount, `Expected ${expectedCount} concurrent responses, got ${results?.length}`)
  assert(Number.isFinite(wallMs) && wallMs >= 0 && wallMs <= maxWallMs, `Concurrent HTTP/1.1 batch exceeded ${maxWallMs} ms (${wallMs} ms)`)
  for (const item of results) {
    assert.equal(item.status, 200, `Concurrent request ${item.kind} ${item.workspaceId} returned ${item.status}`)
    assert.equal(item.ok, true, `Concurrent request ${item.kind} ${item.workspaceId} payload invalid`)
    if (item.protocol !== undefined) {
      assert.equal(item.protocol, 'http/1.1', `Concurrent request ${item.kind} ${item.workspaceId} used ${item.protocol}, expected http/1.1`)
    }
  }
  return {
    requestCount: results.length,
    wallMs: Math.round(wallMs * 10) / 10,
    latencies: summarizeLatencies(results.map(r => r.durationMs)),
  }
}

export function allowBenchOwnedRoute({method, path: subPath, body, native}) {
  if (native && method === 'GET') {
    return /^(command|model|session)$/.test(subPath)
      || /^session\/ses_tab_[1-7](?:\/(permission|form))?$/.test(subPath)
  }
  if (!native && method === 'GET') {
    return subPath === 'worktrees'
      || /^sessions\/ses_tab_[1-7]\/permission-(?:mode|receipts)$/.test(subPath)
  }
  if (!native && method === 'POST' && ['session-history/window', 'session-history/outline'].includes(subPath)) {
    return typeof body?.sessionID === 'string' && TAB_SESSION_RE.test(body.sessionID)
  }
  return false
}

function ipc(action) {
  assert(typeof process.send === 'function', 'Run web-sse-7tabs.mjs through launcher-fixture.mjs --web-sse-7tabs')
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(Error(`No fixture IPC reply for ${action?.type ?? String(action)}`))
    }, 15000)
    const onMessage = ({value, error}) => {
      cleanup()
      if (error) reject(Error(error))
      else resolve(value)
    }
    const onDisconnect = () => {
      cleanup()
      reject(Error('Fixture IPC disconnected before reply'))
    }
    const cleanup = () => {
      clearTimeout(timer)
      process.off('message', onMessage)
      process.off('disconnect', onDisconnect)
    }
    process.once('message', onMessage)
    process.once('disconnect', onDisconnect)
    process.send(action)
  })
}

async function runBench() {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const {values} = parseArgs({
    options: {
      url: {type: 'string'},
      project: {type: 'string'},
      'storage-state': {type: 'string'},
      out: {type: 'string'},
      executable: {type: 'string'},
    },
  })
  assert(values.url && values.project && values['storage-state'] && values.out, 'Pass --url --project --storage-state --out')
  const url = new URL(values.url)
  assert.equal(url.protocol, 'https:', '7-tab SSE bench requires HTTPS HTTP/1.1')
  assert(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && !url.username && !url.password && url.pathname === '/' && !url.hash, 'Explicit isolated loopback HTTPS root required')
  url.search = '?locale=fr'

  const out = path.resolve(values.out)
  const {profile, storage, inside} = await privateWebFixture({
    root,
    project: values.project,
    storageState: values['storage-state'],
    out,
    origin: url.origin,
  })
  await mkdir(out, {recursive: true})
  assert(inside(profile, await realpath(out)), 'Output path escapes fixture profile')

  const m = JSON.parse(await readFile(path.join(root, 'crates/rune-theme-codenomad/assets/catalogues/fr.json'), 'utf8'))
  const assets = await bundleAssetPaths(path.resolve(root, process.env.RUNE_WEB_DIR ?? 'target/rune-web-connected'))
  const browser = await chromium.launch({
    headless: true,
    ...(values.executable ? {executablePath: values.executable} : {}),
    args: ['--enable-unsafe-webgpu', '--use-angle=swiftshader'],
  })

  const errors = []
  const forbidden = []
  const cdpStreams = new Map()
  const cdpSseFrames = []
  const cdpProtocols = new Map()
  const openedWorkspaces = []
  let context

  try {
    const policy = workspacePolicy({
      origin: url.origin,
      project: values.project,
      assets,
      allowOwned: allowBenchOwnedRoute,
    })
    context = await browser.newContext({
      viewport: {width: 1400, height: 900},
      deviceScaleFactor: 1,
      colorScheme: 'light',
      ignoreHTTPSErrors: true,
      storageState: storage,
    })
    const page = await context.newPage()
    page.setDefaultTimeout(20000)

    await page.addInitScript(() => {
      const NativeEventSource = globalThis.EventSource
      const probe = {
        constructorCalls: 0,
        activeCount: 0,
        closedCount: 0,
        openEvents: 0,
        errorEvents: 0,
        messageCount: 0,
        urls: [],
        connectionIds: [],
      }
      globalThis.__runeSse7TabsProbe = probe
      class InstrumentedEventSource extends NativeEventSource {
        constructor(url, init) {
          super(url, init)
          probe.constructorCalls += 1
          probe.activeCount += 1
          const parsed = new URL(String(url), location.href)
          probe.urls.push(parsed.pathname + parsed.search)
          probe.connectionIds.push(parsed.searchParams.get('connectionId') ?? '')
          this.__probeClosed = false
          this.addEventListener('open', () => { probe.openEvents += 1 })
          this.addEventListener('error', () => { probe.errorEvents += 1 })
          this.addEventListener('message', () => { probe.messageCount += 1 })
        }
        close() {
          if (!this.__probeClosed) {
            this.__probeClosed = true
            probe.closedCount += 1
            probe.activeCount = Math.max(0, probe.activeCount - 1)
          }
          return super.close()
        }
      }
      globalThis.EventSource = InstrumentedEventSource
    })

    page.on('pageerror', error => errors.push({name: error.name, message: error.message.slice(0, 240)}))

    const cdp = await context.newCDPSession(page)
    await cdp.send('Network.enable')
    cdp.on('Network.requestWillBeSent', event => {
      try {
        const requested = new URL(event.request.url)
        if (requested.origin === url.origin && requested.pathname === '/api/events') {
          cdpStreams.set(event.requestId, {
            requestId: event.requestId,
            url: requested.pathname + requested.search,
            clientId: requested.searchParams.get('clientId') ?? '',
            connectionId: requested.searchParams.get('connectionId') ?? '',
            protocol: null,
            status: null,
            closed: false,
            closeReason: null,
          })
        }
      } catch {}
    })
    cdp.on('Network.responseReceived', event => {
      const stream = cdpStreams.get(event.requestId)
      if (stream) {
        stream.protocol = event.response.protocol
        stream.status = event.response.status
      }
      try {
        const requested = new URL(event.response.url)
        if (requested.origin === url.origin) {
          const list = cdpProtocols.get(requested.pathname) ?? []
          list.push(event.response.protocol)
          cdpProtocols.set(requested.pathname, list)
        }
      } catch {}
    })
    cdp.on('Network.loadingFinished', event => {
      const stream = cdpStreams.get(event.requestId)
      if (stream) {
        stream.closed = true
        stream.closeReason = 'finished'
      }
    })
    cdp.on('Network.loadingFailed', event => {
      const stream = cdpStreams.get(event.requestId)
      if (stream) {
        stream.closed = true
        stream.closeReason = event.canceled ? 'canceled' : (event.errorText || 'failed')
      }
    })
    cdp.on('Network.eventSourceMessageReceived', event => {
      if (cdpSseFrames.length >= 2048) return
      let parsed
      try { parsed = JSON.parse(event.data) } catch {}
      cdpSseFrames.push({
        requestId: event.requestId,
        type: parsed?.type ?? event.eventName,
        instanceId: parsed?.instanceId ?? null,
        nativeType: parsed?.event?.type ?? null,
        sessionID: parsed?.event?.data?.sessionID ?? null,
      })
    })

    await context.route('**/*', async route => {
      const req = route.request()
      const requested = new URL(req.url())
      const allowed = await policy.request(req)
      if (!allowed) {
        forbidden.push({method: req.method(), path: requested.pathname, url: req.url()})
        return route.abort('blockedbyclient')
      }
      if (req.method() === 'POST' && requested.pathname === '/api/workspaces') {
        const created = await fulfillWorkspaceCreation(route, policy)
        if (created?.workspaceId) openedWorkspaces.push(created.workspaceId)
        return
      }
      await route.continue()
    })

    const mirror = () => page.locator('[data-rune-a11y]')
    const button = name => mirror().getByRole('button', {name, exact: true})
    const press = async locator => {
      await locator.waitFor({state: 'attached'})
      for (const until = Date.now() + 20000; await locator.evaluate(el => el.disabled || el.getAttribute('aria-disabled') === 'true');) {
        assert(Date.now() < until, 'Control remained disabled')
        await page.waitForTimeout(20)
      }
      await locator.click({force: true})
    }
    const typeField = async (label, value) => {
      const box = mirror().getByRole('textbox', {name: label, exact: true})
      await press(box)
      const editor = page.locator('textarea:focus,input:focus').first()
      await editor.waitFor({state: 'attached'})
      await editor.fill(value)
    }
    const leftLabel = m['window.menu.leftPanel']
    const sessionsRegion = mirror().getByRole('region', {name: leftLabel, exact: true})
    const openSessions = async () => {
      await button(leftLabel).waitFor({state: 'attached'})
      await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))
      if (await button(leftLabel).getAttribute('aria-expanded') !== 'true') {
        await press(button(leftLabel))
      }
      await sessionsRegion.waitFor({state: 'attached'})
    }

    await page.goto(url.href, {waitUntil: 'domcontentloaded', timeout: 60000})
    await page.waitForFunction(() => ['ready', 'failed'].includes(globalThis.__codenomadRuneBoot?.state), undefined, {timeout: 60000})
    assert.equal(await page.evaluate(() => globalThis.__codenomadRuneBoot.state), 'ready')
    await press(button(m['folderSelection.servers.dialog.connect']))

    const tabOpenDurationsMs = []
    for (let i = 1; i <= TAB_COUNT; i++) {
      const started = performance.now()
      if (i > 1) {
        await press(button(m['instanceTabs.new.ariaLabel']))
      }
      await typeField(m['instanceInfo.labels.folder'], values.project)
      await page.keyboard.press('Enter')
      await openSessions()
      await press(sessionsRegion.getByRole('listitem', {name: `Tab ${i} session`, exact: true}))
      await mirror().getByRole('heading', {name: `Tab ${i} session`, exact: true}).waitFor({state: 'attached'})
      await page.waitForFunction(
        expected => (document.querySelector('[data-rune-a11y]')?.textContent ?? '').includes(expected),
        `Tab ${i} initial history`,
      )
      tabOpenDurationsMs.push(Math.round((performance.now() - started) * 10) / 10)
    }

    const projectTabs = () => mirror().getByRole('tab', {name: values.project, exact: true})
    const tabCount = await projectTabs().count()
    assert.equal(tabCount, TAB_COUNT, `Expected ${TAB_COUNT} open project tabs, got ${tabCount}`)
    assert.equal(policy.workspaces.size, TAB_COUNT, `Expected ${TAB_COUNT} distinct workspaces, got ${policy.workspaces.size}`)
    assert.equal(openedWorkspaces.length, TAB_COUNT, `Expected ${TAB_COUNT} workspace creations, got ${openedWorkspaces.length}`)

    const serverWorkspaces = await ipc({type: 'server-workspaces'})
    assert.equal(serverWorkspaces.length, TAB_COUNT, `Server reported ${serverWorkspaces.length} workspaces, expected ${TAB_COUNT}`)
    for (const id of openedWorkspaces) {
      assert(serverWorkspaces.some(w => w.id === id), `Workspace ${id} missing from Rust server inventory`)
    }

    const readSseState = async (expectedActive = 1) => {
      const pageProbe = await page.evaluate(() => ({...globalThis.__runeSse7TabsProbe}))
      const streamsList = [...cdpStreams.values()]
      return {
        pageProbe,
        summary: assertSingleMultiplexedSse({
          constructorCalls: pageProbe.constructorCalls,
          activeCount: pageProbe.activeCount,
          cdpEventSourceRequests: streamsList.length,
          protocols: streamsList.map(s => s.protocol),
          connectionIds: streamsList.map(s => s.connectionId),
          expectedActive,
        }),
      }
    }

    const sseAtSevenTabs = await readSseState(1)
    const sseStreamInfo = [...cdpStreams.values()][0]
    assert(sseStreamInfo.clientId && sseStreamInfo.connectionId, `Missing SSE identity: ${JSON.stringify(sseStreamInfo)}`)
    const pongBeforeClose = await context.request.post(`${url.origin}/api/client-connections/pong`, {
      headers: {origin: url.origin},
      data: {clientId: sseStreamInfo.clientId, connectionId: sseStreamInfo.connectionId},
    })
    assert.equal(pongBeforeClose.status(), 204, `Expected server pong 204 while EventSource is active, got ${pongBeforeClose.status()}`)

    // Fire 14 concurrent HTTPS HTTP/1.1 requests (2 per open tab/workspace) while the 1 EventSource stays open.
    const batchTargets = openedWorkspaces.map((workspaceId, index) => ({
      workspaceId,
      sessionID: `ses_tab_${index + 1}`,
    }))
    const batchStarted = performance.now()
    const rawBatch = await page.evaluate(async targets => {
      const jobs = targets.flatMap(({workspaceId, sessionID}) => [
        (async () => {
          const t0 = performance.now()
          const res = await fetch(`/api/workspaces/${workspaceId}/session-history/window`, {
            method: 'POST',
            credentials: 'include',
            headers: {
              'content-type': 'application/json',
              'x-codenomad-user-files': 'reference-v1',
            },
            body: JSON.stringify({sessionID, target: {kind: 'latest'}}),
          })
          const body = await res.json()
          return {
            kind: 'history-window',
            workspaceId,
            sessionID,
            path: `/api/workspaces/${workspaceId}/session-history/window`,
            status: res.status,
            ok: res.ok && body?.status === 'window',
            durationMs: performance.now() - t0,
          }
        })(),
        (async () => {
          const t0 = performance.now()
          const res = await fetch(`/api/workspaces/${workspaceId}/worktrees`, {
            method: 'GET',
            credentials: 'include',
          })
          const body = await res.json()
          return {
            kind: 'worktrees',
            workspaceId,
            sessionID,
            path: `/api/workspaces/${workspaceId}/worktrees`,
            status: res.status,
            ok: res.ok && Array.isArray(body?.worktrees ?? body),
            durationMs: performance.now() - t0,
          }
        })(),
      ])
      return await Promise.all(jobs)
    }, batchTargets)
    const batchWallMs = performance.now() - batchStarted
    const enrichedBatch = rawBatch.map(entry => ({
      ...entry,
      protocol: cdpProtocols.get(entry.path)?.at(-1) ?? 'unknown',
    }))
    const concurrentBatch = evaluateConcurrentBatch(enrichedBatch, {
      expectedCount: TAB_COUNT * 2,
      wallMs: batchWallMs,
      maxWallMs: 10000,
    })
    await readSseState(1)

    // Verify live multiplexed SSE delivery across multiple tabs through the single EventSource.
    const sseRequestId = [...cdpStreams.keys()][0]
    await ipc({
      type: 'emit-multiplex-sse',
      targets: [
        {sessionID: 'ses_tab_7', text: 'Multiplex live Tab 7'},
        {sessionID: 'ses_tab_1', text: 'Multiplex live Tab 1'},
        {sessionID: 'ses_tab_4', text: 'Multiplex live Tab 4'},
      ],
    })
    await page.waitForFunction(() => (document.querySelector('[data-rune-a11y]')?.textContent ?? '').includes('Multiplex live Tab 7'))

    const waitMultiplexFrames = async expectedSessions => {
      const deadline = Date.now() + 10000
      while (Date.now() < deadline) {
        const matched = cdpSseFrames.filter(f =>
          f.requestId === sseRequestId
          && f.nativeType === 'session.text.delta'
          && expectedSessions.includes(f.sessionID),
        )
        const distinctSessions = new Set(matched.map(f => f.sessionID))
        const distinctWorkspaces = new Set(matched.map(f => f.instanceId).filter(Boolean))
        if (distinctSessions.size === expectedSessions.length && distinctWorkspaces.size === TAB_COUNT) {
          return {
            frameCount: matched.length,
            sessions: [...distinctSessions].sort(),
            workspaceCount: distinctWorkspaces.size,
          }
        }
        await page.waitForTimeout(25)
      }
      throw Error(`Timed out waiting for multiplexed SSE frames across ${TAB_COUNT} workspaces`)
    }
    const multiplexedFrames = await waitMultiplexFrames(['ses_tab_1', 'ses_tab_4', 'ses_tab_7'])

    // Switch to Tab 1 and Tab 4 and verify live SSE rendering on each without opening any new EventSource.
    const tabsLocator = projectTabs()
    await press(tabsLocator.nth(0))
    await mirror().getByRole('heading', {name: 'Tab 1 session', exact: true}).waitFor({state: 'attached'})
    await ipc({type: 'emit-multiplex-sse', targets: [{sessionID: 'ses_tab_1', text: 'Multiplex live Tab 1 active'}]})
    await page.waitForFunction(() => (document.querySelector('[data-rune-a11y]')?.textContent ?? '').includes('Multiplex live Tab 1 active'))

    await press(tabsLocator.nth(3))
    await mirror().getByRole('heading', {name: 'Tab 4 session', exact: true}).waitFor({state: 'attached'})
    await ipc({type: 'emit-multiplex-sse', targets: [{sessionID: 'ses_tab_4', text: 'Multiplex live Tab 4 active'}]})
    await page.waitForFunction(() => (document.querySelector('[data-rune-a11y]')?.textContent ?? '').includes('Multiplex live Tab 4 active'))

    const sseAfterMultiplex = await readSseState(1)

    // Close 6 tabs via the real UI close buttons (always from index 0, inside the visible strip)
    // and confirm the single EventSource stays steady (no leak/churn).
    const closeLabel = m['instanceTab.actions.close.ariaLabel']
    for (let remaining = TAB_COUNT; remaining > 1; remaining--) {
      const closeButtons = mirror().getByRole('button', {name: closeLabel, exact: true})
      assert.equal(await closeButtons.count(), remaining, `Expected ${remaining} tab close buttons`)
      await press(closeButtons.first())
      const tabCloseDeadline = Date.now() + 10000
      while (await projectTabs().count() !== remaining - 1) {
        assert(
          Date.now() < tabCloseDeadline,
          `Expected ${remaining - 1} project tabs after close, got ${await projectTabs().count()}`,
        )
        await page.waitForTimeout(25)
      }
    }
    const sseAfterClosingSixTabs = await readSseState(1)

    // Navigate away + close the page to trigger real pagehide cleanup and verify server-side
    // EventSource teardown (pong 204 -> 404) and zero leaked workspaces.
    await page.goto('about:blank', {waitUntil: 'load'})
    await page.close()
    const closeDeadline = Date.now() + 10000
    let pongAfterCloseStatus = 0
    let remainingWorkspaces = []
    while (Date.now() < closeDeadline) {
      const pongRes = await context.request.post(`${url.origin}/api/client-connections/pong`, {
        headers: {origin: url.origin},
        data: {clientId: sseStreamInfo.clientId, connectionId: sseStreamInfo.connectionId},
      })
      pongAfterCloseStatus = pongRes.status()
      remainingWorkspaces = await ipc({type: 'server-workspaces'})
      if (pongAfterCloseStatus === 404 && remainingWorkspaces.length === 0) break
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    const finalStream = cdpStreams.get(sseRequestId)
    assert.equal(pongAfterCloseStatus, 404, `Expected server pong 404 after page close (zero EventSource leak), got ${pongAfterCloseStatus}`)
    assert.equal(cdpStreams.size, 1, `Expected only 1 EventSource throughout full lifecycle, got ${cdpStreams.size}`)
    assert.equal(remainingWorkspaces.length, 0, `Expected 0 leaked workspaces after pagehide, got ${remainingWorkspaces.length}`)
    assert.deepEqual(errors, [], `Unexpected page errors: ${JSON.stringify(errors)}`)
    assert.deepEqual(forbidden, [], `Unexpected forbidden requests: ${JSON.stringify(forbidden)}`)

    const proof = {
      runner: 'web-sse-7tabs',
      origin: url.origin,
      tabCount: TAB_COUNT,
      workspaceCount: openedWorkspaces.length,
      tabOpenLatencies: summarizeLatencies(tabOpenDurationsMs),
      sseAtSevenTabs: sseAtSevenTabs.summary,
      sseAfterMultiplex: sseAfterMultiplex.summary,
      sseAfterClosingSixTabs: sseAfterClosingSixTabs.summary,
      pageProbeAfterMultiplex: sseAfterMultiplex.pageProbe,
      concurrentBatch,
      multiplexedFrames,
      teardown: {
        cdpEventSourceCount: cdpStreams.size,
        serverPongBeforeCloseStatus: pongBeforeClose.status(),
        serverPongAfterCloseStatus: pongAfterCloseStatus,
        cdpStreamClosed: Boolean(finalStream?.closed),
        cdpCloseReason: finalStream?.closeReason ?? null,
        remainingWorkspaces: remainingWorkspaces.length,
      },
      errors,
      forbidden,
      result: 'pass',
    }
    await writeFile(path.join(out, 'sse-7tabs-proof.json'), JSON.stringify(proof, null, 2))
    console.log(JSON.stringify(proof))
  } catch (error) {
    await writeFile(path.join(out, 'sse-7tabs-failure.json'), JSON.stringify({
      error: String(error?.stack ?? error),
      cdpStreams: [...cdpStreams.values()],
      openedWorkspaces,
      errors,
      forbidden,
    }, null, 2)).catch(() => {})
    throw error
  } finally {
    await context?.close().catch(() => {})
    await browser.close().catch(() => {})
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runBench()
}
