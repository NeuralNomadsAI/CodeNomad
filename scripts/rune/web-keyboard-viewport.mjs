import assert from 'node:assert/strict'
import {assertRenderedTextContrast, installTextContrast} from './text-contrast.mjs'
import {installPngReader} from './png-pixels.mjs'

export async function keyboardViewport(page, m, {kind, prefix, heading, headerHeight, panelPad, composerPad, field, workspaceId, imagePage, palette}) {
  assert(typeof workspaceId === 'string' && workspaceId.length > 0, `${kind}: explicit workspaceId required`)
  assert(imagePage && palette, `${kind}: imagePage and palette required for rendered button verification`)
  const mirror = page.locator('[data-rune-a11y]')
  const button = key => mirror.getByRole('button', {name: m[key], exact: true})
  const original = page.viewportSize()
  const landscape = original.width > original.height
  const shrink = landscape ? 145 : Math.min(330, original.height - 420)
  const short = {...original, height: original.height - shrink}
  const composer = mirror.getByRole('group', {name: m['rune.prompt'], exact: true})
  const controls = button('transcriptFilters.title')
  const historyRegion = mirror.getByRole('region', {name: m['settings.voice.conversation.title'], exact: true})
  const send = button('promptInput.overlay.send')
  const actionKeys = kind === 'permission'
    ? ['rune.allow_once', 'rune.allow_always', 'rune.reject']
    : ['rune.answer', 'rune.cancel_question']
  const primary = button(actionKeys.at(-1))
  const title = mirror.getByRole('heading', {name: heading, exact: true})
  const newTab = button('instanceTabs.new.ariaLabel')
  const interruptionLabel = kind === 'permission' ? m['rune.reason'] : 'Question field 0'
  const partialInput = kind === 'permission' ? 'Motif partiel — 日本語' : 'Réponse partielle — 🦀'
  const paint = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const flushMirror = async () => {
    await page.waitForTimeout(180)
    await paint()
  }
  const resize = async size => {
    await page.setViewportSize(size)
    await page.waitForFunction(({width, height}) => {
      const canvas = document.querySelector('canvas')?.getBoundingClientRect()
      return canvas && Math.abs(canvas.width - width) < 1 && Math.abs(canvas.height - height) < 1
    }, size)
    await flushMirror()
  }
  const paneGeometry = async () => {
    const head = await title.boundingBox()
    const tabBtn = await newTab.boundingBox()
    const comp = await composer.boundingBox()
    assert(head && tabBtn && comp)
    const headerBottom = Math.max(head.y + head.height, tabBtn.y + tabBtn.height + headerHeight)
    return {
      x: comp.x + comp.width / 2,
      top: headerBottom,
    }
  }
  const clippedBox = async locator => {
    await locator.waitFor({state: 'attached'})
    const {top: paneTop} = await paneGeometry()
    return locator.evaluate((el, minTop) => {
      const r = el.getBoundingClientRect()
      let left = Math.max(0, r.left)
      let top = Math.max(minTop, r.top)
      let right = Math.min(innerWidth, r.right)
      let bottom = Math.min(innerHeight, r.bottom)
      for (let p = el.parentElement; p; p = p.parentElement) {
        const s = getComputedStyle(p)
        const b = p.getBoundingClientRect()
        if (/hidden|clip|auto|scroll/.test(s.overflowX)) {
          left = Math.max(left, b.left)
          right = Math.min(right, b.right)
        }
        if (/hidden|clip|auto|scroll/.test(s.overflowY)) {
          top = Math.max(top, b.top)
          bottom = Math.min(bottom, b.bottom)
        }
      }
      const clipW = Math.max(0, right - left)
      const clipH = Math.max(0, bottom - top)
      const fits = r.width > 0 && r.height > 0 && clipW >= r.width - 1 && clipH >= r.height - 1
      return {
        rect: [r.x, r.y, r.width, r.height],
        clip: [left, top, clipW, clipH],
        center: {x: left + clipW / 2, y: top + clipH / 2},
        paneTop: minTop,
        fits,
      }
    }, paneTop)
  }
  const stackPoint = async () => {
    const {top} = await paneGeometry()
    const {height} = page.viewportSize()
    for (const candidate of [button('rune.model'), primary, send, controls]) {
      if (await candidate.count() === 0) continue
      const box = await candidate.boundingBox().catch(() => null)
      if (!box) continue
      const y0 = Math.max(top + 1, box.y + 1)
      const y1 = Math.min(height - 1, box.y + box.height - 1)
      if (y1 >= y0) return {x: box.x + box.width / 2, y: (y0 + y1) / 2}
    }
    const comp = await composer.boundingBox()
    const model = await button('rune.model').count() > 0 ? await button('rune.model').boundingBox().catch(() => null) : null
    if (comp && model) {
      const agentTop = model.y - panelPad
      const y0 = Math.max(top + 2, agentTop + 2)
      const y1 = height - 2
      if (y1 >= y0) return {x: comp.x + 4, y: (y0 + y1) / 2}
    }
    assert.fail(`No non-history chrome handle inside session-stack [${top}, ${height}]`)
  }
  const wheelStack = async deltaY => {
    const pt = await stackPoint()
    await page.mouse.move(pt.x, pt.y)
    await page.mouse.wheel(0, deltaY)
    await flushMirror()
  }
  const reveal = async locator => {
    const initial = await clippedBox(locator)
    if (initial.fits) return initial
    const {top} = await paneGeometry()
    const step = Math.max(24, Math.min(90, Math.floor((page.viewportSize().height - top) / 2)))
    const directions = initial.rect[1] < initial.paneTop ? [-1, 1] : [1, -1]
    for (const direction of directions) {
      let prevY = null
      for (let i = 0; i < 24; i++) {
        const box = await clippedBox(locator)
        if (box.fits) return box
        if (prevY !== null && Math.abs(box.rect[1] - prevY) < 0.5) break
        prevY = box.rect[1]
        await wheelStack(direction * step)
      }
    }
    const box = await clippedBox(locator)
    assert.fail(`The control must remain unclipped inside [paneTop, viewportHeight]: ${JSON.stringify(box)}`)
  }
  const visiblePassages = async () => {
    const {top: paneTop} = await paneGeometry()
    const historyBox = await historyRegion.boundingBox()
    assert(historyBox && historyBox.height > 0, `${kind}: missing history region bounding box`)
    const visibleTop = Math.max(paneTop, historyBox.y)
    const visibleBottom = Math.min(page.viewportSize().height, historyBox.y + historyBox.height)
    const items = await historyRegion.evaluate((section, {prefix, historyTop, visibleTop, visibleBottom}) => [...section.querySelectorAll('p')]
      .map(el => ({text: el.textContent ?? '', rect: el.getBoundingClientRect()}))
      .filter(({text, rect}) => text.startsWith(prefix) && rect.height > 0 && rect.bottom > visibleTop + 2 && rect.top < visibleBottom - 2)
      .map(({text, rect}) => ({
        text,
        top: rect.top - historyTop,
        bottom: rect.bottom - historyTop,
        index: Number(text.match(/\d+/)?.[0]),
      })),
    {prefix, historyTop: historyBox.y, visibleTop, visibleBottom})
    return {historyBox, paneTop, items}
  }
  const scrollHistoryToTopOfStack = async () => {
    for (let i = 0; i < 16; i++) {
      const {top: paneTop} = await paneGeometry()
      const controlsBox = await controls.count() > 0 ? await controls.boundingBox().catch(() => null) : null
      const topBox = controlsBox ?? await historyRegion.boundingBox()
      if (topBox && topBox.y >= paneTop - 1.5) break
      await wheelStack(-180)
    }
    const view = await visiblePassages()
    const controlsBox = await controls.count() > 0 ? await controls.boundingBox().catch(() => null) : null
    if (controlsBox) {
      assert(Math.abs(controlsBox.y - view.paneTop) <= 1.5,
        `${kind}: outer session-stack must return to top before reading check: controlsTop=${controlsBox.y}, paneTop=${view.paneTop}`)
      assert(Math.abs(view.historyBox.y - (controlsBox.y + controlsBox.height)) <= 1.5,
        `${kind}: history must sit immediately below transcript controls: historyTop=${view.historyBox.y}, controlsBottom=${controlsBox.y + controlsBox.height}`)
    } else {
      assert(Math.abs(view.historyBox.y - view.paneTop) <= 1.5,
        `${kind}: outer session-stack must return to top before reading check: historyTop=${view.historyBox.y}, paneTop=${view.paneTop}`)
    }
    return view.items
  }
  const watchFocusLoss = (expectedLabel, expectedValue, requireNonEmptySelection = false) => page.evaluate(({label, value, requireSel}) => {
    globalThis.__runeKeyboardStopWatch?.()
    globalThis.__runeKeyboardFocusLost = 0
    globalThis.__runeKeyboardSelection = null
    const el = document.activeElement
    if (!el || el.tagName !== 'TEXTAREA') {
      globalThis.__runeKeyboardFocusLost = 1
      globalThis.__runeKeyboardStopWatch = null
      return
    }
    if (requireSel && el.selectionStart >= el.selectionEnd) {
      globalThis.__runeKeyboardFocusLost = 1
    }
    globalThis.__runeKeyboardSelection = {
      start: el.selectionStart,
      end: el.selectionEnd,
      direction: el.selectionDirection,
    }
    const onBlur = () => { globalThis.__runeKeyboardFocusLost++ }
    el.addEventListener('blur', onBlur)
    const observer = new MutationObserver(() => {
      if (el.getAttribute('aria-label') !== label || el.disabled || el.readOnly) {
        globalThis.__runeKeyboardFocusLost++
      }
    })
    observer.observe(el, {attributes: true, attributeFilter: ['aria-label', 'aria-labelledby', 'disabled', 'readonly']})
    const protoDesc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')
    if (protoDesc?.get && protoDesc?.set) {
      Object.defineProperty(el, 'value', {
        configurable: true,
        get() { return protoDesc.get.call(this) },
        set(next) {
          if (next !== value) globalThis.__runeKeyboardFocusLost++
          return protoDesc.set.call(this, next)
        },
      })
    }
    globalThis.__runeKeyboardStopWatch = () => {
      el.removeEventListener('blur', onBlur)
      observer.disconnect()
      if (Object.prototype.hasOwnProperty.call(el, 'value')) delete el.value
    }
  }, {label: expectedLabel, value: expectedValue, requireSel: requireNonEmptySelection})
  const assertComposerFocusedWithoutDrop = async (expected, requireNonEmptySelection = false) => {
    const state = await page.evaluate(({label, value, requireSel}) => {
      globalThis.__runeKeyboardStopWatch?.()
      globalThis.__runeKeyboardStopWatch = null
      const el = document.activeElement
      const expectedSel = globalThis.__runeKeyboardSelection
      globalThis.__runeKeyboardSelection = null
      return {
        tag: el?.tagName ?? null,
        label: el?.getAttribute?.('aria-label') ?? null,
        value: el?.value ?? null,
        expectedSelection: expectedSel,
        selectionStart: el?.selectionStart ?? null,
        selectionEnd: el?.selectionEnd ?? null,
        selectionDirection: el?.selectionDirection ?? null,
        lost: globalThis.__runeKeyboardFocusLost ?? 0,
        ok: el?.tagName === 'TEXTAREA'
          && el.getAttribute('aria-label') === label
          && el.value === value
          && expectedSel !== null
          && (!requireSel || (expectedSel.start < expectedSel.end && el.selectionStart < el.selectionEnd))
          && el.selectionStart === expectedSel.start
          && el.selectionEnd === expectedSel.end
          && el.selectionDirection === expectedSel.direction,
      }
    }, {label: m['rune.prompt'], value: expected, requireSel: requireNonEmptySelection})
    assert(state.ok && state.lost === 0, `${kind}: composer focus dropped across resize: ${JSON.stringify(state)}`)
  }
  const composerGeometry = async () => {
    const {height} = page.viewportSize()
    const {top: paneTop} = await paneGeometry()
    const fieldBox = await composer.boundingBox()
    const sendBox = await send.boundingBox()
    const firstFooterTop = await composer.getByRole('button').evaluateAll(els => {
      let minTop = Infinity
      for (const el of els) {
        const r = el.getBoundingClientRect()
        if (r.width > 0 && r.height > 0 && r.top < minTop) minTop = r.top
      }
      return Number.isFinite(minTop) ? minTop : null
    })
    const caretBox = await page.evaluate(() => {
      const el = document.activeElement
      if (!el || el.tagName !== 'TEXTAREA') return null
      const r = el.getBoundingClientRect()
      return {x: r.x, y: r.y, width: r.width, height: r.height}
    })
    const modelBox = await button('rune.model').boundingBox().catch(() => null)
    const editorTop = fieldBox ? fieldBox.y + composerPad : null
    const footerTop = firstFooterTop ?? sendBox?.y ?? null
    const editorBottom = footerTop !== null ? footerTop - panelPad : null
    return {paneTop, height, fieldBox, sendBox, firstFooterTop, caretBox, modelBox, editorTop, editorBottom}
  }
  const assertComposerVisibleInViewport = async before => {
    const {width} = page.viewportSize()
    // Post-resize/scroll accessibility mirror updates defer off rAF for SCROLL_SETTLE + IDLE_TIMEOUT (#1670).
    const deadline = Date.now() + 1500
    let after = null
    let editorHeight = 0
    let visibleTop = 0
    let visibleBottom = 0
    let visibleHeight = -Infinity
    while (true) {
      after = await composerGeometry()
      const boxesReady = Boolean(after.fieldBox && after.sendBox && after.firstFooterTop !== null && after.firstFooterTop > after.fieldBox.y)
      if (boxesReady) {
        editorHeight = after.editorBottom - after.editorTop
        visibleTop = Math.max(after.paneTop, after.editorTop)
        visibleBottom = Math.min(after.height, after.editorBottom)
        visibleHeight = visibleBottom - visibleTop
        const visibleOk = editorHeight > 0 && visibleHeight >= Math.min(20, editorHeight - 1)
        const caretOk = Boolean(after.caretBox && after.caretBox.height > 0
          && after.caretBox.x >= Math.max(0, after.fieldBox.x) - 1
          && after.caretBox.x + after.caretBox.width <= Math.min(width, after.fieldBox.x + after.fieldBox.width) + 1
          && after.caretBox.y >= after.paneTop - 1
          && after.caretBox.y + after.caretBox.height <= after.height + 1
          && after.caretBox.y >= after.editorTop - 1
          && after.caretBox.y + after.caretBox.height <= after.editorBottom + 1)
        if (visibleOk && caretOk) break
      }
      if (Date.now() >= deadline) break
      await page.waitForTimeout(50)
      await paint()
    }
    assert(after.fieldBox && after.sendBox && after.firstFooterTop !== null && after.firstFooterTop > after.fieldBox.y,
      `${kind}: composer box unavailable after resize: ${JSON.stringify({before, after})}`)
    assert(editorHeight > 0 && visibleHeight >= Math.min(20, editorHeight - 1),
      `${kind}: focused composer must remain visible after resize without manual scrolling: ${JSON.stringify({before, after, visibleHeight})}`)
    assert(after.caretBox && after.caretBox.height > 0
      && after.caretBox.x >= Math.max(0, after.fieldBox.x) - 1
      && after.caretBox.x + after.caretBox.width <= Math.min(width, after.fieldBox.x + after.fieldBox.width) + 1
      && after.caretBox.y >= after.paneTop - 1
      && after.caretBox.y + after.caretBox.height <= after.height + 1
      && after.caretBox.y >= after.editorTop - 1
      && after.caretBox.y + after.caretBox.height <= after.editorBottom + 1,
      `${kind}: focused composer caret must remain inside visible editor bounds: ${JSON.stringify({before, after})}`)
    // Verify real rendered text-primary glyph pixels inside the visible editor band around the caret
    // line (using the palette text contrast matcher, which excludes selection highlight and caret blue).
    await paint()
    const png = await page.screenshot()
    await installPngReader(imagePage)
    await installTextContrast(imagePage)
    const editorInk = await imagePage.evaluate(async ({source, band, fieldHex, textHex}) => {
      const [image] = await globalThis.__codenomadReadPngs([source])
      const bg = [1, 3, 5].map(i => parseInt(fieldHex.slice(i, i + 2), 16))
      const {matches: matchesInk} = globalThis.__codenomadTextContrast(fieldHex, textHex)
      const x0 = Math.max(0, Math.ceil(band[0]))
      const y0 = Math.max(0, Math.ceil(band[1]))
      const x1 = Math.min(image.width - 1, Math.floor(band[0] + band[2]))
      const y1 = Math.min(image.height - 1, Math.floor(band[1] + band[3]))
      if (x1 <= x0 || y1 <= y0) return {ok: false, reason: 'degenerate', band}
      let inkPixels = 0
      let bgPixels = 0
      for (let py = y0; py <= y1; py++) {
        for (let px = x0; px <= x1; px++) {
          const idx = (py * image.width + px) * 4
          const color = [image.pixels[idx], image.pixels[idx + 1], image.pixels[idx + 2]]
          const dist = Math.abs(color[0] - bg[0])
            + Math.abs(color[1] - bg[1])
            + Math.abs(color[2] - bg[2])
          if (dist <= 6) bgPixels++
          else if (matchesInk(color)) inkPixels++
        }
      }
      return {ok: bgPixels > 20 && inkPixels >= 8, bgPixels, inkPixels, band}
    }, {
      source: `data:image/png;base64,${png.toString('base64')}`,
      band: [
        after.fieldBox.x + composerPad,
        Math.max(visibleTop, after.caretBox.y - 2),
        Math.max(0, after.fieldBox.width - composerPad * 2),
        Math.min(visibleBottom, after.caretBox.y + after.caretBox.height + 2) - Math.max(visibleTop, after.caretBox.y - 2),
      ],
      fieldHex: palette['surface-field'],
      textHex: palette['text-primary'],
    })
    assert(editorInk.ok, `${kind}: rendered canvas lacks visible text-primary glyph ink at caret line: ${JSON.stringify({editorInk, after})}`)
  }
  const focusComposer = async () => {
    const {height} = page.viewportSize()
    let lastPaneTop = null
    for (let i = 0; i < 24; i++) {
      const geom = await composerGeometry()
      const {paneTop, fieldBox, editorTop, editorBottom} = geom
      lastPaneTop = paneTop
      assert(fieldBox && editorTop !== null && editorBottom !== null && editorBottom > editorTop)
      const y0 = Math.max(paneTop + 2, editorTop + 2)
      const y1 = Math.min(height - 2, editorBottom - 2)
      if (y1 - y0 >= 8) {
        await page.mouse.click(fieldBox.x + fieldBox.width / 2, (y0 + y1) / 2)
        const input = page.locator('textarea:focus').and(page.getByRole('textbox', {name: m['rune.prompt'], exact: true}))
        await input.waitFor({state: 'attached'})
        return input
      }
      const step = Math.max(24, Math.min(90, Math.floor((height - paneTop) / 2)))
      await wheelStack(editorBottom < paneTop + 12 ? -step : step)
    }
    assert.fail(`${kind}: composer input area could not be scrolled clear of header inside [${lastPaneTop}, ${height}]`)
  }
  const sessionId = kind === 'permission' ? 'ses_existing' : 'ses_another'
  const toggleModelPicker = async () => {
    const modelOption = mirror.getByRole('button', {name: 'fixture · Fixture', exact: true})
    const modelBox = await reveal(button('rune.model'))
    const refreshDone = page.waitForResponse(res => res.request().method() === 'GET'
      && new URL(res.url()).pathname === `/workspaces/${workspaceId}/instance/api/session/${sessionId}/form`
      && res.ok())
    await page.mouse.click(modelBox.center.x, modelBox.center.y)
    await modelOption.waitFor({state: 'attached'})
    await refreshDone
    await flushMirror()
    const modelBoxClose = await reveal(button('rune.model'))
    await page.mouse.click(modelBoxClose.center.x, modelBoxClose.center.y)
    await modelOption.waitFor({state: 'detached'})
    await flushMirror()
  }

  const focusInterruptionField = async () => {
    const focused = page.locator('textarea:focus')
    if (await focused.count() && await focused.getAttribute('aria-label') === interruptionLabel) {
      return focused
    }
    await focusComposer()
    for (let i = 0; i < 32; i++) {
      await page.keyboard.press('Shift+Tab')
      await page.waitForTimeout(20)
      if (await focused.count() && await focused.getAttribute('aria-label') === interruptionLabel) {
        return focused
      }
    }
    return field(interruptionLabel)
  }

  await primary.waitFor({state: 'attached'})
  assert.equal(await button('interruption.previous').count(), 0, 'Single pending request must hide Previous navigation')
  assert.equal(await button('interruption.next').count(), 0, 'Single pending request must hide Next navigation')

  // Enter a partial interruption reason / question answer before shrinking.
  const partialField = await focusInterruptionField()
  await partialField.fill(partialInput)
  assert.equal(await partialField.inputValue(), partialInput, `${kind}: partial interruption input must accept text`)

  // Scroll the transcript up to a non-tail passage whose lower body sits inside the short reserve.
  let beforeList = await scrollHistoryToTopOfStack()
  const pickAnchor = list => list.find(item => item.index > 0 && item.index <= 26 && item.top <= 0.5 && item.bottom >= 12)
  let scrolledUp = false
  for (let i = 0; i < 16; i++) {
    if (scrolledUp && pickAnchor(beforeList)) break
    const histBox = await historyRegion.boundingBox()
    assert(histBox && histBox.height > 4, `${kind}: missing history region box before wheel`)
    await page.mouse.move(histBox.x + histBox.width / 2, histBox.y + Math.min(28, histBox.height / 2))
    await page.mouse.wheel(0, -180)
    scrolledUp = true
    await flushMirror()
    beforeList = (await visiblePassages()).items
  }
  const anchor = pickAnchor(beforeList)
  assert(scrolledUp && anchor, `${kind}: must scroll up to an intermediate passage visible in 64px reserve, got ${JSON.stringify(beforeList)}`)

  // Focus composer, enter a multi-line draft, select a non-empty range, and keep focus/selection across resize.
  const text = `Brouillon ${kind} — 日本語 🦀\nLigne 2\nLigne 3`
  const composerInput = await focusComposer()
  await composerInput.fill(text)
  for (let i = 0; i < 4; i++) await page.keyboard.press('Shift+ArrowLeft')
  await flushMirror()
  const beforeResizeComposer = await composerGeometry()
  await watchFocusLoss(m['rune.prompt'], text, true)
  await resize(short)
  await assertComposerFocusedWithoutDrop(text, true)
  await assertComposerVisibleInViewport(beforeResizeComposer)

  // Verify reading passage and offset remain anchored in the shortened viewport.
  const shortList = await scrollHistoryToTopOfStack()
  const shortMatched = shortList.find(item => item.text === anchor.text)
  assert(shortMatched, `${kind}: reading passage ${anchor.text} must stay anchored in short viewport, got ${JSON.stringify(shortList)}`)
  assert(Math.abs(shortMatched.top - anchor.top) <= 2, `${kind}: short reading offset drifted from ${anchor.top} to ${shortMatched.top}`)

  const assertRenderedButtonUnclipped = async (name, box) => {
    await page.mouse.move(0, 0)
    await paint()
    const png = await page.screenshot()
    await assertRenderedTextContrast(imagePage, png, [{name, rect: box.rect, surface: 'surface-control', inset: 2}], palette)
    await installPngReader(imagePage)
    const edges = await imagePage.evaluate(async ({source, rect, fillHex, textHex}) => {
      const [image] = await globalThis.__codenomadReadPngs([source])
      const target = [1, 3, 5].map(i => parseInt(fillHex.slice(i, i + 2), 16))
      const {matches: matchesInk} = globalThis.__codenomadTextContrast(fillHex, textHex)
      const matches = (px, py) => {
        if (px < 0 || py < 0 || px >= image.width || py >= image.height) return false
        const idx = (py * image.width + px) * 4
        return Math.abs(image.pixels[idx] - target[0]) <= 2
          && Math.abs(image.pixels[idx + 1] - target[1]) <= 2
          && Math.abs(image.pixels[idx + 2] - target[2]) <= 2
      }
      const [rx, ry, rw, rh] = rect
      const x0 = Math.ceil(rx + 2), x1 = Math.floor(rx + rw - 3)
      const y0 = Math.ceil(ry + 2), y1 = Math.floor(ry + rh - 3)
      if (x1 <= x0 || y1 <= y0) return {ok: false, reason: 'degenerate', rect}
      const ratioH = py => {
        let hit = 0, total = 0
        for (let px = x0; px <= x1; px++) { total++; if (matches(px, py)) hit++ }
        return total > 0 ? hit / total : 0
      }
      const ratioV = px => {
        let hit = 0, total = 0
        for (let py = y0; py <= y1; py++) { total++; if (matches(px, py)) hit++ }
        return total > 0 ? hit / total : 0
      }
      let minInkX = Infinity, maxInkX = -Infinity
      for (let py = y0; py <= y1; py++) {
        for (let px = x0; px <= x1; px++) {
          const idx = (py * image.width + px) * 4
          if (matchesInk([image.pixels[idx], image.pixels[idx + 1], image.pixels[idx + 2]])) {
            if (px < minInkX) minInkX = px
            if (px > maxInkX) maxInkX = px
          }
        }
      }
      const top = ratioH(y0), bottom = ratioH(y1), left = ratioV(x0), right = ratioV(x1)
      const leftPad = Number.isFinite(minInkX) ? minInkX - rx : -1
      const rightPad = Number.isFinite(maxInkX) ? (rx + rw) - (maxInkX + 1) : -1
      const inkSpan = Number.isFinite(minInkX) ? (maxInkX - minInkX + 1) : 0
      const spanOk = leftPad >= 3 && rightPad >= 3 && Math.abs(leftPad - rightPad) <= 8 && inkSpan >= Math.max(8, rw - 32)
      return {
        ok: top >= 0.8 && bottom >= 0.8 && left >= 0.8 && right >= 0.8 && spanOk,
        top, bottom, left, right, leftPad, rightPad, inkSpan, rect,
      }
    }, {source: `data:image/png;base64,${png.toString('base64')}`, rect: box.rect, fillHex: palette['surface-control'], textHex: palette['text-primary']})
    assert(edges.ok, `${kind}: ${name} rendered canvas edges or label span clipped/mismatched: ${JSON.stringify(edges)}`)
  }

  // Verify every interruption action and Send remain unoccluded inside [paneTop, short.height],
  // inside their parent container bounds, AND painted unclipped on the real Rune canvas.
  const actions = {}
  for (const key of actionKeys) {
    const box = await reveal(button(key))
    const historyBox = await historyRegion.boundingBox()
    const compBox = await composer.boundingBox()
    assert(historyBox && compBox, `${kind}: missing history/composer bounds for ${key}`)
    const agentTop = Math.max(box.paneTop, historyBox.y + historyBox.height)
    const agentBottom = Math.min(short.height, compBox.y)
    actions[key] = box.center
    assert(box.fits && box.center.y >= box.paneTop && box.center.y < short.height
      && box.rect[1] >= agentTop - 1 && box.rect[1] + box.rect[3] <= agentBottom + 1,
      `${kind}: ${key} must stay unoccluded inside agent-panel [${agentTop}, ${agentBottom}] in ${JSON.stringify(short)}, got ${JSON.stringify(box)}`)
    await assertRenderedButtonUnclipped(key, box)
  }
  const sendBox = await reveal(send)
  const compBox = await composer.boundingBox()
  assert(compBox, `${kind}: missing composer bounds for Send`)
  const sendPoint = sendBox.center
  assert(sendBox.fits && sendPoint.y >= sendBox.paneTop && sendPoint.y < short.height
    && sendBox.rect[1] >= Math.max(sendBox.paneTop, compBox.y) - 1
    && sendBox.rect[1] + sendBox.rect[3] <= Math.min(short.height, compBox.y + compBox.height) + 1,
    `${kind}: Send must stay unoccluded inside composer [${compBox.y}, ${compBox.y + compBox.height}] in ${JSON.stringify(short)}, got ${JSON.stringify(sendBox)}`)
  await assertRenderedButtonUnclipped('promptInput.overlay.send', sendBox)

  // Verify real Rune scene pointer hit-testing inside short viewport (model picker toggle + composer click).
  await toggleModelPicker()

  // Refocus composer by real pointer click in short viewport, select a non-empty range, then restore without focus drop.
  await focusComposer()
  await page.keyboard.press('End')
  for (let i = 0; i < 4; i++) await page.keyboard.press('Shift+ArrowLeft')
  await flushMirror()
  const beforeRestoreComposer = await composerGeometry()
  await watchFocusLoss(m['rune.prompt'], text, true)
  await resize(original)
  await assertComposerFocusedWithoutDrop(text, true)
  await assertComposerVisibleInViewport(beforeRestoreComposer)

  // Verify the same non-tail passage and its offset remain anchored at the top of the stack.
  const afterList = await scrollHistoryToTopOfStack()
  const matched = afterList.find(item => item.text === anchor.text)
  assert(matched, `${kind}: reading passage ${anchor.text} must stay anchored after keyboard close, got ${JSON.stringify(afterList)}`)
  assert(Math.abs(matched.top - anchor.top) <= 2, `${kind}: reading offset drifted from ${anchor.top} to ${matched.top}`)

  // Verify partial interruption input survived both resizes, then clear it.
  const restoredPartial = await focusInterruptionField()
  assert.equal(await restoredPartial.inputValue(), partialInput, `${kind}: partial interruption input must survive resize`)
  await restoredPartial.fill('')

  // Shrink once more and actually click the terminal interruption action (reject / cancel) in the Rune scene.
  await resize(short)
  const actionBox = await reveal(primary)
  const expectedPath = kind === 'permission'
    ? `/workspaces/${workspaceId}/instance/api/session/ses_existing/permission/permission-keyboard/reply`
    : `/workspaces/${workspaceId}/instance/api/session/ses_another/form/form-keyboard`
  const replyMatcher = res => res.request().method() === (kind === 'permission' ? 'POST' : 'DELETE')
    && new URL(res.url()).pathname === expectedPath
    && res.status() === 200
  const [replyResponse] = await Promise.all([
    page.waitForResponse(replyMatcher),
    page.mouse.click(actionBox.center.x, actionBox.center.y),
  ])
  assert.equal(replyResponse.status(), 200)
  for (const key of actionKeys) await button(key).waitFor({state: 'detached'})
  const dockCopy = kind === 'permission' ? 'Approve synthetic edit' : 'Synthetic keyboard question'
  await mirror.getByText(dockCopy, {exact: false}).waitFor({state: 'detached'})
  // Prove the model button is genuinely interactive in the Rune scene after dock dismissal (DOM mirror omits disabled state).
  await toggleModelPicker()
  await resize(original)

  return {kind, original, short, anchor, shortMatched, matched, actions, sendPoint, draftAndFocusPreserved: true, partialInputPreserved: true, sceneActionActivated: true}
}
