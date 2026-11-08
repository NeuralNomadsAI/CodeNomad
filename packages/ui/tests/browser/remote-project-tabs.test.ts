import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"
import { borrowFixture } from "./fixture-borrow"
import { chromium, type Browser, type Locator, type Page } from "playwright"
import { mkdir } from "node:fs/promises"

const SEPARATION_NOW = Date.UTC(2026, 10, 7, 12)
const RECENT_TIME = SEPARATION_NOW - 60_000

// The real application (src/main.tsx) in three roles: the page a remote server
// serves inside a host tab (?codenomadEmbed=project), a web or Remote Control
// client, and a local Electron window hosting remote project tabs.
let browser: Browser, url: string
before(async () => {
  const fixture = await borrowFixture({
    name: "remote-project-tabs",
    routes: [{ path: "/fixture", html: "<html><body><div id=\"root\"></div><script type=\"module\" src=\"/src/main.tsx\"></script></body></html>" }],
  })
  url = fixture.url
  browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
})
after(async () => { await browser?.close() })

test('blank: server recents replace only the left source; folders navigate on the right and Back restores host recents', async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, locale: 'en-US' })
  try {
    await page.clock.setFixedTime(SEPARATION_NOW)
    const fixture = await open(page, '', { context: 'local', host: 'electron', remoteNeedsPassword: true,
      uiState: { remoteServers: [server('box')], recentFolders: [{ path: '/local', projectName: 'Host recent', lastAccessed: RECENT_TIME }] },
      sidecars: [sidecar('docs', 'Docs', 'running')] })
    await browse(page)
    await page.locator('[data-sidecar="docs"]').click()
    await page.locator('.new-instance-button').click()
    const blank = page.locator('[data-tab-kind="blank"][data-tab-visible="true"]')
    const left = blank.locator('.folder-home-list-column')
    const right = blank.locator('.folder-dashboard-servers')
    await left.getByRole('button', { name: 'Host recent · This computer · /local', exact: true }).waitFor()
    await capture(page, 'separated-newtab-initial')
    await right.getByRole('button', { name: 'Open a project on Box' }).click()
    await right.locator('input[type=password]').waitFor()
    assert.equal(await left.locator('.folder-home-recent-item').count(), 0)
    assert.equal(await left.locator('.panel-subtitle').count(), 0)
    assert.equal(await left.getByText('No recent projects yet.', { exact: true }).count(), 0)
    await left.getByText('Box', { exact: true }).waitFor()
    await capture(page, 'separated-newtab-server-auth')
    await right.locator('input[type=password]').fill('fixture-password')
    await right.getByRole('button', { name: 'Sign in', exact: true }).click()
    await left.getByRole('button', { name: 'Remote recent · Box · /srv/recent', exact: true }).waitFor()
    assert.equal(await right.getByText('Remote recent', { exact: true }).count(), 0)
    assert.equal(await left.locator('[data-remote-folder], .action-overflow-menu').count(), 0)
    assert.equal(await left.getByRole('button', { name: /Project actions|Remove from recent|Rename workspace/ }).count(), 0)
    assert.equal(await left.getByRole('button', { name: /Host recent/ }).count(), 0)
    await capture(page, 'separated-newtab-server-folders-left-recents')
    await right.getByRole('button', { name: 'app', exact: true }).click()
    await waitForPath(right, '/srv/app')
    assert.deepEqual((await views(page)).opened, [])
    assert.equal((await fixture.state() as any).remoteProjectRecents, undefined, 'browsed recents stay out of host preferences')
    await right.getByRole('button', { name: 'Back to Browse', exact: true }).click()
    await left.getByRole('button', { name: 'Host recent · This computer · /local', exact: true }).waitFor()
    assert.equal(await left.getByRole('button', { name: /Remote recent/ }).count(), 0)
    await capture(page, 'separated-newtab-back')
  } finally { await page.close() }
})

test('Home retains the selected server and folder across tabs; a hidden browse response cannot take focus', async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, locale: 'en-US' })
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  try {
    await page.clock.setFixedTime(SEPARATION_NOW)
    const fixture = await open(page, '', { context: 'local', host: 'electron', uiState: { remoteServers: [server('box')],
      recentFolders: [{ path: '/local', projectName: 'Host recent', lastAccessed: RECENT_TIME }] } })
    await browse(page)
    await page.getByRole('button', { name: 'Open a project on Box' }).click()
    await page.locator('[data-remote-folder]').waitFor()
    await page.route('**/api/remote-servers/box/browse', async route => { await held; await route.fallback() })
    const pending = page.waitForRequest('**/api/remote-servers/box/browse')
    await page.getByRole('button', { name: 'app', exact: true }).click()
    await pending
    const recentTab = page.getByRole('tab', { name: 'Recent tabs', exact: true })
    await recentTab.click()
    await recentTab.focus()
    assert.equal(await page.getByRole('button', { name: /Host recent/ }).count(), 0)
    assert.equal(await recentTab.locator('.panel-subtitle').count(), 0)
    assert.equal(await recentTab.getAttribute('aria-description'), null)
    assert.equal(await page.getByText('No recent projects yet.', { exact: true }).count(), 0)
    release()
    await page.getByRole('button', { name: 'Remote recent · Box · /srv/recent', exact: true }).waitFor()
    assert.equal(await recentTab.evaluate(node => document.activeElement === node), true)
    await capture(page, 'separated-home-recent-tab')
    await browse(page)
    await waitForPath(page, '/srv/app')
    assert.deepEqual(fixture.remoteReads, ['/', '/srv/app'])
    assert.deepEqual((await views(page)).opened, [])
    await page.getByRole('button', { name: 'Clone Git Repo', exact: true }).waitFor()
    await capture(page, 'separated-home-browse-preserved-folder')
    await page.getByRole('button', { name: 'Back to Browse', exact: true }).click()
    await recentTab.click()
    await page.getByRole('button', { name: 'Host recent · This computer · /local', exact: true }).waitFor()
  } finally { release(); await page.close() }
})

for (const response of ['empty', 'auth', 'error', 'pending'] as const) test(`remote ${response}: only a successful empty result claims zero recents`, async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, locale: 'en-US' })
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  try {
    await page.clock.setFixedTime(SEPARATION_NOW)
    await open(page, '', { context: 'local', host: 'electron', uiState: { remoteServers: [server('box')],
      recentFolders: [{ path: '/local', projectName: 'Host recent', lastAccessed: RECENT_TIME }] } })
    await page.route('**/api/remote-servers/box/browse', async route => {
      if (response === 'pending') await held
      await route.fulfill(response === 'empty' || response === 'pending'
        ? { json: { listing: { metadata: { currentPath: '/', displayPath: '/', pathKind: 'absolute' }, entries: [] }, recents: [] } }
        : { status: 409, json: { error: response === 'auth' ? 'needs_credentials' : 'unreachable' } })
    })
    await browse(page)
    const requested = page.waitForRequest('**/api/remote-servers/box/browse')
    await page.getByRole('button', { name: 'Open a project on Box' }).click()
    await requested
    if (response === 'empty') await page.locator('.remote-server-path').getByRole('button', { name: 'Open', exact: true }).waitFor()
    else if (response === 'auth') await page.locator('input[type=password]').waitFor()
    else if (response === 'error') await page.getByRole('alert').getByText('Server unreachable.', { exact: true }).waitFor()
    const recentTab = page.getByRole('tab', { name: 'Recent tabs', exact: true })
    await recentTab.click()
    assert.equal(await page.locator('.folder-home-recent-item').count(), 0)
    await page.locator('[role=tabpanel]:visible').getByText('Box', { exact: true }).waitFor()
    if (response === 'empty') {
      await page.getByText('No recent projects yet.', { exact: true }).waitFor()
      assert.equal(await recentTab.locator('.panel-subtitle').innerText(), '0 items')
      assert.equal(await recentTab.getAttribute('aria-description'), '0 items')
    } else {
      assert.equal(await page.getByText('No recent projects yet.', { exact: true }).count(), 0)
      assert.equal(await recentTab.locator('.panel-subtitle').count(), 0)
      assert.equal(await recentTab.getAttribute('aria-description'), null)
    }
    await capture(page, `availability-home-${response}`)
  } finally { release(); await page.close() }
})

const BOX = "https://box.example"

for (const host of ['electron', 'tauri'] as const) {
  for (const source of ['saved title', 'recent', 'folder'] as const) test(`${host}: restored projects use ${source} labels before either view opens`, async () => {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, locale: 'en-US' })
    try {
      const folders = ['/srv/first/', 'C:\\projects\\second\\']
      const titles = source === 'folder' ? ['first', 'second'] : ['First project', 'Second project']
      await open(page, '', { context: 'local', host,
        uiState: { remoteServers: [server('box')], remoteProjectRecents: folders.map((folder, index) => ({
          profileId: 'box', folder, projectName: source === 'recent' ? titles[index] : source === 'saved title' ? 'Older recent name' : undefined, lastAccessed: RECENT_TIME,
        })) },
        restore: { version: 1, revision: 1, savedAt: 1, layout: {}, session: {
          homeActive: true, activeTabIndex: 0, tabs: folders.map((folder, index) => ({
            kind: 'remote-project', profileId: 'box', folder,
            ...(source === 'saved title' ? { title: titles[index] } : {}),
          })),
        } } })
      await page.locator('.tab-pill').nth(1).waitFor()
      assert.deepEqual(await page.locator('.tab-pill bdi').allTextContents(), titles)
      assert.deepEqual(await page.locator('.tab-pill-close').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label'))), titles)
      assert.equal((await views(page)).opened.length, 0, 'restoring labels must not open hidden native views')
      if (source === 'saved title') {
        await page.waitForFunction(() => (window as any).fixtureSnapshots.some((snapshot: any) =>
          snapshot.session?.tabs.length === 2 && snapshot.session.tabs.every((tab: any) => tab.title)))
        assert.deepEqual(await page.evaluate(() => (window as any).fixtureSnapshots.at(-1).session.tabs.map((tab: any) => tab.title)), titles)
      }
      await page.locator('.folder-home-root').getByRole('button', { name: 'Close', exact: true }).click()
      await page.waitForFunction(() => (window as any).fixtureViews.opened.length === 1)
      assert.equal((await views(page)).opened[0].url, `${BOX}/?codenomadEmbed=project&folder=${encodeURIComponent(folders[0]!)}`)
      assert.deepEqual(await page.locator('.tab-pill bdi').allTextContents(), titles)
      assert.equal((await views(page)).opened.length, 1, 'the unselected project must remain unopened')
    } finally { await page.close() }
  })

  test(`${host}: delayed view session rechecks visibility and bounds; native loading permits hide and close`, async () => {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, locale: 'en-US' })
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    try {
      await open(page, '', { context: 'local', host, remoteNeedsPassword: true,
        uiState: { remoteServers: [server('box')] },
        restore: { version: 1, revision: 1, savedAt: 1, layout: {}, session: {
          activeTabIndex: 0, tabs: [{ kind: 'remote-project', profileId: 'box', folder: '/srv/app' }],
        } } })
      await page.locator('input[type=password]').fill('fixture-password')
      await page.evaluate((host) => {
        const w = window as any
        w.holdOpen = async (payload: unknown) => {
          w.fixtureViews.opened.push(payload)
          await new Promise<void>(resolve => { w.releaseNative = resolve })
        }
        if (host === 'electron') w.electronAPI.openRemoteView = w.holdOpen
        else {
          const invoke = w.__TAURI_INTERNALS__.invoke
          w.__TAURI_INTERNALS__.invoke = (command: string, args: any) => command === 'remote_view_open' ? w.holdOpen(args.payload) : invoke(command, args)
        }
      }, host)
      await page.route('**/api/remote-servers/box/view-session', async route => { await held; await route.fallback() })
      const request = page.waitForRequest('**/api/remote-servers/box/view-session')
      await page.getByRole('button', { name: 'Sign in', exact: true }).click()
      await request
      await page.locator('.new-instance-button').click()
      await page.locator('.folder-home-root--blank:visible').waitFor()
      release()
      await page.locator('[data-remote-view-session][aria-busy=false]').waitFor({ state: 'attached' })
      assert.equal((await views(page)).opened.length, 0, 'inactive session completion must defer native creation')
      await page.setViewportSize({ width: 1000, height: 700 })
      await page.evaluate(() => { const overlay = document.createElement('div'); overlay.role = 'dialog'; overlay.id = 'held-overlay'; document.body.append(overlay) })
      await page.locator('.tab-pill').first().click()
      assert.equal((await views(page)).opened.length, 0, 'an overlay must also defer native creation')
      await page.evaluate(() => document.getElementById('held-overlay')!.remove())
      await page.waitForFunction(() => (window as any).fixtureViews.opened.length === 1)
      const rect = await page.locator('[data-remote-project-view]').boundingBox()
      const first = (await views(page)).opened[0]
      assert.equal(first.bounds.width, Math.round(rect!.width))
      assert.equal(first.bounds.height, Math.round(rect!.height))
      // The native load remains unresolved throughout these transitions.
      await page.evaluate(() => { const overlay = document.createElement('div'); overlay.role = 'dialog'; overlay.id = 'held-overlay'; document.body.append(overlay) })
      await page.waitForFunction(() => (window as any).fixtureViews.updates.at(-1)?.visible === false)
      await page.evaluate(() => document.getElementById('held-overlay')!.remove())
      await page.waitForFunction(() => (window as any).fixtureViews.updates.at(-1)?.visible === true)
      await page.locator('.new-instance-button').click()
      await page.waitForFunction(() => (window as any).fixtureViews.updates.at(-1)?.visible === false)
      await page.locator('.tab-pill').first().locator('.tab-pill-close').click()
      await page.waitForFunction(() => (window as any).fixtureViews.closed.length > 0)
      assert.equal((await views(page)).closed[0], first.viewId)
      await page.evaluate(() => (window as any).releaseNative())
      await page.waitForFunction(() => (window as any).fixtureViews.closed.length === 2)
      assert.equal(await page.locator('[data-remote-project-view]').count(), 0)
    } finally { release(); await page.close() }
  })

  for (const surface of ['browse', 'recent', 'restore'] as const) test(`${host}: anonymous ${surface} opens without a cookie or sign-in form`, async () => {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, locale: 'en-US' })
    try {
      await open(page, '', { context: 'local', host, anonymous: true, uiState: { remoteServers: [server('box')],
        remoteProjectRecents: [{ profileId: 'box', folder: '/srv/app', projectName: 'Remote', lastAccessed: RECENT_TIME }] },
        ...(surface === 'restore' ? { restore: { version: 1, revision: 1, savedAt: 1, layout: {}, session: {
          activeTabIndex: 0, tabs: [{ kind: 'remote-project', profileId: 'box', folder: '/srv/app' }],
        } } } : {}) })
      if (surface === 'browse') {
        await browse(page)
        await page.getByRole('button', { name: 'Open a project on Box', exact: true }).click()
        await page.locator('.remote-server-path').getByRole('button', { name: 'Open', exact: true }).click()
      } else if (surface === 'recent') await page.getByRole('button', { name: 'Remote · Box · /srv/app', exact: true }).click()
      await page.waitForFunction(() => (window as any).fixtureViews.opened.length === 1)
      assert.equal((await views(page)).opened[0].cookie, undefined)
      assert.equal(await page.locator('input[type=password]').count(), 0)
    } finally { await page.close() }
  })
}

for (const code of ['needs_credentials', 'unreachable'] as const) test(`folder navigation clears availability while pending and after ${code}`, async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, locale: 'en-US' })
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  try {
    await page.clock.setFixedTime(SEPARATION_NOW)
    await open(page, '', { context: 'local', host: 'electron', uiState: { remoteServers: [server('box')] } })
    await browse(page)
    await page.getByRole('button', { name: 'Open a project on Box' }).click()
    await page.locator('[data-remote-folder]').waitFor()
    const recentTab = page.getByRole('tab', { name: 'Recent tabs', exact: true })
    assert.equal(await recentTab.locator('.panel-subtitle').innerText(), '1 item')
    await page.route('**/api/remote-servers/box/browse', async route => { await held; await route.fulfill({ status: 409, json: { error: code } }) })
    const requested = page.waitForRequest('**/api/remote-servers/box/browse')
    await page.getByRole('button', { name: 'app', exact: true }).click()
    await requested
    await recentTab.click()
    assert.equal(await recentTab.locator('.panel-subtitle').count(), 0)
    assert.equal(await page.locator('.folder-home-recent-item').count(), 0)
    assert.equal(await page.getByText('No recent projects yet.', { exact: true }).count(), 0)
    release()
    await browse(page)
    if (code === 'needs_credentials') await page.locator('input[type=password]').waitFor()
    else await page.getByRole('alert').getByText('Server unreachable.', { exact: true }).waitFor()
    await recentTab.click()
    assert.equal(await recentTab.locator('.panel-subtitle').count(), 0)
    assert.equal(await recentTab.getAttribute('aria-description'), null)
    assert.equal(await page.getByText('No recent projects yet.', { exact: true }).count(), 0)
    await capture(page, `availability-navigation-${code}`)
  } finally { release(); await page.close() }
})

test('independent blank sources fence A → Back → B and inactive-pane focus', async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, locale: 'en-US' })
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let settled!: () => void
  const finished = new Promise<void>(resolve => { settled = resolve })
  let releaseFolder!: () => void
  const folderHeld = new Promise<void>(resolve => { releaseFolder = resolve })
  try {
    await open(page, '', { context: 'local', host: 'electron', uiState: { remoteServers: [server('box'), server('lab')] },
      sidecars: [sidecar('docs', 'Docs', 'running')] })
    await browse(page)
    await page.locator('[data-sidecar="docs"]').click()
    await page.locator('.new-instance-button').click()
    const active = page.locator('[data-tab-kind="blank"][data-tab-visible="true"]')
    const firstId = await active.getAttribute('data-tab-id')
    await page.route('**/api/remote-servers/box/browse', async route => {
      await held
      try { await route.fulfill({ json: { listing: { metadata: { currentPath: '/late', displayPath: '/late', pathKind: 'absolute' }, entries: [] },
        recents: [{ path: '/late', projectName: 'Late A', lastAccessed: 1 }] } }) } finally { settled() }
    })
    const pending = page.waitForRequest('**/api/remote-servers/box/browse')
    await active.getByRole('button', { name: 'Open a project on Box' }).click()
    await pending
    await active.getByRole('button', { name: 'Back to Browse', exact: true }).click()
    await active.getByRole('button', { name: 'Open a project on lab' }).click()
    await active.getByRole('button', { name: 'Remote recent · lab · /srv/recent', exact: true }).waitFor()
    release()
    await finished
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    assert.equal(await active.getByRole('button', { name: /Late A/ }).count(), 0)
    await page.route('**/api/remote-servers/lab/browse', async route => { await folderHeld; await route.fallback() })
    const folderPending = page.waitForRequest('**/api/remote-servers/lab/browse')
    await active.getByRole('button', { name: 'app', exact: true }).click()
    await folderPending
    await page.locator('.new-instance-button').click()
    const secondId = await active.getAttribute('data-tab-id')
    assert.notEqual(secondId, firstId)
    assert.equal(await active.locator('.remote-server-browser').count(), 0)
    await active.getByRole('button', { name: 'Open a project on Box' }).waitFor()
    await active.getByRole('button', { name: 'Open a project on Box' }).focus()
    releaseFolder()
    const first = page.locator(`[data-tab-id="${firstId}"]`)
    await waitForPath(first, '/srv/app')
    assert.equal(await active.getByRole('button', { name: 'Open a project on Box' }).evaluate(node => document.activeElement === node), true)
    await page.locator(`[data-app-tab-id="${firstId}"] [role=tab]`).click()
    await waitForPath(active, '/srv/app')
    await active.getByRole('button', { name: 'Remote recent · lab · /srv/recent', exact: true }).waitFor()
    assert.deepEqual((await views(page)).opened, [])
  } finally { release(); releaseFolder(); await page.close() }
})

const captures = process.env.CODENOMAD_REMOTE_UX_CAPTURE_DIR

for (const change of ['edit', 'remove'] as const) test(`a profile ${change} retires its source and fences a pending folder response`, async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, locale: 'en-US' })
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let settled!: () => void
  const finished = new Promise<void>(resolve => { settled = resolve })
  try {
    await open(page, '', { context: 'local', host: 'electron', uiState: { remoteServers: [server('box')],
      recentFolders: [{ path: '/local', projectName: 'Host recent', lastAccessed: 1 }] } })
    await browse(page)
    await page.getByRole('button', { name: 'Open a project on Box' }).click()
    await page.locator('[data-remote-folder]').waitFor()
    await page.route('**/api/remote-servers/box/browse', async route => {
      await held
      try { await route.fulfill({ json: { listing: { metadata: { currentPath: '/late', displayPath: '/late', pathKind: 'absolute' }, entries: [] },
        recents: [{ path: '/late', projectName: 'Late source', lastAccessed: 1 }] } }) } finally { settled() }
    })
    const pending = page.waitForRequest('**/api/remote-servers/box/browse')
    await page.getByRole('button', { name: 'app', exact: true }).click()
    await pending
    // Exercise the real preference publication consumed by each mounted selector.
    await page.evaluate(async ({ change, profile }) => {
      const path = '/src/lib/storage.ts'
      const { storage } = await import(path)
      await storage.patchStateOwner('ui', { remoteServers: change === 'edit' ? [{ ...profile, name: 'Edited box' }] : [] })
    }, { change, profile: server('box') })
    await page.locator('.remote-server-browser').waitFor({ state: 'detached' })
    await page.getByRole('tab', { name: 'Recent tabs', exact: true }).click()
    const recentTab = page.getByRole('tab', { name: 'Recent tabs', exact: true })
    await recentTab.focus()
    await page.getByRole('button', { name: 'Host recent · This computer · /local', exact: true }).waitFor()
    release()
    await finished
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    assert.equal(await page.getByRole('button', { name: /Late source/ }).count(), 0)
    assert.equal(await recentTab.evaluate(node => document.activeElement === node), true)
  } finally { release(); await page.close() }
})

async function capture(page: Page, name: string) {
  if (!captures) return
  await mkdir(captures, { recursive: true })
  await page.screenshot({ path: `${captures}/${name}.png` })
}

test('server-source recents preserve the separate-window TLS fallback', async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, locale: 'en-US' })
  try {
    await open(page, '', { context: 'local', host: 'electron', uiState: { remoteServers: [server('lab', { skipTlsVerify: true })] } })
    await browse(page)
    await page.getByRole('button', { name: 'Open a project on lab' }).click()
    await page.getByRole('button', { name: 'app', exact: true }).waitFor()
    await page.getByRole('tab', { name: 'Recent tabs', exact: true }).click()
    const recent = page.locator('.folder-home-recent-item')
    await recent.getByText('Open in a separate window', { exact: true }).waitFor()
    assert.equal(await recent.getByRole('button', { name: /Project actions|Remove from recent|Rename workspace/ }).count(), 0)
    await recent.getByRole('button', { name: 'Remote recent · lab · /srv/recent', exact: true }).click()
    await page.waitForFunction(() => (window as any).fixtureViews.windows.length === 1)
    assert.deepEqual((await views(page)).opened, [])
    assert.equal((await views(page)).windows[0].entryUrl, 'https://lab.example/?codenomadEmbed=project&folder=%2Fsrv%2Frecent')
  } finally { await page.close() }
})
const server = (id: string, extra: Record<string, unknown> = {}) => ({
  id, name: id === "box" ? "Box" : id, baseUrl: id === "box" ? BOX : `https://${id}.example`, skipTlsVerify: false,
  createdAt: "2026-11-01T10:00:00.000Z", updatedAt: "2026-11-01T10:00:00.000Z", ...extra,
})

interface Scenario {
  context?: "local" | "remote"
  host?: "electron" | "tauri" | "web"
  uiState?: Record<string, unknown>
  /** A saved native session, restored by a local Electron window. */
  restore?: unknown
  sidecars?: unknown[]
  remoteNeedsPassword?: boolean
  anonymous?: boolean
  pairingWorks?: boolean
  pairingError?: string
}

async function open(page: Page, path: string, scenario: Scenario) {
  const { context, host = "web", uiState = {}, restore, sidecars = [] } = scenario
  await page.addInitScript({ content: `{
    const w = window, context = ${JSON.stringify(context ?? null)}, host = ${JSON.stringify(host)}, restore = ${JSON.stringify(restore ?? null)}
    if (context) w.__CODENOMAD_WINDOW_CONTEXT__ = context
    if (host !== "web") w.__CODENOMAD_RUNTIME_HOST__ = host
    w.fixtureViews = { opened: [], updates: [], closed: [], listeners: [], windows: [] }
    w.fixtureSnapshots = []
    w.EventSource = class extends EventTarget { close() {} }
    if (host === "tauri") {
      w.__TAURI__ = { core: { invoke: async () => undefined } }
      w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} }
      w.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
        if (command === "client_state_load") return { isPrimary: true, restoreEnabled: Boolean(restore), snapshot: restore }
        if (command === "client_state_save") { w.fixtureSnapshots.push(args.snapshot); return true }
        if (command === "open_external_url") w.externalURLs.push(args.url)
        if (command === "open_remote_window") w.fixtureViews.windows.push(args.payload)
        if (command === "remote_view_open") w.fixtureViews.opened.push(args.payload)
        if (command === "remote_view_update") w.fixtureViews.updates.push(args.payload)
        if (command === "remote_view_close") w.fixtureViews.closed.push(args.viewId)
        }, transformCallback: () => 1, metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main', windowLabel: 'main' } } }
    }
    // Fixture shim: the session list's virtualizer reads defaultView from nodes the dev
    // server's templates create in an inert document before they are inserted.
    const defaultView = Object.getOwnPropertyDescriptor(Document.prototype, "defaultView")
    Object.defineProperty(Document.prototype, "defaultView", { configurable: true, get() { return defaultView.get.call(this) ?? w } })
    if (host === "electron" && context === "local") {
      const known = {
        claimClientStateAccess: async () => Boolean(restore),
        loadClientState: async () => ({ isPrimary: true, restoreEnabled: true, snapshot: restore }),
        saveClientState: async (_token, snapshot) => { w.fixtureSnapshots.push(snapshot); return true },
        openRemoteView: async (payload) => { w.fixtureViews.opened.push(payload) },
        updateRemoteView: async (payload) => { w.fixtureViews.updates.push(payload) },
        closeRemoteView: async (viewId) => { w.fixtureViews.closed.push(viewId) },
        onRemoteViewUpdated: (callback) => { w.fixtureViews.listeners.push(callback); return () => {} },
        openRemoteWindow: async (payload) => { w.fixtureViews.windows.push(payload) },
        getZoomFactor: () => 1,
      }
      // Every other host call resolves to nothing and every subscription to a no-op disposer.
      w.electronAPI = new Proxy(known, { get: (target, key) => key in target ? target[key]
        : typeof key !== "string" ? undefined : /^on[A-Z]/.test(key) ? () => () => {} : async () => undefined })
    }
  }` })
  const created: string[] = []
  const workspaces: Record<string, unknown>[] = []
  const probes: string[] = []
  let state = uiState
  let remoteAuthenticated = !scenario.remoteNeedsPassword
  const remoteReads: string[] = []
  await page.route(/\/(?:api|workspaces)\//, async route => {
    const request = route.request()
    const pathname = new URL(request.url()).pathname
    const remote = pathname.match(/^\/api\/remote-servers\/([^/]+)\/(browse|connect|forget|view-session)$/)
    if (remote) {
      const body = request.postDataJSON() ?? {}
      if (remote[2] === 'forget') return route.fulfill({ json: { ok: true } })
      if (remote[2] === 'connect') {
        if (body.pairingLink && !scenario.pairingWorks) return route.fulfill({ status: 409, json: { error: scenario.pairingError ?? 'pairing_unavailable' } })
        if (body.pairingLink) { remoteAuthenticated = true; return route.fulfill({ json: { ok: true } }) }
        if (body.password !== 'fixture-password') return route.fulfill({ status: 409, json: { error: 'auth' } })
        remoteAuthenticated = true
        return route.fulfill({ json: { ok: true } })
      }
      if (!remoteAuthenticated) return route.fulfill({ status: 409, json: { error: 'needs_credentials' } })
      if (remote[2] === 'view-session' && scenario.anonymous) return route.fulfill({ json: {} })
      if (remote[2] === 'view-session') return route.fulfill({ json: { cookie: {
        origin: BOX, name: 'codenomad_session', value: 'fixture-session-secret', path: '/', secure: true, httpOnly: true, sameSite: 'lax',
      } } })
      const current = body.path ?? '/'
      remoteReads.push(current)
      return route.fulfill({ json: { listing: { metadata: { currentPath: current, displayPath: current, rootPath: '/', homePath: '/', scope: 'unrestricted', pathKind: 'absolute', ...(current === '/' ? {} : { parentPath: '/' }) },
        entries: current === '/' ? [{ name: 'app', path: '/srv/app', absolutePath: '/srv/app', type: 'directory' }] : [] },
        recents: [{ path: '/srv/recent', projectName: 'Remote recent', lastAccessed: RECENT_TIME }] } })
    }
    if (pathname === "/api/workspaces" && request.method() === "POST") {
      const body = request.postDataJSON() as { path: string }
      created.push(body.path)
      const workspace = {
        id: `ws-${created.length}`, path: body.path, status: "starting", proxyPath: `/workspaces/ws-${created.length}/instance`,
        binaryId: "fixture", binaryLabel: "fixture", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
      }
      workspaces.push(workspace)
      return route.fulfill({ json: workspace })
    }
    if (pathname === "/api/remote-servers/probe") {
      const { baseUrl, skipTlsVerify } = request.postDataJSON() as { baseUrl: string; skipTlsVerify?: boolean }
      probes.push(`${baseUrl} skipTls=${Boolean(skipTlsVerify)}`)
      // A self-signed server answers only once its certificate check is skipped.
      if (baseUrl.includes("selfsigned") && !skipTlsVerify) {
        return route.fulfill({ json: { ok: false, reachable: false, normalizedUrl: baseUrl, skipTlsVerify: false, requiresAuth: false,
          authenticated: false, error: "Certificate check failed while connecting to the remote server.", errorCode: "tls_error" } })
      }
      return route.fulfill({ json: { ok: true, reachable: true, normalizedUrl: baseUrl, skipTlsVerify: Boolean(skipTlsVerify), requiresAuth: true, authenticated: false } })
    }
    if (pathname === "/api/storage/state/ui" && request.method() === "PATCH") {
      state = { ...state, ...(request.postDataJSON() as Record<string, unknown>) }
      return route.fulfill({ json: state })
    }
    if (pathname === "/api/sidecars") return route.fulfill({ json: { sidecars } })
    const body = pathname === "/api/workspaces" ? workspaces
      : pathname === "/api/storage/config/ui" ? { settings: { locale: "en" }, theme: 'dark' }
      : pathname === "/api/storage/state/ui" ? state : {}
    await route.fulfill({ json: body })
  })
  await page.goto(`${url}${path}`)
  return { created, probes, remoteReads, state: () => state }
}

// Home and blank tabs share the canonical Browse tab.
async function browse(page: Page) {
  await page.locator('.folder-home-root:visible').waitFor()
  const tab = page.getByRole("tab", { name: "Browse", exact: true })
  if (await tab.count()) await tab.click()
}

// Browse's last row: the field that saves a server. Enter submits it.
async function addServer(page: Page, address: string) {
  await browse(page)
  const field = page.getByRole("textbox", { name: "Server address or link" })
  await field.fill(address)
  await field.press("Enter")
  return field
}

const views = (page: Page) => page.evaluate(() => (window as any).fixtureViews as {
  opened: Array<{ viewId: string; profileId: string; baseUrl: string; url: string; cookie?: { value: string }; bounds: { width: number; height: number } }>
  updates: Array<{ viewId: string; visible: boolean }>; closed: string[]; windows: Array<{ id: string; entryUrl?: string; proxySessionId?: string; cookie?: { value: string } }>
})

// The browser's editable path field shows the folder being browsed.
async function waitForPath(scope: Page | Locator, value: string) {
  const field = scope.locator('.remote-server-path input').first()
  await field.waitFor({ state: 'attached' })
  for (let attempt = 0; attempt < 200 && await field.inputValue() !== value; attempt++) await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal(await field.inputValue(), value)
}

async function chooseRemoteRoot(page: Page) {
  await page.locator('.remote-server-path').getByRole('button', { name: /^(Open|Open in a separate window)$/ }).click()
}

for (const surface of ['Home', 'blank'] as const) test(`${surface}: remote browsing signs in inline and opens only the chosen folder`, async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, locale: 'en-US' })
  try {
    const fixture = await open(page, '', { context: 'local', host: 'electron', remoteNeedsPassword: true,
      uiState: { remoteServers: [server('box')] }, sidecars: [sidecar('docs', 'Docs', 'running')] })
    await browse(page)
    if (surface !== 'Home') {
      await page.locator('[data-sidecar="docs"]').click()
      await page.locator('.tab-pill', { hasText: 'Docs' }).waitFor()
      await page.locator('.new-instance-button').click()
      await browse(page)
    }
    const root = surface === 'blank' ? page.locator('[data-tab-kind="blank"][data-tab-visible="true"]') : page.locator('.folder-home-root')
    const beforeTabs = await page.locator('.tab-pill').count()
    const blankId = surface === 'blank' ? await root.getAttribute('data-tab-id') : null
    await root.getByRole('button', { name: 'Open a project on Box' }).click()
    const password = root.getByRole('textbox', { name: 'Password', exact: true }).or(root.locator('input[type="password"]'))
    await password.waitFor()
    assert.equal(await root.getByRole('textbox', { name: 'Username', exact: true }).inputValue(), 'codenomad')
    assert.equal(await page.getByRole('dialog').count(), 0, 'sign-in creates no floating dialog')
    assert.equal(await root.getByRole('button', { name: 'Back to Browse', exact: true }).count(), 1)
    assert.deepEqual(await root.locator('.remote-server-signin input').evaluateAll(inputs => inputs.map(input => input.getAttribute('aria-label'))), ['Username', 'Password'])
    if (surface === 'Home') {
      await capture(page, '03-password')
      await page.setViewportSize({ width: 480, height: 800 })
      await capture(page, 'A-auth-narrow')
      await page.setViewportSize({ width: 1200, height: 800 })
    }
    if (surface === 'blank') {
      await capture(page, 'A-auth')
      await page.setViewportSize({ width: 480, height: 800 })
      await capture(page, 'A-auth-blank-narrow')
      await page.setViewportSize({ width: 1200, height: 800 })
    }
    assert.equal(await page.locator('.tab-pill').count(), beforeTabs)
    assert.deepEqual((await views(page)).opened, [])
    assert.deepEqual((await views(page)).windows, [])
    await password.fill('wrong-password')
    await root.getByRole('button', { name: 'Sign in', exact: true }).click()
    await root.getByRole('alert').getByText('The username or password is incorrect.').waitFor()
    assert.equal(await password.inputValue(), '')
    assert.equal(await page.getByRole('dialog').count(), 0, 'failed sign-in stays inline')
    assert.equal(await password.getAttribute('aria-invalid'), 'true')
    assert.equal(await password.getAttribute('aria-describedby'), await root.getByRole('alert').getAttribute('id'))
    if (surface === 'Home') await capture(page, '04-password-error')
    await password.fill('fixture-password')
    await root.getByRole('button', { name: 'Sign in', exact: true }).click()
    await root.locator('[data-remote-folder]').waitFor()
    assert.equal(await root.locator('input[type="password"]').count(), 0)
    assert.equal(JSON.stringify(fixture.state()).includes('fixture-password'), false)
    if (surface === 'Home') await capture(page, '05-server-browse')
    await page.waitForFunction(() => document.activeElement?.hasAttribute('data-remote-folder'))
    await page.keyboard.press('Home')
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Back to Browse')
    await page.keyboard.press('End')
    await page.waitForFunction(() => document.activeElement?.hasAttribute('data-remote-folder'))
    await page.keyboard.press('Enter')
    await waitForPath(root, '/srv/app')
    assert.deepEqual((await views(page)).opened, [])
    await root.getByRole('button', { name: 'Parent folder', exact: true }).click()
    await root.locator('[data-remote-folder]').waitFor()
    await root.getByRole('button', { name: 'Back to Browse', exact: true }).click()
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-remote-server') === 'box')
    await page.keyboard.press('Enter')
    await root.locator('[data-remote-folder]').waitFor()
    await page.keyboard.press('Escape')
    await root.getByRole('button', { name: 'This computer', exact: true }).waitFor()
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-remote-server') === 'box')
    assert.equal(await page.locator('.tab-pill').count(), beforeTabs)
    await page.keyboard.press('Enter')
    await root.getByRole('button', { name: 'app', exact: true }).click()
    await waitForPath(root, '/srv/app')
    assert.equal(await root.getByRole('button', { name: 'Back to Browse', exact: true }).count(), 1)
    assert.equal(await root.locator('.remote-server-browser h3').count(), 0)
    assert.equal(await root.getByRole('button', { name: 'Select Current' }).count(), 0)
    await root.locator('.remote-server-path').getByRole('button', { name: 'Open', exact: true }).click()
    await page.waitForFunction(() => (window as any).fixtureViews.opened.length === 1)
    assert.equal((await views(page)).opened[0].url, `${BOX}/?codenomadEmbed=project&folder=%2Fsrv%2Fapp`)
    assert.equal(await page.locator('.tab-pill').count(), beforeTabs + (surface === 'blank' ? 0 : 1))
    if (blankId) assert.equal(await page.locator(`[data-tab-id="${blankId}"]`).count(), 0)
    assert.equal(await page.locator('.new-instance-launcher').count(), 0)
    assert.deepEqual(fixture.created, [])
    assert.deepEqual(fixture.remoteReads, ['/', '/srv/app', '/', '/', '/', '/srv/app'])
  } finally { await page.close() }
})

for (const surface of ['Home', 'blank'] as const) test(`${surface}: a server click never opens a whole-server tab; auth and folders stay in Browse`, async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, locale: 'en-US' })
  try {
    await open(page, '', { context: 'local', host: 'electron', remoteNeedsPassword: true,
      uiState: { remoteServers: [server('box')] }, sidecars: [sidecar('docs', 'Docs', 'running')] })
    await browse(page)
    if (surface === 'blank') {
      await page.locator('.browse-menu [data-sidecar="docs"]').click()
      await page.locator('.new-instance-button').click()
      await page.waitForFunction(() => document.activeElement?.matches('.folder-home-recent-primary-action, [data-browse-nav]'))
    }
    const root = surface === 'blank' ? page.locator('[data-tab-kind="blank"][data-tab-visible="true"]') : page.locator('.folder-home-root')
    const beforeTabs = await page.locator('.tab-pill').count()
    await capture(page, `${surface.toLowerCase()}-01-servers`)
    await root.getByRole('button', { name: 'Open a project on Box', exact: true }).click()
    const password = root.locator('.remote-server-signin input[type=password]')
    await password.waitFor()
    assert.equal(await page.locator('.tab-pill').count(), beforeTabs)
    assert.deepEqual(await views(page), { opened: [], updates: [], closed: [], windows: [], listeners: [] })
    await capture(page, `${surface.toLowerCase()}-02-password-in-place`)
    await password.fill('fixture-password')
    await root.getByRole('button', { name: 'Sign in', exact: true }).click()
    await root.locator('[data-remote-folder]').waitFor()
    assert.equal(await page.locator('.tab-pill').count(), beforeTabs)
    assert.deepEqual((await views(page)).opened, [])
    assert.deepEqual((await views(page)).windows, [])
    await capture(page, `${surface.toLowerCase()}-03-folders-in-place`)
    await root.getByRole('button', { name: 'app', exact: true }).click()
    await waitForPath(root, '/srv/app')
    assert.deepEqual((await views(page)).opened, [])
    await root.locator('.remote-server-path input').press('Enter')
    await page.waitForFunction(() => (window as any).fixtureViews.opened.length === 1)
    assert.equal((await views(page)).opened[0].url, `${BOX}/?codenomadEmbed=project&folder=%2Fsrv%2Fapp`)
    assert.deepEqual((await views(page)).windows, [])
    await capture(page, `${surface.toLowerCase()}-04-project-open`)
  } finally { await page.close() }
})

for (const pending of ['browse', 'connect'] as const) test(`returning to Browse fences a delayed remote ${pending} response and its focus`, async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, locale: 'en-US' })
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let settled!: () => void
  const finished = new Promise<void>(resolve => { settled = resolve })
  try {
    await open(page, '', { context: 'local', host: 'electron', remoteNeedsPassword: pending === 'connect', uiState: { remoteServers: [server('box')] } })
    await browse(page)
    await page.route(`**/api/remote-servers/box/${pending}`, async route => {
      await held
      try { await route.fulfill({ json: pending === 'connect' ? { ok: true } : {
        listing: { metadata: { currentPath: '/late', displayPath: '/late', pathKind: 'absolute' }, entries: [{ name: 'late', path: '/late', type: 'directory' }] }, recents: [],
      } }) } finally { settled() }
    })
    const request = page.waitForRequest(`**/api/remote-servers/box/${pending}`)
    await page.getByRole('button', { name: 'Open a project on Box' }).click()
    if (pending === 'connect') {
      await page.getByRole('textbox', { name: 'Username', exact: true }).waitFor()
      await page.locator('input[type="password"]').fill('fixture-password')
      await page.getByRole('button', { name: 'Sign in', exact: true }).click()
      assert.equal(await page.locator('input[type="password"]').inputValue(), '', 'cleared while connect is pending')
    }
    await request
    await page.getByRole('button', { name: 'Back to Browse', exact: true }).click()
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-remote-server') === 'box')
    release()
    await finished
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    assert.equal(await page.locator('.remote-server-browser').count(), 0)
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-remote-server')), 'box')
    assert.deepEqual((await views(page)).opened, [])
    assert.deepEqual((await views(page)).windows, [])
  } finally { release(); await page.close() }
})

test("the embedded page shows no tab bar or home, only a folder picker that opens one project", async () => {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 }, locale: "en-US" })
  try {
    const fixture = await open(page, "?codenomadEmbed=project", {
      context: "remote", host: "electron",
      uiState: { recentFolders: [{ path: "/srv/app", projectName: "App", lastAccessed: 2 }] },
    })
    const picker = page.locator("[data-embedded-project-picker]")
    await picker.waitFor()
    assert.equal(await page.locator(".tab-bar-instance").count(), 0)
    assert.equal(await page.locator(".folder-home-root").count(), 0)
    assert.equal(await page.locator(".browse-menu").count(), 0)
    await picker.getByRole("button", { name: "Browse Folders" }).waitFor()
    await picker.getByRole("button", { name: /App/ }).click()
    await page.waitForFunction(() => document.title === "App")
    assert.deepEqual(fixture.created, ["/srv/app"])
    const search = new URL(page.url()).searchParams
    assert.equal(search.get("codenomadEmbed"), "project")
    assert.equal(search.get("folder"), "/srv/app")
    assert.equal(await page.locator(".tab-bar-instance").count(), 0)
  } finally { await page.close() }
})

test("an embedded entry with a folder opens that project directly and reselects its remembered session", async () => {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 }, locale: "en-US" })
  try {
    // The view's storage persists with the server's remote window across host restarts.
    await page.addInitScript(() => localStorage.setItem("codenomad:embedded-session:/srv/other", "ses_saved"))
    const sessionReads: string[] = []
    page.on("request", request => { if (request.url().includes("ses_saved")) sessionReads.push(request.url()) })
    const fixture = await open(page, `?codenomadEmbed=project&folder=${encodeURIComponent("/srv/other")}`, { context: "remote", host: "electron" })
    await page.waitForFunction(() => document.title === "other")
    assert.deepEqual(fixture.created, ["/srv/other"])
    assert.equal(await page.locator("[data-embedded-project-picker]").count(), 0)
    // The remembered session is read back for selection, as a restored local tab's is.
    for (let attempt = 0; attempt < 50 && !sessionReads.length; attempt++) await page.waitForTimeout(100)
    assert.ok(sessionReads.length > 0, "the remembered session is hydrated")
    assert.equal(await page.evaluate(() => localStorage.getItem("codenomad:embedded-session:/srv/other")), "ses_saved",
      "the empty startup selection does not overwrite the remembered session")
  } finally { await page.close() }
})

test("an embedded project without a remembered session reads none", async () => {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 }, locale: "en-US" })
  try {
    const sessionReads: string[] = []
    page.on("request", request => { if (/\/session\/ses_/.test(request.url())) sessionReads.push(request.url()) })
    await open(page, `?codenomadEmbed=project&folder=${encodeURIComponent("/srv/fresh")}`, { context: "remote", host: "electron" })
    await page.waitForFunction(() => document.title === "fresh")
    await page.waitForTimeout(500)
    assert.deepEqual(sessionReads, [])
  } finally { await page.close() }
})

test("without the parameter a remote page keeps its full interface and lists no remote servers", async () => {
  for (const scenario of [{ context: "remote", host: "electron" }, {}] as Scenario[]) {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, locale: "en-US" })
    try {
      await open(page, "", { ...scenario, uiState: { remoteServers: [server("box")] } })
      await page.locator(".folder-home-root").waitFor()
      // A web client or Remote Control device browses only its own folders, never another server (no rebound).
      await browse(page)
      await page.getByRole("button", { name: "This computer", exact: true }).waitFor()
      assert.equal(await page.locator("[data-remote-server]").count(), 0)
      assert.equal(await page.getByRole("button", { name: "New server" }).count(), 0)
      assert.equal(await page.getByRole("textbox", { name: "Server address or link" }).count(), 0)
    } finally { await page.close() }
  }
})

test("a local window opens a saved server as a project tab whose view follows the project it shows", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, locale: "en-US" })
  try {
    const fixture = await open(page, "", { context: "local", host: "electron", uiState: { remoteServers: [server("box"), server("lab", { skipTlsVerify: true })] } })
    await browse(page)
    await page.getByRole("button", { name: "Open a project on Box" }).click()
    await chooseRemoteRoot(page)
    const tab = page.locator(".tab-pill", { hasText: "/" })
    await tab.waitFor()
    await page.waitForFunction(() => (window as any).fixtureViews.opened.length === 1)
    const [opened] = (await views(page)).opened
    assert.equal(opened.profileId, "box")
    assert.equal(opened.baseUrl, BOX)
    assert.equal(opened.url, `${BOX}/?codenomadEmbed=project&folder=%2F`)
    assert.ok(opened.bounds.width > 100 && opened.bounds.height > 100)

    // The embedded page reports its project: the tab takes its name and the host remembers it.
    await page.evaluate(({ viewId, base }) => {
      for (const listener of (window as any).fixtureViews.listeners) listener({ viewId, url: `${base}/?codenomadEmbed=project&folder=%2Fsrv%2Fapp`, title: "App" })
      // An older server's own title never relabels the tab.
      for (const listener of (window as any).fixtureViews.listeners) listener({ viewId, url: `${base}/?codenomadEmbed=project`, title: "CodeNomad" })
    }, { viewId: opened.viewId, base: BOX })
    const projectTab = page.locator(".tab-pill", { hasText: "App" })
    await projectTab.waitFor()
    // The server icon marks a remote project.
    assert.equal(await projectTab.locator("svg").count() >= 1, true)
    type Saved = { remoteProjectRecents?: Array<{ profileId: string; folder: string; projectName?: string }> }
    for (let attempt = 0; attempt < 50 && !(fixture.state() as Saved).remoteProjectRecents?.length; attempt++) await page.waitForTimeout(100)
    const recents = (fixture.state() as Saved).remoteProjectRecents
    assert.deepEqual(recents?.map(({ profileId, folder, projectName }) => ({ profileId, folder, projectName })), [{ profileId: "box", folder: "/srv/app", projectName: "App" }])

    // A local overlay (the home page) hides the native view; it never covers local dialogs.
    await page.getByRole("button", { name: "Home", exact: true }).click()
    await page.waitForFunction((viewId) => (window as any).fixtureViews.updates.some((update: { viewId: string; visible: boolean }) => update.viewId === viewId && !update.visible), opened.viewId)

    // A server with an unverified certificate keeps its separate window.
    await browse(page)
    await page.getByRole("button", { name: "Open a project on lab" }).click()
    await chooseRemoteRoot(page)
    await page.waitForFunction(() => (window as any).fixtureViews.windows.length === 1)
    assert.equal((await views(page)).windows[0].id, "lab")
    assert.equal((await views(page)).windows[0].entryUrl, 'https://lab.example/?codenomadEmbed=project&folder=%2F')
    assert.equal((await views(page)).opened.length, 1)
  } finally { await page.close() }
})

test("a pairing-link profile browses with the backend's device and fills its blank tab only on project selection", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, locale: 'en-US' })
  try {
    const f = await open(page, '', { context: 'local', host: 'electron', remoteNeedsPassword: true, pairingWorks: true,
      sidecars: [sidecar('docs', 'Docs', 'running')] })
    await browse(page)
    await page.locator('[data-sidecar="docs"]').click()
    await page.locator('.new-instance-button').click()
    const blank = page.locator('[data-tab-kind="blank"][data-tab-visible="true"]')
    await page.waitForFunction(() => document.activeElement?.matches('.folder-home-recent-primary-action, [data-browse-nav]'))
    const code = 'p'.repeat(32)
    const field = blank.getByRole('textbox', { name: 'Server address or link' })
    await field.fill(`https://paired.example.test/remote-pair#${code}`)
    await field.press('Enter')
    const row = blank.getByRole('button', { name: 'Open a project on paired.example.test' })
    await row.waitFor()
    await page.waitForFunction(() => document.activeElement?.textContent === 'paired.example.test')
    assert.equal(await field.inputValue(), '')
    assert.equal((await views(page)).opened.length, 0)
    assert.equal(JSON.stringify(f.state()).includes(code), false)
    await row.click()
    const recent = blank.getByRole('button', { name: /Remote recent/ })
    await recent.waitFor()
    assert.equal(await blank.getByRole('textbox', { name: 'Password', exact: true }).count(), 0)
    assert.equal((await views(page)).opened.length, 0)
    await recent.click()
    await page.waitForFunction(() => (window as any).fixtureViews.opened.length === 1)
    assert.equal(await page.locator('[data-tab-kind="blank"]').count(), 0)
    assert.equal((await views(page)).opened[0].url, 'https://paired.example.test/?codenomadEmbed=project&folder=%2Fsrv%2Frecent')
    assert.equal(JSON.stringify(f.state()).includes(code), false)
  } finally { await page.close() }
})

for (const [code, message] of [
  ['pairing_unavailable', 'Server-side Remote Control pairing unavailable.'],
  ['pairing_expired', 'Pairing link invalid or expired.'],
  ['pairing_rate_limited', 'Too many pairing attempts. Try again later.'],
] as const) test(`${code}: a refused exchange clears its link and permits inline password recovery`, async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, locale: 'en-US' })
  try {
    const f = await open(page, '', { context: 'local', host: 'electron', remoteNeedsPassword: true, pairingError: code })
    const field = await addServer(page, `https://older.example.test/remote-pair#${'x'.repeat(32)}`)
    await page.getByRole('alert').getByText(message, { exact: true }).waitFor()
    if (code === 'pairing_unavailable') await capture(page, '13-pairing-error')
    assert.equal(await field.inputValue(), '')
    assert.equal(JSON.stringify(f.state()).includes('x'.repeat(32)), false)
    const serverRow = page.getByRole('button', { name: 'Open a project on older.example.test' })
    await serverRow.getByText('Sign-in required', { exact: true }).waitFor()
    await serverRow.click()
    await page.getByRole('textbox', { name: 'Password', exact: true }).waitFor()
    assert.equal(await page.getByRole('dialog').count(), 0)
    assert.equal((await views(page)).opened.length, 0)
    await page.locator('input[type="password"]').fill('fixture-password')
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await page.locator('.remote-server-path').getByRole('button', { name: 'Open', exact: true }).waitFor()
    await page.getByRole('button', { name: 'Back to Browse', exact: true }).click()
    assert.equal(await serverRow.getByText('Sign-in required', { exact: true }).count(), 0)
  } finally { await page.close() }
})

test("Browse refuses address credentials and saves a pairing server while reporting unavailable pairing", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, locale: "en-US" })
  try {
    const fixture = await open(page, "", { context: "local", host: "electron" })
    const field = await addServer(page, "http://user:secret@box.example:4096")
    await page.getByRole("alert").getByText("Remove the user name and password from the address.").waitFor()
    assert.deepEqual(fixture.probes, [])

    // A pasted link saves its origin and attempts backend pairing without opening a native view.
    const tunnel = "https://desk.opentunnel.test"
    await field.fill("")
    await field.evaluate((input, link) => {
      const data = new DataTransfer()
      data.setData("text", link)
      input.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }))
    }, `${tunnel}/remote-pair#single-use-code`)
    const row = page.getByRole("button", { name: "Open a project on desk.opentunnel.test" })
    await row.waitFor()
    await page.waitForFunction(() => document.activeElement?.getAttribute("data-remote-server"))
    assert.equal((await views(page)).opened.length, 0)
    assert.equal((await views(page)).windows.length, 0)
    await page.getByRole('alert').getByText('Server-side Remote Control pairing unavailable.').waitFor()
    assert.equal((await views(page)).opened.length, 0)
    assert.equal(JSON.stringify(fixture.state()).includes("single-use-code"), false)
    assert.deepEqual((fixture.state() as { remoteServers: Array<{ baseUrl: string }> }).remoteServers.map((entry) => entry.baseUrl), [tunnel])
    assert.equal(await page.getByRole("dialog").count(), 0)
  } finally { await page.close() }
})

test("an address added in Browse receives focus; choosing a folder opens its tab", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, locale: "en-US" })
  try {
    const fixture = await open(page, "", { context: "local", host: "electron", uiState: { remoteServers: [server("box")] } })
    await addServer(page, "https://lab.example:8443")
    const row = page.getByRole("button", { name: "Open a project on lab.example" })
    await row.waitFor()
    await page.waitForFunction(() => document.activeElement?.textContent === "lab.example")
    assert.equal((await views(page)).opened.length, 0)
    assert.equal((await views(page)).windows.length, 0)
    await row.click()
    await chooseRemoteRoot(page)
    await page.locator(".tab-pill", { hasText: "/" }).waitFor()
    await page.waitForFunction(() => (window as any).fixtureViews.opened.length === 1)
    type Saved = { remoteServers: Array<{ id: string; name: string; baseUrl: string }> }
    const added = (fixture.state() as Saved).remoteServers.find((entry) => entry.baseUrl === "https://lab.example:8443")!
    assert.equal(added.name, "lab.example:8443", "saved under its host, shown as its host name")
    assert.deepEqual(fixture.probes, ["https://lab.example:8443 skipTls=false"])

    // The saved server opens again without a second profile or a probe.
    await page.getByRole("button", { name: "Home", exact: true }).click()
    await addServer(page, BOX)
    await page.waitForFunction(() => document.activeElement?.textContent === "Box")
    assert.equal((await views(page)).opened.length, 1)
    await page.getByRole("button", { name: "Open a project on Box" }).click()
    await chooseRemoteRoot(page)
    await page.waitForFunction(() => (window as any).fixtureViews.opened.length === 2)
    assert.equal((await views(page)).opened[1].profileId, "box")
    assert.deepEqual((fixture.state() as Saved).remoteServers.map((entry) => entry.id).sort(), [added.id, "box"].sort())
    assert.equal(fixture.probes.length, 1)
    assert.equal(await page.getByRole("dialog").count(), 0)
  } finally { await page.close() }
})

test("Browse lists saved servers by name and the selected root tab shows its folder", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, locale: "en-US" })
  try {
    // An existing user's profiles, one saved under its pasted address.
    const pasted = server("pasted", { name: "127.0.0.1:9911", baseUrl: "http://127.0.0.1:9911" })
    await open(page, "", { context: "local", host: "electron", uiState: { remoteServers: [server("box"), pasted] } })
    await page.locator(".folder-home-root").waitFor()
    await browse(page)
    assert.deepEqual(await page.locator(".browse-menu-row").allTextContents(), ["This computer", "Box", "127.0.0.1"])
    // Servers are managed in Settings, not from Browse.
    await page.getByRole("button", { name: "Open a project on Box" }).click({ button: "right" })
    assert.equal(await page.getByRole("menuitem").count(), 0)
    await page.getByRole("button", { name: "Open a project on 127.0.0.1" }).click()
    await chooseRemoteRoot(page)
    await page.locator(".tab-pill", { hasText: "/" }).waitFor()
    assert.equal(await page.locator(".tab-pill", { hasText: "127.0.0.1:9911" }).count(), 0)
  } finally { await page.close() }
})

test("a certificate that fails the check offers skipping it under the field; the server then opens in its own window", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, locale: "en-US" })
  try {
    const fixture = await open(page, "", { context: "local", host: "electron" })
    const field = await addServer(page, "https://selfsigned.example")
    await page.getByRole("alert").getByText("Certificate check failed.", { exact: true }).waitFor()
    await capture(page, '12-tls')
    const skip = page.getByRole("checkbox", { name: "Skip TLS verification" })
    await skip.check()
    await field.press("Enter")
    const row = page.getByRole("button", { name: "Open a project on selfsigned.example" })
    await row.waitFor()
    assert.equal((await views(page)).windows.length, 0, "TLS confirmation saves only")
    await row.click()
    await page.getByRole('button', { name: 'Open in a separate window', exact: true }).waitFor()
    await chooseRemoteRoot(page)
    await page.waitForFunction(() => (window as any).fixtureViews.windows.length === 1)
    assert.equal((await views(page)).opened.length, 0, "an unverified certificate never opens a tab")
    assert.deepEqual(fixture.probes, ["https://selfsigned.example skipTls=false", "https://selfsigned.example skipTls=true"])
    const saved = (fixture.state() as { remoteServers: Array<{ baseUrl: string; skipTlsVerify: boolean }> }).remoteServers
    assert.deepEqual(saved.map((entry) => [entry.baseUrl, entry.skipTlsVerify]), [["https://selfsigned.example", true]])
    assert.equal(await page.getByRole("dialog").count(), 0)
  } finally { await page.close() }
})

const sidecar = (id: string, name: string, status: "running" | "stopped") => ({
  id, kind: "port", name, port: 3000, insecure: false, prefixMode: "strip", status,
  createdAt: "2026-11-01T10:00:00.000Z", updatedAt: "2026-11-01T10:00:00.000Z",
})

test("+ opens disposable blank tabs; remote and SideCar choices replace their originating blank tab in place", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, locale: "en-US" })
  try {
    const fixture = await open(page, "", { context: "local", host: "electron", uiState: { remoteServers: [server("box")] },
      sidecars: [sidecar("docs", "Docs", "running")] })
    await browse(page)
    await page.getByRole("button", { name: "Open a project on Box" }).click()
    await chooseRemoteRoot(page)
    await page.locator('.tab-pill', { hasText: '/' }).waitFor()
    await page.locator('.new-instance-button').click()
    const blank = page.locator('[data-tab-kind="blank"][data-tab-visible="true"]')
    await blank.waitFor()
    assert.equal(await page.locator('.tab-pill').count(), 2, await page.locator('.tab-strip-tabs').innerText())
    assert.deepEqual(await blank.locator('.panel-header .panel-subtitle').allTextContents(), ['0 items', '3 items'])
    assert.equal(await blank.locator('.folder-home-root--blank').count(), 1)
    assert.deepEqual(fixture.created, [], 'blank tabs create no backend workspace')
    assert.deepEqual(await blank.locator('.folder-home-blank-actions button').allTextContents(), ['Temporary', 'Clone'])
    const layout = await blank.locator('.folder-home-blank-actions').boundingBox()
    const panel = await blank.locator('.folder-dashboard-servers').boundingBox()
    const brand = await blank.locator('.folder-home-hero').boundingBox()
    assert.ok(layout!.y >= brand!.y + brand!.height && layout!.y + layout!.height < panel!.y, 'creation sits between branding and both columns')
    assert.equal(await blank.locator('.browse-menu-footer button').count(), 1, 'only the existing server-add action remains in Browse')
    assert.equal(await blank.getByRole('button', { name: 'Clone', exact: true }).getAttribute('title'), 'Clone Git Repo')
    await page.setViewportSize({ width: 480, height: 800 })
    assert.equal(await blank.locator('.folder-home-root').evaluate(node => node.scrollWidth <= node.clientWidth), true)
    await page.setViewportSize({ width: 1200, height: 800 })

    // Open another blank, then fill the earlier one: its replacement keeps that earlier slot.
    const firstBlankId = await blank.getAttribute('data-tab-id')
    await page.locator('.new-instance-button').click()
    await page.locator(`[data-app-tab-id="${firstBlankId}"] [role=tab]`).click()
    await blank.getByRole('button', { name: 'Open a project on Box' }).click()
    assert.equal(await page.locator('[data-tab-kind="blank"]').count(), 2, 'browsing preserves both blanks')
    await blank.getByRole('button', { name: 'Remote recent · Box · /srv/recent', exact: true }).click()
    await page.waitForFunction(() => document.querySelectorAll('[data-tab-kind="blank"]').length === 1)
    assert.equal(await page.locator('[data-tab-kind="blank"]').count(), 1)
    assert.equal(await page.locator('.tab-pill').count(), 3)
    assert.match((await page.locator('.tab-strip-tabs > *').nth(1).getAttribute('data-app-tab-id'))!, /^remote-project:/)
    // Close the remaining blank: no saved record or resource is left.
    await page.locator('.tab-pill', { hasText: 'New tab' }).locator('.tab-pill-close').click()
    assert.equal(await page.locator('[data-tab-kind="blank"]').count(), 0)
    assert.deepEqual(fixture.created, [])
    assert.equal(JSON.stringify(fixture.state()).includes('blank:'), false)

    await page.locator('.new-instance-button').click()
    await blank.locator('[data-sidecar="docs"]').click()
    await page.locator('.tab-pill', { hasText: 'Docs' }).waitFor()
    assert.equal(await page.locator('[data-tab-kind="blank"]').count(), 0)
    assert.equal(await page.locator('.tab-pill').count(), 3)
  } finally { await page.close() }
})

for (const kind of ['remote recent', 'SideCar'] as const) test(`Browse ${kind}: Open joins separately while the primary action creates another occurrence`, async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, locale: 'en-US' })
  try {
    const fixture = await open(page, '', { context: 'local', host: 'electron', uiState: { remoteServers: [server('box')] },
      sidecars: [sidecar('docs', 'Docs', 'running')] })
    const choose = async () => {
      await browse(page)
      if (kind === 'remote recent') await page.getByRole('button', { name: 'Open a project on Box' }).click()
      if (kind === 'remote recent' && await page.getByRole('tab', { name: 'Recent tabs', exact: true }).count()) await page.getByRole('tab', { name: 'Recent tabs', exact: true }).click()
      return kind === 'remote recent'
        ? page.getByRole('button', { name: 'Remote recent · Box · /srv/recent', exact: true })
        : page.locator('[data-sidecar="docs"]')
    }
    await (await choose()).click()
    const original = await page.locator('.tab-strip-tabs > [data-app-tab-id]').first().getAttribute('data-app-tab-id')
    assert.ok(original)
    await page.locator('.new-instance-button').click()
    const blank = page.locator('[data-tab-kind="blank"][data-tab-visible="true"]')
    const blankId = await blank.getAttribute('data-tab-id')
    await choose()
    const join = blank.locator(kind === 'remote recent' ? '.folder-home-list-column' : '.browse-menu').getByRole('button', { name: /^Switch to open project ·/ })
    await join.waitFor()
    await join.focus()
    await join.press('Enter')
    await page.locator(`[data-tab-id="${original}"][data-tab-visible="true"]`).waitFor()
    assert.equal(await page.locator('.tab-pill').count(), 2, 'joining creates no occurrence')
    assert.equal(await page.locator(`[data-tab-id="${blankId}"]`).count(), 1, 'joining preserves the blank slot')
    await page.locator(`[data-app-tab-id="${blankId}"] [role=tab]`).click()
    await join.click()
    await page.locator(`[data-tab-id="${original}"][data-tab-visible="true"]`).waitFor()
    assert.equal(await page.locator('.tab-pill').count(), 2, 'pointer join also creates no occurrence')
    await page.locator(`[data-app-tab-id="${blankId}"] [role=tab]`).click()
    const primary = kind === 'remote recent'
      ? blank.getByRole('button', { name: 'Remote recent · Box · /srv/recent', exact: true })
      : blank.locator('.browse-menu [data-sidecar="docs"]')
    await primary.click()
    await blank.waitFor({ state: 'hidden' })
    assert.equal(await page.locator(`[data-tab-id="${blankId}"]`).count(), 0, 'primary replaces the blank slot')
    assert.equal(await page.locator('.tab-pill').count(), 2)
    assert.equal(await page.locator(`[data-tab-id="${original}"]`).count(), 1, 'the original occurrence remains')
    assert.notEqual(await page.locator('[data-tab-visible="true"]').getAttribute('data-tab-id'), original)
    assert.deepEqual(fixture.created, [])
  } finally { await page.close() }
})

test("a delayed server add preserves both blank tabs; clicking its row fills the chosen blank", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, locale: "en-US" })
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  try {
    await open(page, "", { context: "local", host: "electron", uiState: { remoteServers: [server("box")] } })
    await browse(page)
    await page.getByRole("button", { name: "Open a project on Box" }).click()
    await chooseRemoteRoot(page)
    await page.locator(".new-instance-button").click()
    const blank = page.locator('[data-tab-kind="blank"][data-tab-visible="true"]')
    const origin = await blank.getAttribute("data-tab-id")
    await page.route("**/api/remote-servers/probe", async route => { await held; await route.fallback() })
    const field = blank.getByRole("textbox", { name: "Server address or link" })
    await field.fill("https://slow.example")
    const pending = page.waitForRequest("**/api/remote-servers/probe")
    await field.press("Enter")
    await pending
    await page.locator(".new-instance-button").click()
    const other = await blank.getAttribute("data-tab-id")
    assert.notEqual(other, origin)
    release()
    const originView = page.locator(`[data-tab-id="${origin}"]`)
    await originView.locator('.browse-menu-row', { hasText: 'slow.example' }).waitFor({ state: "attached" })
    assert.equal(await page.locator(`[data-tab-id="${origin}"]`).count(), 1)
    assert.equal(await page.locator(`[data-tab-id="${other}"]`).count(), 1)
    await page.locator(`[data-app-tab-id="${origin}"] [role=tab]`).click()
    await originView.getByRole("button", { name: "Open a project on slow.example" }).click()
    await chooseRemoteRoot(page)
    assert.equal(await page.locator(`[data-tab-id="${origin}"]`).count(), 0)
    assert.match((await page.locator(".tab-strip-tabs > *").nth(1).getAttribute("data-app-tab-id"))!, /^remote-project:/)
  } finally { release(); await page.close() }
})

test("Home restores its styling; blank has centered branding and Recent tabs and Browse columns without SideCar creation or social links", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, locale: "en-US" })
  try {
    await open(page, "", { context: "local", host: "electron", uiState: {
      remoteServers: [server("box")],
      recentFolders: [{ path: "/srv/local", projectName: "Local", lastAccessed: Date.now() - 60000 }],
      remoteProjectRecents: [{ profileId: "box", folder: "/srv/remote", projectName: "Remote", lastAccessed: Date.now() - 120000 }],
      sidecarRecents: [{ sidecarId: "docs", lastAccessed: Date.now() - 180000 }],
    }, sidecars: [sidecar("docs", "Docs", "running")] })
    const initialHome = page.locator('.folder-home-root')
    const creation = (await initialHome.locator('.folder-home-create-column > .panel').first().boundingBox())!
    const recentPanel = (await initialHome.locator('.folder-home-list-panel').boundingBox())!
    assert.deepEqual({ x: creation.x, y: creation.y, width: creation.width }, { x: 120, y: 242, width: 472 })
    assert.deepEqual({ x: recentPanel.x, y: recentPanel.y, width: recentPanel.width }, { x: 608, y: 242, width: 472 })
    const creationColumn = (await initialHome.locator('.folder-home-create-column').boundingBox())!
    assert.equal(recentPanel.y + recentPanel.height, creationColumn.y + creationColumn.height)
    assert.equal((await initialHome.getByRole('button', { name: 'Clone Git Repo', exact: true }).boundingBox())!.height, 48)
    await capture(page, 'home-initial')
    await page.getByRole("button", { name: "Local · This computer · /srv/local", exact: true }).click()
    await page.locator('.tab-strip-tabs [role=tab]', { hasText: 'Local' }).waitFor()
    await page.getByRole("button", { name: "Home", exact: true }).click()
    const home = page.locator(".folder-home-root")
    await home.getByRole('tab', { name: 'Recent tabs', exact: true }).waitFor()
    assert.equal(await home.locator('[role=tablist] .badge-shape').count(), 0)
    assert.deepEqual(await home.locator('[role=tablist] .panel-subtitle').allTextContents(), ['3 items', '3 items'])
    await capture(page, 'home-desktop')
    await home.getByRole('tab', { name: 'Browse', exact: true }).click()
    await capture(page, '02-browse-dark')
    await home.getByRole('tab', { name: 'Recent tabs', exact: true }).click()
    await page.getByRole("button", { name: "Close", exact: true }).click()
    await page.locator(".new-instance-button").click()
    const blank = page.locator('[data-tab-kind="blank"][data-tab-visible="true"]')
    await page.waitForFunction(() => document.activeElement?.matches('.folder-home-recent-primary-action, [data-browse-nav]'))
    const root = blank.locator(".folder-home-root")
    assert.equal(await blank.getByRole("heading", { name: "CodeNomad", exact: true }).count(), 1)
    assert.equal(await blank.locator('.folder-home-logo').count(), 1)
    assert.deepEqual(await blank.locator('.panel-header h2').allTextContents(), ['Recent tabs', 'Browse'])
    assert.equal(await blank.getByRole('searchbox').count(), 0)
    const recentColumn = (await blank.locator('.folder-home-list-column').boundingBox())!
    const browseColumn = (await blank.locator('.folder-dashboard-servers').boundingBox())!
    assert.equal(recentColumn.y, browseColumn.y)
    assert.ok(recentColumn.x + recentColumn.width < browseColumn.x)
    assert.equal(recentColumn.width, browseColumn.width)
    assert.equal(await root.evaluate(node => getComputedStyle(node).backgroundColor), await page.locator('.tab-pill-active').evaluate(node => getComputedStyle(node).backgroundColor))
    const fieldBounds = (await blank.getByRole('textbox', { name: 'Server address or link' }).boundingBox())!
    const creationBounds = (await blank.locator('.folder-home-blank-actions').boundingBox())!
    assert.ok(fieldBounds.x >= browseColumn.x && fieldBounds.y >= browseColumn.y)
    assert.ok(fieldBounds.y + fieldBounds.height <= browseColumn.y + browseColumn.height)
    assert.ok(creationBounds.y + creationBounds.height < browseColumn.y)
    assert.equal(await blank.getByRole('button', { name: 'New SideCar', exact: true }).count(), 0)
    const row = blank.locator('.folder-home-recent-item').first()
    await row.locator('.folder-home-recent-primary-action').focus()
    await page.keyboard.press('Home')
    assert.equal(await row.evaluate(node => node.classList.contains('panel-list-item-highlight')), true)
    await row.locator('.folder-home-recent-primary-action').hover({ position: { x: 10, y: 10 } })
    await page.mouse.move(5, 700)
    assert.equal(await row.evaluate(node => node.classList.contains('panel-list-item-highlight')), false)
    const brand = (await blank.locator('.folder-home-identity').boundingBox())!
    const logo = (await blank.locator('.folder-home-logo').boundingBox())!
    assert.ok(Math.abs(logo.x + logo.width / 2 - brand.x - brand.width / 2) < 1)
    assert.equal(await blank.getByRole('link').count(), 0)
    assert.equal(await blank.locator('.locale-selector, .panel-section, .version-pill, .absolute.top-4').count(), 0)
    assert.equal(await blank.locator('.folder-home-open-instance-button').count(), 1)
    assert.equal(await blank.locator('.folder-home-open-instance-button').getAttribute('title'), 'Switch to open project')
    assert.equal(await blank.locator('.folder-home-open-instance-button').evaluate(node => getComputedStyle(node).textTransform), 'uppercase')
    assert.equal(await blank.getByText('Box', { exact: true }).count(), 2)
    assert.equal(await blank.getByText('/srv/remote', { exact: true }).count(), 1)
    await capture(page, 'blank-desktop')
    await page.setViewportSize({ width: 480, height: 800 })
    await capture(page, 'blank-narrow')
    assert.equal(await root.evaluate(node => node.scrollWidth <= node.clientWidth), true)
    await page.setViewportSize({ width: 1200, height: 800 })
    const field = blank.getByRole('textbox', { name: 'Server address or link' })
    await field.fill('https://added.example')
    await field.press('Enter')
    const added = blank.getByRole('button', { name: 'Open a project on added.example' })
    await added.waitFor()
    await page.waitForFunction(() => document.activeElement?.textContent === 'added.example')
    assert.equal(await page.locator('[data-tab-kind="blank"]').count(), 1)
    await added.click()
    assert.equal(await page.locator('[data-tab-kind="blank"]').count(), 1)
    await chooseRemoteRoot(page)
    assert.equal(await page.locator('[data-tab-kind="blank"]').count(), 0)
  } finally { await page.close() }
})

test("the quick launcher delegates browsing, authentication and server addition to a blank tab", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, locale: "en-US" })
  try {
    const fixture = await open(page, "", { context: "local", host: "electron", uiState: { remoteServers: [server('box')] } })
    await browse(page)
    await page.getByRole('button', { name: 'Open a project on Box' }).click()
    await chooseRemoteRoot(page)
    await page.locator('.new-instance-button').click({ button: 'right' })
    const launcher = page.locator('.new-instance-launcher')
    await launcher.getByRole('heading', { name: 'Recent tabs', exact: true }).waitFor()
    await capture(page, '09-launcher')
    assert.equal(await launcher.locator('.browse-menu, input[type=password], [data-server-add-field], .new-tab-actions').count(), 0)
    assert.equal(await launcher.getByRole('button', { name: 'Open another project…', exact: true }).count(), 0)
    await page.keyboard.press('Escape')
    await launcher.waitFor({ state: 'hidden' })
    await page.locator('.new-instance-button').click()
    const blank = page.locator('[data-tab-kind="blank"][data-tab-visible="true"]')
    await page.waitForFunction(() => document.activeElement?.matches('.folder-home-recent-primary-action, [data-browse-nav]'))
    const field = blank.getByRole('textbox', { name: 'Server address or link' })
    await field.fill('https://launcher.example')
    await field.press('Enter')
    const row = blank.getByRole('button', { name: 'Open a project on launcher.example' })
    await row.waitFor()
    await page.waitForFunction(() => document.activeElement?.textContent === 'launcher.example')
    assert.equal((await views(page)).opened.length, 1)
    assert.equal((await views(page)).windows.length, 0)
    assert.deepEqual(fixture.created, [])
    await row.click()
    await blank.locator('.remote-server-path').getByRole('button', { name: 'Open', exact: true }).click()
    await blank.waitFor({ state: 'hidden' })
    await page.waitForFunction(() => (window as any).fixtureViews.opened.length === 2)
  } finally { await page.close() }
})

for (const host of ['web', 'electron', 'tauri'] as const) test(`${host}: the logo opens Home; Sponsor uses the existing help URL; a local choice replaces a blank tab`, async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, locale: 'en-US' })
  try {
    const fixture = await open(page, '', { context: 'local', host, uiState: { recentFolders: [{ path: '/srv/local', projectName: 'Local', lastAccessed: 2 }] },
      sidecars: [sidecar('docs', 'Docs', 'running')] })
    const sponsor = page.getByRole('link', { name: 'Sponsor', exact: true })
    assert.equal(await sponsor.getAttribute('href'), 'https://neuralnomadsai.github.io/CodeNomad/en/sponsor.html')
    await page.evaluate(() => { (window as any).externalURLs = []; window.open = ((url: string) => { (window as any).externalURLs.push(url); return null }) as any })
    await sponsor.click()
    await page.waitForFunction(() => (window as any).externalURLs.length === 1)
    assert.deepEqual(await page.evaluate(() => (window as any).externalURLs), ['https://neuralnomadsai.github.io/CodeNomad/en/sponsor.html'])
    await page.getByRole('tab', { name: 'Browse', exact: true }).click()
    await page.locator('[data-sidecar="docs"]').click()
    await page.locator('.tab-pill', { hasText: 'Docs' }).waitFor()
    await page.getByRole('button', { name: 'Home', exact: true }).click()
    await page.locator('.folder-home-root').waitFor()
    await page.getByRole('button', { name: 'Close', exact: true }).click()
    await page.locator('.new-instance-button').click()
    const blank = page.locator('[data-tab-kind="blank"][data-tab-visible="true"]')
    await blank.getByRole('button', { name: 'Local · This computer · /srv/local', exact: true }).click()
    await page.waitForFunction(() => !document.querySelector('[data-tab-kind="blank"]'))
    assert.deepEqual(fixture.created, ['/srv/local'])
    assert.equal(await page.locator('.tab-strip-tabs [role="tab"]').count(), 2)
  } finally { await page.close() }
})

test("Browse opens a running SideCar, which then joins the recent tabs of the home page and the launcher", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, locale: "en-US" })
  try {
    const fixture = await open(page, "", {
      context: "local", host: "electron", uiState: { remoteServers: [server("box")] },
      sidecars: [sidecar("docs", "Docs", "running"), sidecar("wiki", "Wiki", "stopped")],
    })
    await page.locator(".folder-home-root").waitFor()
    // The former Open SideCar button and its window are gone.
    assert.equal(await page.getByRole("button", { name: "Open SideCar" }).count(), 0)
    assert.equal(await page.getByRole("dialog").count(), 0)

    await browse(page)
    const rows = page.locator(".browse-menu-row")
    await page.locator('[data-sidecar="docs"]').waitFor()
    assert.deepEqual(await rows.allTextContents(), ["This computer", "Box", "DocsRunning", "WikiStopped"])
    // A stopped SideCar shows its state and cannot open.
    assert.equal(await page.locator('[data-sidecar="wiki"]').isDisabled(), true)
    await page.locator('[data-sidecar="docs"]').click()
    await page.locator(".tab-pill", { hasText: "Docs" }).waitFor()
    assert.equal(await page.locator(".folder-home-root").count(), 0)

    // Only its id is remembered, never its address or a proxy token.
    type Saved = { sidecarRecents?: Array<Record<string, unknown>> }
    for (let attempt = 0; attempt < 50 && !(fixture.state() as Saved).sidecarRecents?.length; attempt++) await page.waitForTimeout(100)
    const saved = (fixture.state() as Saved).sidecarRecents!
    assert.deepEqual(saved.map((entry) => Object.keys(entry).sort()), [["lastAccessed", "sidecarId"]])
    assert.equal(saved[0].sidecarId, "docs")

    await page.getByRole("button", { name: "Home", exact: true }).click()
    const recent = page.locator('.folder-home-recent-item[data-sidecar="docs"]')
    await recent.waitFor()
    assert.match(await recent.innerText(), /Docs[\s\S]*SideCar/)
    await recent.locator(".folder-home-recent-primary-action").click()
    await page.waitForFunction(() => document.querySelectorAll(".tab-pill").length === 2)

    // The quick launcher only lists recents; its Open badge joins the existing occurrence.
    await page.locator(".new-instance-button").click({ button: "right" })
    const launcher = page.locator(".new-instance-launcher")
    const quickRecent = launcher.locator('.new-instance-launcher-recent[data-sidecar="docs"]')
    await quickRecent.waitFor()
    assert.equal(await launcher.locator('.browse-menu').count(), 0)
    await quickRecent.locator('.folder-home-open-instance-button').click()
    await launcher.waitFor({ state: 'hidden' })
    assert.equal(await page.locator('.tab-pill').count(), 2)
  } finally { await page.close() }
})

test("New SideCar opens the SideCar form in Settings on its name field", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, locale: "en-US" })
  try {
    // A web client shows Settings in the window; servers stay out of it.
    await open(page, "", {})
    await page.locator(".folder-home-root").waitFor()
    assert.equal(await page.getByRole("button", { name: "New server" }).count(), 0)
    await page.getByRole("button", { name: "New SideCar", exact: true }).click()
    await page.waitForFunction(() => document.activeElement?.id === "sidecar-add")
    assert.equal(await page.locator('.settings-nav-button[aria-current="page"]').innerText(), "SideCars")
  } finally { await page.close() }
})

for (const code of ['tls_error', 'ECONNREFUSED fixture diagnostic'] as const) test(`${code}: remote failure stays inline with a short error and retry`, async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, locale: 'en-US' })
  try {
    await open(page, '', { context: 'local', host: 'electron', uiState: { remoteServers: [server('box')] } })
    await page.route('**/api/remote-servers/box/browse', route => route.fulfill({ status: 409, json: { error: code } }))
    await browse(page)
    await page.getByRole('button', { name: 'Open a project on Box', exact: true }).click()
    const remote = page.locator('.remote-server-browser')
    await remote.getByRole('alert').getByText(code === 'tls_error' ? 'Certificate check failed.' : 'Server unreachable.', { exact: true }).waitFor()
    assert.equal(await remote.getByRole('button', { name: 'Back to Browse', exact: true }).count(), 1)
    assert.equal(await page.getByRole('dialog').count(), 0)
    assert.deepEqual((await views(page)).opened, [])
    assert.equal(await remote.getByText('ECONNREFUSED fixture diagnostic', { exact: true }).count(), 0)
    await page.unroute('**/api/remote-servers/box/browse')
    await remote.getByRole('button', { name: 'Retry', exact: true }).click()
    await remote.locator('[data-remote-folder]').waitFor()
    assert.equal(await remote.getByRole('alert').count(), 0)
  } finally { await page.close() }
})

for (const kind of ['local', 'remote', 'SideCar'] as const) test(`${kind}: recent primary actions create occurrences and Open joins without duplication`, async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, locale: 'en-US' })
  try {
    const fixture = await open(page, '', { context: 'local', host: 'electron', uiState: {
      remoteServers: [server('box')],
      recentFolders: kind === 'local' ? [{ path: '/srv/local', projectName: 'Local', lastAccessed: 1 }] : [],
      remoteProjectRecents: kind === 'remote' ? [{ profileId: 'box', folder: '/srv/remote', projectName: 'Remote', lastAccessed: 1 }] : [],
      sidecarRecents: kind === 'SideCar' ? [{ sidecarId: 'docs', lastAccessed: 1 }] : [],
    }, sidecars: [sidecar('docs', 'Docs', 'running')] })
    const home = page.locator('.folder-home-root')
    await home.getByRole('tab', { name: 'Browse', exact: true }).click()
    await home.locator('[data-sidecar="docs"]').waitFor()
    await home.getByRole('tab', { name: 'Recent tabs', exact: true }).click()
    await home.locator('.folder-home-recent-primary-action').click()
    await page.locator('.tab-strip-tabs [role=tab]').first().waitFor()
    assert.equal(await page.locator('.tab-strip-tabs [role=tab]').count(), 1)
    const original = await page.locator('.tab-strip-tabs > [data-app-tab-id]').first().getAttribute('data-app-tab-id')
    await page.getByRole('button', { name: 'Home', exact: true }).click()
    await home.locator('.folder-home-open-instance-button').click()
    assert.equal(await page.locator('.tab-strip-tabs [role=tab]').count(), 1)
    await page.getByRole('button', { name: 'Home', exact: true }).click()
    await home.locator('.folder-home-recent-primary-action').click()
    await page.waitForFunction(() => document.querySelectorAll('.tab-strip-tabs [role=tab]').length === 2)
    const ids = await page.locator('.tab-strip-tabs > [data-app-tab-id]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-app-tab-id')))
    assert.equal(new Set(ids).size, 2)
    assert.equal(ids[0], original)
    await page.locator('.new-instance-button').click({ button: 'right' })
    const quick = page.locator('.new-instance-launcher')
    await quick.locator('.new-instance-launcher-recent .folder-home-open-instance-button').focus()
    if (kind === 'local') {
      await capture(page, 'A-quick-populated')
      await page.setViewportSize({ width: 480, height: 800 })
      await capture(page, 'A-quick-narrow')
      await page.setViewportSize({ width: 1200, height: 800 })
    }
    await page.keyboard.press('Enter')
    await quick.waitFor({ state: 'hidden' })
    assert.equal(await page.locator('.tab-strip-tabs [role=tab]').count(), 2)
    await page.locator('.new-instance-button').click({ button: 'right' })
    await quick.locator('.new-instance-launcher-recent-primary').click()
    await page.waitForFunction(() => document.querySelectorAll('.tab-strip-tabs [role=tab]').length === 3)
    await page.locator('.new-instance-button').click()
    const blank = page.locator('[data-tab-kind="blank"][data-tab-visible="true"]')
    await blank.locator('.folder-home-recent-primary-action').click()
    await page.waitForFunction(() => !document.querySelector('[data-tab-kind="blank"]') && document.querySelectorAll('.tab-strip-tabs [role=tab]').length === 4)
    if (kind === 'local') assert.deepEqual(fixture.created, Array(4).fill('/srv/local'))
    if (kind === 'remote') {
      await page.waitForFunction(() => (window as any).fixtureViews.opened.length === 4)
      assert.equal(new Set((await views(page)).opened.map(view => view.viewId)).size, 4)
    }
  } finally { await page.close() }
})

test("a restored window reopens its remote project tabs on their server and folder", async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, locale: "en-US" })
  try {
    await open(page, "", {
      context: "local", host: "electron",
      uiState: { remoteServers: [server("box")] },
      restore: { version: 1, revision: 1, savedAt: 1, layout: {}, session: {
        activeTabIndex: 0,
        tabs: [{ kind: "remote-project", profileId: "box", folder: "/srv/app" }, { kind: "remote-project", profileId: "removed" }],
      } },
    })
    await page.locator(".tab-pill", { hasText: "app" }).waitFor()
    await page.waitForFunction(() => (window as any).fixtureViews.opened.length === 1)
    const [opened] = (await views(page)).opened
    assert.equal(opened.url, `${BOX}/?codenomadEmbed=project&folder=%2Fsrv%2Fapp`)
    // A removed server's tab is dropped.
    assert.equal(await page.locator(".tab-pill").count(), 1)
  } finally { await page.close() }
})

for (const surface of ['Home', 'blank', 'launcher'] as const) test(`${surface}: recent login stays inline until a session is available; Back and Escape restore the row`, async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, locale: 'en-US' })
  try {
    const f = await open(page, '', { context: 'local', host: 'electron', remoteNeedsPassword: true,
      uiState: { remoteServers: [server('box')], remoteProjectRecents: [{ profileId: 'box', folder: '/srv/remote', projectName: 'Remote', lastAccessed: RECENT_TIME }] },
      sidecars: [sidecar('docs', 'Docs', 'running')] })
    if (surface !== 'Home') {
      await browse(page)
      await page.locator('[data-sidecar="docs"]').click()
      await page.locator('.new-instance-button').click(surface === 'launcher' ? { button: 'right' } : {})
    }
    const scope = surface === 'launcher' ? page.locator('.recent-tabs-menu') : page.locator('.folder-home-list-column:visible')
    const row = scope.getByRole('button', { name: 'Remote · Box · /srv/remote', exact: true })
    const previousTabs = await page.locator('.tab-pill').count()
    await row.click()
    const password = scope.getByRole('textbox', { name: 'Password', exact: true })
    await password.waitFor()
    assert.equal(await page.locator('[data-remote-project-view]').count(), 0)
    assert.equal(await page.locator('.tab-pill').count(), previousTabs)
    assert.equal(await scope.getByRole('textbox', { name: 'Username', exact: true }).inputValue(), 'codenomad')
    await page.waitForFunction(() => document.activeElement?.getAttribute('type') === 'password')
    await password.press('Escape')
    await row.waitFor()
    await row.click()
    await password.waitFor()
    await scope.getByRole('button', { name: 'Back to Browse', exact: true }).click()
    await row.waitFor()
    await row.click()
    await password.fill('wrong')
    await scope.getByRole('button', { name: 'Sign in', exact: true }).click()
    await scope.getByRole('alert').waitFor()
    assert.equal(await password.inputValue(), '')
    await password.fill('fixture-password')
    await scope.getByRole('button', { name: 'Sign in', exact: true }).click()
    await page.waitForFunction(() => (window as any).fixtureViews.opened.length === 1)
    const [opened] = (await views(page)).opened
    assert.equal(opened.cookie?.value, 'fixture-session-secret')
    assert.equal(opened.url, `${BOX}/?codenomadEmbed=project&folder=%2Fsrv%2Fremote`)
    assert.equal(JSON.stringify(f.state()).includes('fixture-session-secret'), false)
    assert.equal(JSON.stringify(f.state()).includes('fixture-password'), false)
    assert.equal(await page.locator('input[type=password]').count(), 0)
  } finally { await page.close() }
})

test('recent session without credentials has no form; unreachable stays inline and Retry opens its tab', async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, locale: 'en-US' })
  try {
    await open(page, '', { context: 'local', host: 'electron', uiState: { remoteServers: [server('box')],
      remoteProjectRecents: [{ profileId: 'box', folder: '/srv/remote', projectName: 'Remote', lastAccessed: RECENT_TIME }] } })
    let failed = true
    await page.route('**/api/remote-servers/box/view-session', async route => {
      if (failed) { failed = false; return route.fulfill({ status: 409, json: { error: 'unreachable' } }) }
      await route.fallback()
    })
    await page.getByRole('button', { name: 'Remote · Box · /srv/remote', exact: true }).click()
    await page.getByRole('alert').getByText('Server unreachable.', { exact: true }).waitFor()
    assert.equal(await page.locator('[data-remote-project-view]').count(), 0)
    assert.equal(await page.locator('input[type=password]').count(), 0)
    await page.getByRole('button', { name: 'Retry', exact: true }).click()
    await page.waitForFunction(() => (window as any).fixtureViews.opened.length === 1)
    assert.equal((await views(page)).opened[0].cookie?.value, 'fixture-session-secret')
    assert.equal(await page.locator('input[type=password]').count(), 0)
  } finally { await page.close() }
})

test('restored remote tab requests a session and signs in using the shared Browse form', async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, locale: 'en-US' })
  try {
    const f = await open(page, '', { context: 'local', host: 'electron', remoteNeedsPassword: true,
      uiState: { remoteServers: [server('box')] },
      restore: { version: 1, revision: 1, savedAt: 1, layout: {}, session: {
        activeTabIndex: 0, tabs: [{ kind: 'remote-project', profileId: 'box', folder: '/srv/app' }],
      } } })
    const tab = page.locator('[data-remote-project-view]')
    await tab.getByRole('textbox', { name: 'Password', exact: true }).fill('fixture-password')
    assert.deepEqual((await views(page)).opened, [])
    assert.equal(await tab.getByRole('textbox', { name: 'Username', exact: true }).inputValue(), 'codenomad')
    await tab.getByRole('button', { name: 'Sign in', exact: true }).click()
    await page.waitForFunction(() => (window as any).fixtureViews.opened.length === 1)
    assert.equal((await views(page)).opened[0].cookie?.value, 'fixture-session-secret')
    assert.equal(JSON.stringify(f.state()).includes('fixture-session-secret'), false)
  } finally { await page.close() }
})

for (const change of ['back', 'profile'] as const) test(`view session fences a pending response after ${change}`, async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, locale: 'en-US' })
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let requested!: () => void
  const pending = new Promise<void>(resolve => { requested = resolve })
  let settled!: () => void
  const finished = new Promise<void>(resolve => { settled = resolve })
  try {
    const f = await open(page, '', { context: 'local', host: 'electron', remoteNeedsPassword: true,
      uiState: { remoteServers: [server('box')], remoteProjectRecents: [{ profileId: 'box', folder: '/srv/remote', projectName: 'Remote', lastAccessed: RECENT_TIME }] } })
    await page.route('**/api/remote-servers/box/view-session', async route => {
      requested()
      await held
      try { await route.fulfill({ json: { cookie: { origin: BOX, name: 'codenomad_session', value: 'stale-session-secret', path: '/', secure: true, httpOnly: true, sameSite: 'lax' } } }) }
      finally { settled() }
    })
    await page.getByRole('button', { name: 'Remote · Box · /srv/remote', exact: true }).click()
    await pending
    if (change === 'back') {
      // Back disposes the preflight without opening a tab.
      await page.locator('[data-remote-view-session]').getByRole('button', { name: 'Back to Browse', exact: true }).click()
    } else {
      await page.evaluate(async () => {
        const path = '/src/lib/storage.ts'
        const { storage } = await import(path)
        await storage.patchStateOwner('ui', { remoteServers: [] })
      })
      await page.locator('[data-remote-view-session]').waitFor({ state: 'detached' })
    }
    release()
    await finished
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    assert.deepEqual((await views(page)).opened, [])
    assert.equal(await page.locator('[data-remote-project-view]').count(), 0)
    assert.equal(JSON.stringify(f.state()).includes('stale-session-secret'), false)
  } finally { release(); await page.close() }
})

for (const credentials of ['available', 'needs_credentials', 'auth'] as const) test(`separate Electron window: ${credentials} backend credentials preserve native opening`, async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, locale: 'en-US' })
  try {
    const f = await open(page, '', { context: 'local', host: 'electron', uiState: { remoteServers: [server('box', { skipTlsVerify: true })] } })
    if (credentials !== 'available') await page.route('**/api/remote-servers/box/view-session', route => route.fulfill({ status: 409, json: { error: credentials } }))
    await browse(page)
    await page.getByRole('button', { name: 'Open a project on Box' }).click()
    await chooseRemoteRoot(page)
    await page.waitForFunction(() => (window as any).fixtureViews.windows.length === 1)
    const [opened] = (await views(page)).windows
    assert.equal(opened.cookie?.value, credentials === 'available' ? 'fixture-session-secret' : undefined)
    assert.equal(opened.entryUrl, `${BOX}/?codenomadEmbed=project&folder=%2F`)
    assert.equal(JSON.stringify(f.state()).includes('fixture-session-secret'), false)
    assert.deepEqual((await views(page)).opened, [])
  } finally { await page.close() }
})

test('Tauri TLS proxy preserves its own login and never receives the remote origin cookie', async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, locale: 'en-US' })
  try {
    await open(page, '', { context: 'local', host: 'tauri', uiState: { remoteServers: [server('box', { skipTlsVerify: true })] } })
    await page.route('**/api/remote-proxy/sessions', route => route.fulfill({ json: { sessionId: 'proxy-session', windowUrl: 'https://proxy.example/bootstrap' } }))
    const sessions: string[] = []
    page.on('request', request => { if (request.url().endsWith('/view-session')) sessions.push(request.url()) })
    await browse(page)
    await page.getByRole('button', { name: 'Open a project on Box' }).click()
    await chooseRemoteRoot(page)
    await page.waitForFunction(() => (window as any).fixtureViews.windows.length === 1)
    const [opened] = (await views(page)).windows
    assert.equal(opened.proxySessionId, 'proxy-session')
    assert.equal(opened.cookie, undefined)
    assert.equal(new URL(opened.entryUrl!).origin, 'https://proxy.example')
    assert.deepEqual(sessions, [])
    // The native adapter also rejects accidental forwarding from another caller.
    await page.evaluate(async profile => {
      const path = '/src/lib/native/remote-window.ts'
      const { openRemoteServerWindow } = await import(path)
      await openRemoteServerWindow(profile, 'https://proxy.example/bootstrap', 'proxy-session', {}, {
        origin: profile.baseUrl, name: 'codenomad_session', value: 'foreign-secret', path: '/', secure: true, httpOnly: true, sameSite: 'lax',
      })
    }, server('box', { skipTlsVerify: true }))
    assert.equal((await views(page)).windows[1].cookie, undefined)
  } finally { await page.close() }
})

test('native opening failure remounts the session handshake on Retry', async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, locale: 'en-US' })
  try {
    await open(page, '', { context: 'local', host: 'electron', uiState: { remoteServers: [server('box')] } })
    const sessions: string[] = []
    page.on('request', request => { if (request.url().endsWith('/view-session')) sessions.push(request.url()) })
    await page.evaluate(() => {
      const api = (window as any).electronAPI
      const original = api.openRemoteView
      let first = true
      api.openRemoteView = async (payload: unknown) => {
        if (first) { first = false; throw new Error('private-native-diagnostic') }
        await original(payload)
      }
    })
    await browse(page)
    await page.getByRole('button', { name: 'Open a project on Box' }).click()
    await chooseRemoteRoot(page)
    const tab = page.locator('[data-remote-project-view]')
    await tab.getByRole('alert').waitFor()
    assert.equal((await tab.getByRole('alert').innerText()).includes('private-native-diagnostic'), false)
    assert.deepEqual((await views(page)).opened, [])
    await tab.getByRole('button', { name: 'Retry', exact: true }).click()
    await page.waitForFunction(() => (window as any).fixtureViews.opened.length === 1)
    assert.equal(sessions.length, 2)
    assert.equal((await views(page)).opened[0].cookie?.value, 'fixture-session-secret')
  } finally { await page.close() }
})
