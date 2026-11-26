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
  openReadyCount,
  cdpEventSourceRequests,
  protocols,
  statuses,
  closedFlags,
  connectionIds,
  expectedActive = 1,
}) {
  assert.equal(constructorCalls, 1, `Expected exactly 1 EventSource constructor call, got ${constructorCalls}`)
  assert.equal(activeCount, expectedActive, `Expected ${expectedActive} active EventSource(s), got ${activeCount}`)
  assert.equal(openReadyCount, expectedActive, `Expected ${expectedActive} OPEN EventSource(s), got ${openReadyCount}`)
  assert.equal(cdpEventSourceRequests, 1, `Expected exactly 1 CDP /api/events request, got ${cdpEventSourceRequests}`)
  assert(Array.isArray(protocols) && protocols.length === 1, `Expected 1 SSE protocol entry, got ${JSON.stringify(protocols)}`)
  assert.equal(protocols[0], 'http/1.1', `Expected HTTP/1.1 on HTTPS /api/events, got ${protocols[0]}`)
  assert(Array.isArray(statuses) && statuses.length === 1, `Expected 1 SSE status entry, got ${JSON.stringify(statuses)}`)
  assert.equal(statuses[0], 200, `Expected HTTP 200 on /api/events, got ${statuses[0]}`)
  assert(Array.isArray(closedFlags) && closedFlags.length === 1, `Expected 1 SSE closed flag, got ${JSON.stringify(closedFlags)}`)
  assert.equal(closedFlags[0], false, `Expected /api/events stream to remain open, got closed=${closedFlags[0]}`)
  const uniqueIds = [...new Set(connectionIds)]
  assert.equal(uniqueIds.length, 1, `Expected 1 shared connectionId, got ${JSON.stringify(uniqueIds)}`)
  assert.equal(uniqueIds[0], 'hub-1', `Expected initial shared hub connectionId hub-1, got ${uniqueIds[0]}`)
  return {
    constructorCalls,
    activeCount,
    openReadyCount,
    cdpEventSourceRequests,
    protocol: protocols[0],
    status: statuses[0],
    closed: closedFlags[0],
    connectionId: uniqueIds[0],
  }
}

export function evaluateConcurrentBatch(results, {expectedCount, wallMs, maxWallMs = 10000}) {
  assert(Array.isArray(results) && results.length === expectedCount, `Expected ${expectedCount} concurrent responses, got ${results?.length}`)
  assert(Number.isFinite(wallMs) && wallMs >= 0 && wallMs <= maxWallMs, `Concurrent HTTP/1.1 batch exceeded ${maxWallMs} ms (${wallMs} ms)`)
  const seenRequestIds = new Set()
  const seenBenchIds = new Set()
  for (const item of results) {
    assert.equal(item.status, 200, `Concurrent request ${item.kind} ${item.workspaceId} returned ${item.status}`)
    assert.equal(item.ok, true, `Concurrent request ${item.kind} ${item.workspaceId} payload invalid`)
    assert(typeof item.benchId === 'string' && item.benchId.length > 0, `Concurrent request ${item.kind} ${item.workspaceId} missing benchId`)
    assert(!seenBenchIds.has(item.benchId), `Duplicate benchId ${item.benchId} in concurrent batch`)
    seenBenchIds.add(item.benchId)
    assert(typeof item.requestId === 'string' && item.requestId.length > 0, `Concurrent request ${item.kind} ${item.workspaceId} missing CDP requestId`)
    assert(!seenRequestIds.has(item.requestId), `Duplicate CDP requestId ${item.requestId} in concurrent batch`)
    seenRequestIds.add(item.requestId)
    assert.equal(item.cdpRedirected, false, `Concurrent request ${item.benchId} unexpectedly redirected`)
    assert.equal(item.cdpDuplicate, false, `Concurrent request ${item.benchId} observed duplicate CDP request`)
    assert.equal(item.cdpResponseCount, 1, `Concurrent request ${item.benchId} observed ${item.cdpResponseCount} CDP responses, expected 1`)
    assert.equal(item.cdpMethod, item.method, `Concurrent request ${item.benchId} CDP method ${item.cdpMethod}, expected ${item.method}`)
    assert.equal(item.cdpPath, item.path, `Concurrent request ${item.benchId} CDP request path ${item.cdpPath}, expected ${item.path}`)
    assert.equal(item.cdpResponsePath, item.path, `Concurrent request ${item.benchId} CDP response path ${item.cdpResponsePath}, expected ${item.path}`)
    assert.equal(item.cdpStatus, 200, `Concurrent request ${item.kind} ${item.workspaceId} CDP status ${item.cdpStatus}, expected 200`)
    assert.equal(item.protocol, 'http/1.1', `Concurrent request ${item.kind} ${item.workspaceId} used ${item.protocol}, expected http/1.1`)
  }
  assert.equal(seenRequestIds.size, expectedCount, `Expected ${expectedCount} distinct CDP requestIds, got ${seenRequestIds.size}`)
  return {
    requestCount: results.length,
    distinctCdpRequests: seenRequestIds.size,
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
  const browserServer = await chromium.launchServer({
    headless: true,
    ...(values.executable ? {executablePath: values.executable} : {}),
    args: ['--enable-unsafe-webgpu', '--use-angle=swiftshader'],
  })
  const browserPid = browserServer.process()?.pid
  if (Number.isInteger(browserPid) && browserPid > 0) {
    await ipc({type: 'browser-pid', pid: browserPid})
  }
  let browser
  const onStopSignal = () => {
    Promise.resolve(browser?.close())
      .catch(() => {})
      .finally(() => browserServer.close().catch(() => {}))
      .finally(() => process.exit(143))
  }
  process.once('SIGTERM', onStopSignal)
  process.once('SIGINT', onStopSignal)

  const errors = []
  const forbidden = []
  const cdpStreams = new Map()
  const cdpSseFrames = []
  const cdpBatchRequests = new Map()
  const cdpRequestIdToBenchId = new Map()
  const openedWorkspaces = []
  let context

  try {
    browser = await chromium.connect(browserServer.wsEndpoint())
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
      const instances = new Set()
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
      globalThis.__runeSse7TabsRead = () => ({
        ...probe,
        openReadyCount: [...instances].filter(es => es.readyState === NativeEventSource.OPEN).length,
      })
      class InstrumentedEventSource extends NativeEventSource {
        constructor(url, init) {
          super(url, init)
          instances.add(this)
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
        if (requested.origin === url.origin) {
          const benchHeader = Object.entries(event.request.headers ?? {}).find(([k]) => k.toLowerCase() === 'x-rune-bench-id')?.[1]
          if (typeof benchHeader === 'string' && benchHeader.length > 0) {
            const existingByBench = cdpBatchRequests.get(benchHeader)
            const existingBenchForReq = cdpRequestIdToBenchId.get(event.requestId)
            if (existingByBench || existingBenchForReq || event.redirectResponse) {
              const target = existingByBench ?? cdpBatchRequests.get(existingBenchForReq)
              if (target) {
                if (event.redirectResponse) target.redirected = true
                if (existingByBench || existingBenchForReq) target.duplicate = true
              } else {
                cdpBatchRequests.set(benchHeader, {
                  requestId: event.requestId,
                  benchId: benchHeader,
                  path: requested.pathname,
                  responsePath: null,
                  method: event.request.method,
                  protocol: null,
                  status: null,
                  redirected: Boolean(event.redirectResponse),
                  duplicate: Boolean(existingByBench || existingBenchForReq),
                  responseCount: 0,
                })
                cdpRequestIdToBenchId.set(event.requestId, benchHeader)
              }
            } else {
              cdpBatchRequests.set(benchHeader, {
                requestId: event.requestId,
                benchId: benchHeader,
                path: requested.pathname,
                responsePath: null,
                method: event.request.method,
                protocol: null,
                status: null,
                redirected: false,
                duplicate: false,
                responseCount: 0,
              })
              cdpRequestIdToBenchId.set(event.requestId, benchHeader)
            }
          }
        }
      } catch {}
    })
    cdp.on('Network.responseReceived', event => {
      const stream = cdpStreams.get(event.requestId)
      if (stream) {
        stream.protocol = event.response.protocol
        stream.status = event.response.status
      }
      const benchId = cdpRequestIdToBenchId.get(event.requestId)
      if (benchId) {
        const entry = cdpBatchRequests.get(benchId)
        if (entry) {
          entry.responseCount += 1
          entry.protocol = event.response.protocol
          entry.status = event.response.status
          try {
            entry.responsePath = new URL(event.response.url).pathname
          } catch {
            entry.responsePath = null
          }
        }
      }
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
        delta: parsed?.event?.data?.delta ?? null,
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
      const pageProbe = await page.evaluate(() => globalThis.__runeSse7TabsRead())
      const streamsList = [...cdpStreams.values()]
      return {
        pageProbe,
        summary: assertSingleMultiplexedSse({
          constructorCalls: pageProbe.constructorCalls,
          activeCount: pageProbe.activeCount,
          openReadyCount: pageProbe.openReadyCount,
          cdpEventSourceRequests: streamsList.length,
          protocols: streamsList.map(s => s.protocol),
          statuses: streamsList.map(s => s.status),
          closedFlags: streamsList.map(s => s.closed),
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
      historyBenchId: `bench-${index * 2}`,
      worktreesBenchId: `bench-${index * 2 + 1}`,
    }))
    const batchStarted = performance.now()
    const rawBatch = await page.evaluate(async targets => {
      const jobs = targets.flatMap(({workspaceId, sessionID, historyBenchId, worktreesBenchId}) => [
        (async () => {
          const t0 = performance.now()
          const res = await fetch(`/api/workspaces/${workspaceId}/session-history/window`, {
            method: 'POST',
            credentials: 'include',
            redirect: 'error',
            headers: {
              'content-type': 'application/json',
              'x-codenomad-user-files': 'reference-v1',
              'x-rune-bench-id': historyBenchId,
            },
            body: JSON.stringify({sessionID, target: {kind: 'latest'}}),
          })
          const body = await res.json()
          return {
            benchId: historyBenchId,
            kind: 'history-window',
            method: 'POST',
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
            redirect: 'error',
            headers: {
              'x-rune-bench-id': worktreesBenchId,
            },
          })
          const body = await res.json()
          return {
            benchId: worktreesBenchId,
            kind: 'worktrees',
            method: 'GET',
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
    const enrichedBatch = rawBatch.map(entry => {
      const cdpEntry = cdpBatchRequests.get(entry.benchId)
      return {
        ...entry,
        requestId: cdpEntry?.requestId ?? null,
        cdpMethod: cdpEntry?.method ?? null,
        cdpPath: cdpEntry?.path ?? null,
        cdpResponsePath: cdpEntry?.responsePath ?? null,
        cdpRedirected: Boolean(cdpEntry?.redirected),
        cdpDuplicate: Boolean(cdpEntry?.duplicate),
        cdpResponseCount: cdpEntry?.responseCount ?? 0,
        cdpStatus: cdpEntry?.status ?? null,
        protocol: cdpEntry?.protocol ?? null,
      }
    })
    const concurrentBatch = evaluateConcurrentBatch(enrichedBatch, {
      expectedCount: TAB_COUNT * 2,
      wallMs: batchWallMs,
      maxWallMs: 10000,
    })
    await readSseState(1)

    // Verify live multiplexed SSE delivery across active and hidden tabs through the single EventSource.
    const sseRequestId = [...cdpStreams.keys()][0]
    const initialTargets = [
      {tabIndex: 6, workspaceId: openedWorkspaces[6], sessionID: 'ses_tab_7', text: 'Multiplex live Tab 7'},
      {tabIndex: 0, workspaceId: openedWorkspaces[0], sessionID: 'ses_tab_1', text: 'Multiplex live Tab 1'},
      {tabIndex: 3, workspaceId: openedWorkspaces[3], sessionID: 'ses_tab_4', text: 'Multiplex live Tab 4'},
    ]
    await ipc({
      type: 'emit-multiplex-sse',
      targets: initialTargets.map(({sessionID, text}) => ({sessionID, text})),
    })
    await page.waitForFunction(() => (document.querySelector('[data-rune-a11y]')?.textContent ?? '').includes('Multiplex live Tab 7'))

    const waitMultiplexFrames = async (targets, workspaces) => {
      const expectedTriples = workspaces.flatMap(workspaceId =>
        targets.map(({sessionID, text}) => ({workspaceId, sessionID, text})),
      )
      const deadline = Date.now() + 10000
      while (Date.now() < deadline) {
        const matchedTriples = expectedTriples.filter(triple => cdpSseFrames.some(f =>
          f.requestId === sseRequestId
          && f.nativeType === 'session.text.delta'
          && f.instanceId === triple.workspaceId
          && f.sessionID === triple.sessionID
          && f.delta === triple.text,
        ))
        if (matchedTriples.length === expectedTriples.length) {
          return {
            frameCount: matchedTriples.length,
            expectedTripleCount: expectedTriples.length,
            matchedPairs: targets.map(({workspaceId, sessionID, text}) => ({workspaceId, sessionID, text})),
            workspaceCount: workspaces.length,
          }
        }
        await page.waitForTimeout(25)
      }
      throw Error(`Timed out waiting for all ${expectedTriples.length} multiplexed SSE (workspaceId, sessionID, delta) triples on ${sseRequestId}`)
    }
    const multiplexedFrames = await waitMultiplexFrames(initialTargets, openedWorkspaces)

    const waitExactFrame = async ({workspaceId, sessionID, text}) => {
      const deadline = Date.now() + 10000
      while (Date.now() < deadline) {
        const hit = cdpSseFrames.find(f =>
          f.requestId === sseRequestId
          && f.nativeType === 'session.text.delta'
          && f.instanceId === workspaceId
          && f.sessionID === sessionID
          && f.delta === text,
        )
        if (hit) return hit
        await page.waitForTimeout(25)
      }
      throw Error(`Timed out waiting for exact SSE frame (${workspaceId}, ${sessionID}, ${text}) on ${sseRequestId}`)
    }

    // Inactive tabs intentionally suspend live transcript readers (`chat::suspend` -> `stop_content()`)
    // and resume on activation (`chat::resume`) over the same shared EventHub without opening a new
    // EventSource. Wait for the resumed history window on Tabs 1 and 4, confirm the delta emitted
    // while suspended is absent from the re-synced transcript, then emit a fresh SSE-only delta
    // and verify exact delivery on `sseRequestId` plus live UI rendering.
    const tabsLocator = projectTabs()
    const verifyActivatedTab = async ({tabIndex, workspaceId, sessionID, heading, initialHistory, suspendedText, activeText}) => {
      const resumeResponse = page.waitForResponse(res =>
        res.request().method() === 'POST'
        && new URL(res.url()).pathname === `/api/workspaces/${workspaceId}/session-history/window`
        && res.status() === 200,
      )
      await press(tabsLocator.nth(tabIndex))
      await resumeResponse
      await mirror().getByRole('heading', {name: heading, exact: true}).waitFor({state: 'attached'})
      await page.waitForFunction(
        expected => (document.querySelector('[data-rune-a11y]')?.textContent ?? '').includes(expected),
        initialHistory,
      )
      const beforeActive = await page.evaluate(() => document.querySelector('[data-rune-a11y]')?.textContent ?? '')
      assert(!beforeActive.includes(suspendedText), `Suspended tab ${sessionID} must not retain live-only delta "${suspendedText}" after chat::resume`)
      await ipc({type: 'emit-multiplex-sse', targets: [{sessionID, text: activeText}]})
      await waitExactFrame({workspaceId, sessionID, text: activeText})
      await page.waitForFunction(
        expected => (document.querySelector('[data-rune-a11y]')?.textContent ?? '').includes(expected),
        activeText,
      )
      return {workspaceId, sessionID, text: activeText, suspendedDeltaAbsentAfterResume: true}
    }

    const tab1Active = await verifyActivatedTab({
      tabIndex: 0,
      workspaceId: openedWorkspaces[0],
      sessionID: 'ses_tab_1',
      heading: 'Tab 1 session',
      initialHistory: 'Tab 1 initial history',
      suspendedText: 'Multiplex live Tab 1',
      activeText: 'Multiplex live Tab 1 active',
    })
    const tab4Active = await verifyActivatedTab({
      tabIndex: 3,
      workspaceId: openedWorkspaces[3],
      sessionID: 'ses_tab_4',
      heading: 'Tab 4 session',
      initialHistory: 'Tab 4 initial history',
      suspendedText: 'Multiplex live Tab 4',
      activeText: 'Multiplex live Tab 4 active',
    })

    multiplexedFrames.activeTabChecks = [
      {workspaceId: openedWorkspaces[6], sessionID: 'ses_tab_7', text: 'Multiplex live Tab 7'},
      tab1Active,
      tab4Active,
    ]

    const sseAfterMultiplex = await readSseState(1)

    // Close 6 tabs via the real UI close buttons (always from index 0, inside the visible strip)
    // and confirm the single EventSource stays steady and only the surviving tab's workspace remains.
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
    const survivingWorkspaceId = openedWorkspaces[TAB_COUNT - 1]
    let workspacesAfterClosingSixTabs = []
    const sixCloseDeadline = Date.now() + 10000
    while (Date.now() < sixCloseDeadline) {
      workspacesAfterClosingSixTabs = await ipc({type: 'server-workspaces'})
      if (workspacesAfterClosingSixTabs.length === 1 && workspacesAfterClosingSixTabs[0]?.id === survivingWorkspaceId) break
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    assert.equal(
      workspacesAfterClosingSixTabs.length,
      1,
      `Expected 1 surviving workspace after closing 6 tabs, got ${JSON.stringify(workspacesAfterClosingSixTabs.map(w => w.id))}`,
    )
    assert.equal(
      workspacesAfterClosingSixTabs[0]?.id,
      survivingWorkspaceId,
      `Expected surviving workspace ${survivingWorkspaceId}, got ${workspacesAfterClosingSixTabs[0]?.id}`,
    )

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
        workspacesAfterClosingSixTabs: workspacesAfterClosingSixTabs.map(w => w.id),
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
    process.off('SIGTERM', onStopSignal)
    process.off('SIGINT', onStopSignal)
    await context?.close().catch(() => {})
    await browser?.close().catch(() => {})
    await browserServer.close().catch(() => {})
    if (Number.isInteger(browserPid) && browserPid > 0 && process.connected) {
      await ipc({type: 'browser-closed', pid: browserPid}).catch(() => {})
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runBench()
}
