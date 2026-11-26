import assert from 'node:assert/strict'
import path from 'node:path'
import {bundleAssetPaths, workspacePolicy} from './web-workspace-policy.mjs'

function samePath(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  return process.platform === 'win32'
    ? a.replaceAll('\\', '/').toLowerCase() === b.replaceAll('\\', '/').toLowerCase()
    : a === b
}

export async function mobileDrawersBrowser({values, m, out, browser, storageState, fulfillWorkspaceCreation, writeOutput, recordCleanupError, url, root}) {
  assert(
    browser && typeof fulfillWorkspaceCreation === 'function' && typeof writeOutput === 'function',
    'Attested browser, fulfillWorkspaceCreation, and writeOutput required for mobileDrawersBrowser',
  )
  const assets = await bundleAssetPaths(path.resolve(root, process.env.RUNE_WEB_DIR ?? 'target/rune-web-connected'))
  const linked = path.join(path.dirname(values.project), 'linked')
  const ownedDirectory = dir => samePath(dir, values.project) || samePath(dir, linked)
  let routeError = null
  let cancelled = false
  let closing = false
  let rejectRoute = () => {}
  const routeFailed = new Promise((_, reject) => {
    rejectRoute = reject
  })
  routeFailed.catch(() => {})
  const failRoute = error => {
    cancelled = true
    if (!routeError) {
      routeError = error
      rejectRoute(error)
    }
    proof.errors.push(error?.message ?? String(error))
  }
  const isShutdownError = error =>
    closing && /Target page, context or browser has been closed|Browser has been closed/i.test(error?.message ?? '')
  const proof = {
    runner: 'web-mobile-drawers',
    emulation: 'Chromium Playwright (isMobile+hasTouch), not Android ADB/Gboard',
    origin: url.origin,
    phone: {},
    tablet: {},
    refused: [],
    errors: [],
  }

  const mirror = page => page.locator('[data-rune-a11y]')
  const button = (page, name) => mirror(page).getByRole('button', {name, exact: true})
  const paint = page => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))
  const flush = async page => {
    await page.waitForTimeout(180)
    await paint(page)
  }
  const resize = async (page, size) => {
    await page.setViewportSize(size)
    await page.waitForFunction(({width, height}) => {
      const canvas = document.querySelector('canvas')?.getBoundingClientRect()
      return canvas && Math.abs(canvas.width - width) < 1 && Math.abs(canvas.height - height) < 1
    }, size)
    await flush(page)
  }
  const press = async locator => {
    await locator.waitFor({state: 'attached'})
    for (const deadline = Date.now() + 20000; await locator.evaluate(el => el.disabled || el.getAttribute('aria-disabled') === 'true');) {
      assert(Date.now() < deadline, 'Control remained disabled')
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    await locator.click({force: true})
  }
  const waitExpanded = async (locator, expected) => {
    await locator.waitFor({state: 'attached'})
    for (const deadline = Date.now() + 10000; (await locator.getAttribute('aria-expanded')) !== String(expected);) {
      assert(Date.now() < deadline, `Expected aria-expanded=${expected}, got ${await locator.getAttribute('aria-expanded')}`)
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }

  const contexts = []
  const pendingContexts = new Set()
  const inflightRoutes = new Set()
  const createPage = async ({width, height, colorScheme}) => {
    if (cancelled) throw routeError ?? Error('Mobile drawers probe cancelled')
    const policy = workspacePolicy({origin: url.origin, project: values.project, assets})
    const task = (async () => {
      const created = await browser.newContext({
        viewport: {width, height},
        deviceScaleFactor: 1,
        colorScheme,
        isMobile: true,
        hasTouch: true,
        storageState,
      })
      if (cancelled) {
        await created.close()
        return null
      }
      contexts.push(created)
      return created
    })()
    pendingContexts.add(task)
    let context
    try {
      context = await task
    } finally {
      pendingContexts.delete(task)
    }
    if (!context || cancelled) throw routeError ?? Error('Mobile drawers probe cancelled')
    await context.route('**/*', route => {
      const handle = (async () => {
        try {
          const req = route.request(), u = new URL(req.url()), p = u.pathname
          let allowed = await policy.request(req)
          if (!allowed && u.origin === url.origin && (await req.allHeaders()).cookie) {
            const [, id, tail] = p.match(/^\/api\/workspaces\/([^/]+)\/(files|worktrees\/[^/]+\/git-status)$/) ?? []
            const [, nativeId, nativeTail] = p.match(/^\/workspaces\/([^/]+)\/instance\/api\/(location|worktree)$/) ?? []
            if (req.method() === 'GET' && policy.workspaces.has(id)) {
              if (tail === 'files') {
                const keys = [...u.searchParams.keys()]
                allowed = keys.every(k => k === 'directory' || k === 'path') && ownedDirectory(u.searchParams.get('directory')) && ['.', ''].includes(u.searchParams.get('path') ?? '')
              } else {
                allowed = u.search === ''
              }
            } else if (req.method() === 'GET' && policy.workspaces.has(nativeId)) {
              if (nativeTail === 'location') {
                const keys = [...u.searchParams.keys()]
                allowed = keys.length === 1 && keys[0] === 'location[directory]' && ownedDirectory(u.searchParams.get('location[directory]'))
              } else if (nativeTail === 'worktree') {
                allowed = u.search === ''
              }
            }
          }
          if (!allowed) {
            proof.refused.push(`${req.method()} ${p}${u.search}`)
            await route.abort('blockedbyclient')
            return
          }
          if (req.method() === 'POST' && p === '/api/workspaces') {
            await fulfillWorkspaceCreation(route, policy)
            return
          }
          await route.continue()
        } catch (error) {
          if (!isShutdownError(error)) {
            failRoute(error)
            try {
              await route.abort('failed')
            } catch (abortError) {
              if (!isShutdownError(abortError)) {
                proof.errors.push(`route.abort failed: ${abortError?.message ?? String(abortError)}`)
              }
            }
          }
        }
      })()
      inflightRoutes.add(handle)
      handle.finally(() => inflightRoutes.delete(handle))
      return handle
    })
    if (cancelled) throw routeError ?? Error('Mobile drawers probe cancelled')
    const page = await context.newPage()
    if (cancelled) throw routeError ?? Error('Mobile drawers probe cancelled')
    page.setDefaultTimeout(20000)
    page.on('pageerror', error => proof.errors.push(error.message))
    await page.goto(url.href, {waitUntil: 'domcontentloaded', timeout: 60000})
    await page.waitForFunction(() => globalThis.__codenomadRuneBoot?.state === 'ready', undefined, {timeout: 60000})
    await (await page.waitForFunction(() => ['web.handover.done', 'web.gpu.failed', 'web.handover.failed']
      .some(name => performance.getEntriesByName(name).length))).dispose()
    await press(button(page, m['folderSelection.servers.dialog.connect']))
    for (const deadline = Date.now() + 20000;;) {
      const input = page.locator('textarea:focus')
      if (await input.count() && await input.getAttribute('aria-label') === m['instanceInfo.labels.folder']) {
        await input.fill(values.project)
        await page.keyboard.press('Enter')
        break
      }
      assert(Date.now() < deadline, 'Project path textarea must be focusable')
      await page.keyboard.press('Tab')
      await page.waitForTimeout(20)
    }
    await mirror(page).getByRole('tab', {name: values.project, exact: true}).waitFor()
    await button(page, m['window.menu.leftPanel']).waitFor()
    await flush(page)
    return {context, page}
  }

  let primaryError = null
  const runProbe = async () => {
    // 1. Phone portrait start (390x844): floating drawers, IME shrink, rotation, full-width Files, Escape layering, outside tap.
    const phone = await createPage({width: 390, height: 844, colorScheme: 'dark'})
    const page = phone.page
    const left = button(page, m['window.menu.leftPanel'])
    const right = button(page, m['window.menu.rightPanel'])
    await waitExpanded(left, false)
    await waitExpanded(right, false)

    // Open left floating drawer, reveal & focus session search, shrink height (simulated IME).
    await press(left)
    await waitExpanded(left, true)
    const leftRegion = mirror(page).getByRole('region', {name: m['window.menu.leftPanel'], exact: true})
    await leftRegion.waitFor({state: 'attached'})
    const leftBox = await leftRegion.boundingBox()
    assert(leftBox && leftBox.width >= 388, `Floating sessions drawer must fill 390px viewport, got ${JSON.stringify(leftBox)}`)

    await press(button(page, m['sessionList.filter.ariaLabel']))
    await flush(page)
    const searchGroup = mirror(page).getByRole('group', {name: m['sessionList.filter.ariaLabel'], exact: true})
    await searchGroup.waitFor({state: 'attached'})
    const searchBox = await searchGroup.boundingBox()
    assert(searchBox && searchBox.width > 100, `Search field missing bounds: ${JSON.stringify(searchBox)}`)
    await page.mouse.click(searchBox.x + searchBox.width / 2, searchBox.y + searchBox.height / 2)
    await flush(page)
    const searchInput = page.locator(`textarea:focus[aria-label="${m['sessionList.filter.ariaLabel']}"]`)
    await searchInput.waitFor({state: 'attached'})
    await page.keyboard.type('Existing')
    await flush(page)
    assert.equal(await searchInput.inputValue(), 'Existing')

    // Simulated virtual keyboard shrink (same width 390, height 844 -> 350): drawer & search focus must survive.
    await resize(page, {width: 390, height: 350})
    await waitExpanded(left, true)
    await leftRegion.waitFor({state: 'attached'})
    assert.equal(await searchInput.count(), 1, 'Search input must keep focus during virtual keyboard shrink')
    await page.keyboard.type(' history')
    await flush(page)
    assert.equal(await searchInput.inputValue(), 'Existing history', 'Search input must remain editable during IME shrink')
    proof.phone.imeShrinkPreserved = true

    // Rotate to landscape (even with keyboard height 844x240, then 844x390): floating drawer closes, no uninvited docked panels.
    await resize(page, {width: 844, height: 240})
    await waitExpanded(left, false)
    await waitExpanded(right, false)
    await leftRegion.waitFor({state: 'detached'})
    await resize(page, {width: 844, height: 390})
    await waitExpanded(left, false)
    await waitExpanded(right, false)
    proof.phone.landscapeStaysClosed = true

    // Return to portrait: select a session and wait for authoritative history sync so workspace/Git is online.
    await resize(page, {width: 390, height: 844})
    await press(left)
    await waitExpanded(left, true)
    await press(leftRegion.getByRole('listitem', {name: 'Existing history', exact: true}))
    await mirror(page).getByRole('heading', {name: 'Existing history', exact: true}).waitFor()
    await page.waitForFunction(() => (document.querySelector('[data-rune-a11y]')?.textContent ?? '').includes('Existing project history'))
    await flush(page)
    if ((await left.getAttribute('aria-expanded')) !== 'true') {
      await press(left)
      await waitExpanded(left, true)
    }
    await press(right)
    await waitExpanded(left, false)
    await waitExpanded(right, true)
    await mirror(page).getByText(m['instanceShell.connection.connected'], {exact: true}).waitFor()

    const rightRegion = mirror(page).getByRole('region', {name: m['window.menu.rightPanel'], exact: true})
    await rightRegion.waitFor({state: 'attached'})
    const rightBox = await rightRegion.boundingBox()
    assert(rightBox && rightBox.width >= 388, `Floating right drawer must fill 390px viewport, got ${JSON.stringify(rightBox)}`)

    // Tab from right toggle must enter the floating right panel tabs instead of trapping on the toggle.
    await page.keyboard.press('Tab')
    await flush(page)
    const tabFocused = await page.evaluate(() => {
      const active = document.activeElement
      const id = active?.getAttribute('aria-activedescendant')
      const el = (id && document.getElementById(id)) || active
      return {role: el?.getAttribute('role'), label: el?.getAttribute('aria-label') || el?.textContent?.trim()}
    })
    assert.equal(tabFocused.role, 'tab', `Tab from floating right toggle must focus a right-panel tab, got ${JSON.stringify(tabFocused)}`)
    proof.phone.rightTabFocused = tabFocused

    // ArrowRight from the focused Status tab selects Files, confirming real keyboard focus inside the floating panel.
    await page.keyboard.press('ArrowRight')
    await flush(page)
    const filesTab = mirror(page).getByRole('tab', {name: m['instanceShell.rightPanel.tabs.files'], exact: true})
    assert.equal(await filesTab.getAttribute('aria-selected'), 'true', 'ArrowRight from focused right-panel tab must select Files')
    const worktreeTrigger = mirror(page).getByRole('combobox', {name: m['gitPanel.worktree'], exact: true})
      .or(button(page, m['gitPanel.worktree']))
    await worktreeTrigger.waitFor({state: 'attached'})
    for (const deadline = Date.now() + 15000; await worktreeTrigger.evaluate(el => el.disabled || el.getAttribute('aria-disabled') === 'true');) {
      assert(Date.now() < deadline, 'Worktree picker remained disabled')
      await page.waitForTimeout(30)
    }
    await flush(page)
    const worktreeBox = await worktreeTrigger.boundingBox()
    assert(worktreeBox && worktreeBox.width >= 340, `Floating worktree picker must fill 390px drawer (>=340px), got ${JSON.stringify(worktreeBox)}`)
    proof.phone.rightPanelWidth = Math.round(rightBox.width)
    proof.phone.worktreePickerWidth = Math.round(worktreeBox.width)

    // Open worktree picker via real canvas pointer click -> first Escape closes picker only, second Escape closes floating right panel.
    await page.mouse.click(worktreeBox.x + worktreeBox.width / 2, worktreeBox.y + worktreeBox.height / 2)
    await flush(page)
    const listbox = mirror(page).getByRole('listbox')
    await listbox.waitFor({state: 'attached'})
    assert((await listbox.getByRole('option').count()) >= 2, 'Worktree picker must list both synthetic and linked worktrees')
    await page.keyboard.press('Escape')
    await flush(page)
    await listbox.waitFor({state: 'detached'})
    await waitExpanded(right, true)
    await page.keyboard.press('Escape')
    await flush(page)
    await waitExpanded(right, false)
    await rightRegion.waitFor({state: 'detached'})
    proof.phone.escapeLayered = true

    // Enter right after Escape reopens the right drawer, proving focus returned to its toggle.
    await page.keyboard.press('Enter')
    await flush(page)
    await waitExpanded(right, true)
    proof.phone.escapeReturnedFocusToToggle = true

    // Verify full Tab wrap + F6 containment inside floating Files drawer: every stop stays in right panel or panel toggles.
    const activeDescendant = () => page.evaluate(() => {
      const active = document.activeElement
      const id = active?.getAttribute('aria-activedescendant')
      const el = (id && document.getElementById(id)) || active
      return {
        role: el?.getAttribute('role'),
        label: el?.getAttribute('aria-label') || el?.textContent?.trim(),
      }
    })
    const isInsideFloatingRight = async cur => {
      if (cur.label === m['window.menu.leftPanel'] || cur.label === m['window.menu.rightPanel']) return true
      if (!cur.role || !cur.label) return false
      return (await rightRegion.getByRole(cur.role, {name: cur.label, exact: true}).count()) > 0
    }
    let wrappedToLeft = false
    for (let step = 0; step < 24; step++) {
      await page.keyboard.press('Tab')
      await flush(page)
      const cur = await activeDescendant()
      assert(await isInsideFloatingRight(cur), `Tab escaped floating Files drawer to ${JSON.stringify(cur)}`)
      if (cur.label === m['window.menu.leftPanel']) {
        wrappedToLeft = true
        break
      }
    }
    assert(wrappedToLeft, 'Tab inside floating Files drawer must wrap back to left panel toggle')
    await page.keyboard.press('F6')
    await flush(page)
    const afterF6 = await activeDescendant()
    assert(await isInsideFloatingRight(afterF6), `F6 escaped floating Files drawer to ${JSON.stringify(afterF6)}`)
    await page.keyboard.press('Shift+Tab')
    await flush(page)
    const wrappedBack = await activeDescendant()
    const inRightRegion = wrappedBack.role && wrappedBack.label
      ? (await rightRegion.getByRole(wrappedBack.role, {name: wrappedBack.label, exact: true}).count()) > 0
      : false
    assert(
      inRightRegion &&
      wrappedBack.label !== m['window.menu.leftPanel'] &&
      wrappedBack.label !== m['window.menu.rightPanel'] &&
      wrappedBack.label !== m['instanceShell.rightPanel.tabs.files'],
      `Shift+Tab from left toggle must wrap to last Files control inside right panel, got ${JSON.stringify({...wrappedBack, inRightRegion})}`,
    )
    proof.phone.filesTabWrapped = wrappedBack
    await page.keyboard.press('Escape')
    await flush(page)
    await waitExpanded(right, false)

    // Outside non-modal top-bar tap (active project tab) dismisses floating left drawer immediately before any key press.
    await press(left)
    await waitExpanded(left, true)
    await press(mirror(page).getByRole('tab', {name: values.project, exact: true}))
    await flush(page)
    await waitExpanded(left, false)
    await leftRegion.waitFor({state: 'detached'})
    proof.phone.outsideTabDismissed = true

    // Outside modal top-bar action (Notifications bell) dismisses floating left drawer without stealing focus from Notifications.
    await press(left)
    await waitExpanded(left, true)
    await press(button(page, m['toastHistory.title']))
    await flush(page)
    const notifDialog = mirror(page).getByRole('dialog', {name: m['toastHistory.title'], exact: true})
    await notifDialog.waitFor({state: 'attached'})
    await page.keyboard.press('Escape')
    await flush(page)
    await notifDialog.waitFor({state: 'detached'})
    await waitExpanded(left, false)
    await leftRegion.waitFor({state: 'detached'})
    // Pressing Enter right after closing Notifications must reopen Notifications (not left drawer), proving focus returned to the bell.
    await page.keyboard.press('Enter')
    await flush(page)
    await notifDialog.waitFor({state: 'attached'})
    await page.keyboard.press('Escape')
    await flush(page)
    await notifDialog.waitFor({state: 'detached'})
    await waitExpanded(left, false)
    proof.phone.outsideTopBarDismissed = true

    // 2. Landscape tablet start (1366x1024): both panels docked, hide on portrait, independent per-orientation memory.
    const tablet = await createPage({width: 1366, height: 1024, colorScheme: 'light'})
    const tPage = tablet.page
    const tLeft = button(tPage, m['window.menu.leftPanel'])
    const tRight = button(tPage, m['window.menu.rightPanel'])
    await waitExpanded(tLeft, true)
    await waitExpanded(tRight, true)

    await resize(tPage, {width: 1024, height: 1366})
    await waitExpanded(tLeft, false)
    await waitExpanded(tRight, false)

    await press(tLeft)
    await waitExpanded(tLeft, true)
    await waitExpanded(tRight, false)

    await resize(tPage, {width: 1366, height: 1024})
    await waitExpanded(tLeft, true)
    await waitExpanded(tRight, true)

    await resize(tPage, {width: 1024, height: 1366})
    await waitExpanded(tLeft, true)
    await waitExpanded(tRight, false)
    proof.tablet.perOrientationMemory = true
  }
  const closeAllContexts = async () => {
    cancelled = true
    closing = true
    let closeError = null
    while (pendingContexts.size) {
      const settled = await Promise.allSettled([...pendingContexts])
      for (const outcome of settled) {
        if (outcome.status === 'rejected') {
          recordCleanupError?.('mobile-drawers pending context', outcome.reason)
          ;(proof.cleanupErrors ??= []).push(`pending context: ${outcome.reason?.message ?? outcome.reason}`)
          closeError ??= outcome.reason
        }
      }
    }
    const toClose = contexts.splice(0)
    const closed = await Promise.allSettled(toClose.map(ctx => ctx.close()))
    for (const outcome of closed) {
      if (outcome.status === 'rejected') {
        recordCleanupError?.('mobile-drawers context.close', outcome.reason)
        ;(proof.cleanupErrors ??= []).push(`context.close: ${outcome.reason?.message ?? outcome.reason}`)
        closeError ??= outcome.reason
      }
    }
    while (inflightRoutes.size) {
      await Promise.allSettled([...inflightRoutes])
    }
    return closeError
  }
  let probePromise = null
  let passed = false
  try {
    probePromise = runProbe()
    probePromise.catch(() => {})
    await Promise.race([probePromise, routeFailed])
    await Promise.allSettled([...inflightRoutes])
    const closeError = await closeAllContexts()
    if (routeError) throw routeError
    assert.deepEqual(proof.refused, [], `Forbidden requests: ${JSON.stringify(proof.refused)}`)
    assert.deepEqual(proof.errors, [], `Page errors: ${JSON.stringify(proof.errors)}`)
    if (closeError) throw closeError
    proof.result = 'pass'
    passed = true
  } catch (error) {
    primaryError = error
    cancelled = true
    proof.result = 'fail'
    proof.failure = error?.message ?? String(error)
    await Promise.allSettled(contexts.flatMap(ctx => ctx.pages()).map(async (p, i) => {
      await writeOutput(`mobile-drawers-fail-${i}.aria.yml`, await p.locator('body').ariaSnapshot({timeout: 2000}))
    }))
    throw error
  } finally {
    let cleanupError = await closeAllContexts()
    await probePromise?.catch(() => {})
    try {
      await writeOutput('mobile-drawers-proof.json', JSON.stringify(proof, null, 2))
    } catch (writeError) {
      recordCleanupError?.('mobile-drawers proof write', writeError)
      cleanupError ??= writeError
    }
    if (!primaryError && cleanupError) throw cleanupError
  }
  if (passed) {
    console.log(JSON.stringify({runner: 'web-mobile-drawers', result: proof.result, out}))
  }
}
