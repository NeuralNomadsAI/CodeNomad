import assert from 'node:assert/strict'
import {installPngReader} from './png-pixels.mjs'
import {command} from './web-live.mjs'

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aN0AAAAASUVORK5CYII='
export const menuPrompt = 'Mobile menu queued prompt'

export async function mobileMoreActions(page, messages, press) {
  const name = messages['messageItem.actions.more']
  const composer = page.getByRole('group', {name:messages['rune.prompt'],exact:true})
  const trigger = composer.getByRole('button', {name,exact:true})
  const editor = page.locator('textarea:focus')
  const draft = 'Brouillon mobile'
  const focus = async () => {
    const field = await composer.boundingBox()
    assert(field)
    await page.touchscreen.tap(field.x+field.width/2,field.y+20)
    await editor.waitFor({state:'attached'})
  }
  await focus()
  await editor.fill(draft)
  const value = text => page.waitForFunction(text => document.activeElement?.value === text,text)
  await value(draft)
  const toggle = async () => {
    const box = await trigger.boundingBox()
    assert(box)
    await page.touchscreen.tap(box.x+box.width/2,box.y+box.height/2)
  }
  await toggle()
  const queueName = messages['promptInput.send.queueAriaLabel']
  const queue = page.getByText(queueName,{exact:true})
  await queue.waitFor({state:'attached'})
  const a11y = {menu:await page.getByRole('menu',{name,exact:true}).count(),
    disabledRow:await page.getByRole('menuitem',{name:queueName,exact:true,disabled:true}).count()}
  assert.deepEqual(a11y,{menu:1,disabledRow:1},'Web mirror must expose the menu role and disabled queue row')
  const focusState = async (text, caret) => {
    await queue.waitFor({state:'detached'})
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
    return page.evaluate(({text,caret})=>{
      const field=[...document.querySelectorAll('textarea')].find(el=>el.value===text)
      return {focused:field!==undefined&&field===document.activeElement,
        caret:field!==undefined&&field.selectionStart===caret&&field.selectionEnd===caret}
    },{text,caret})
  }
  await press(messages['promptInput.history.previousAriaLabel'],'menuitem')
  const recallFocus=await focusState(menuPrompt,menuPrompt.length)
  await toggle()
  await press(messages['promptInput.clear.title'],'menuitem')
  const clearFocus=await focusState('',0)
  assert.deepEqual(recallFocus,{focused:true,caret:true},'Recall must focus the real textarea and place its caret at the end')
  assert.deepEqual(clearFocus,{focused:true,caret:true},'Clear must focus the real textarea without a second touch')
  await value('')
  await page.keyboard.press('Control+z')
  await value(menuPrompt)
  await toggle()
  const chooser = page.waitForEvent('filechooser',{timeout:15000})
  void chooser.catch(()=>{})
  const attach = messages['promptInput.attachFiles.title'].replace(/[.…]+$/u,'')
  await press(new RegExp(`^${RegExp.escape(attach)}[.…]*$`,'u'),'menuitem')
  await (await chooser).setFiles({name:'mobile-menu.txt',mimeType:'text/plain',buffer:Buffer.from('menu file')})
  await queue.waitFor({state:'detached'})
  await page.getByText('mobile-menu.txt',{exact:true}).waitFor({state:'attached'})
  await command('menu-live')
  await page.getByText('Mobile menu live reply',{exact:true}).waitFor({state:'attached'})
  await toggle()
  const sent=page.waitForResponse(res=>res.ok()&&res.url().endsWith('/session/ses_existing/prompt')&&
    res.request().postDataJSON()?.delivery==='queue')
  void sent.catch(()=>{})
  await press(queueName,'menuitem')
  await sent
  return {a11y,recallFocus,clearFocus,clearUndo:true,devicePicker:true,activeQueue:true}
}

export async function longPaste(page, messages) {
  const composer = page.getByRole('group', {name: messages['rune.prompt'], exact: true})
  const field = page.locator('textarea:focus')
  const text = `Fixture web @./literal [pasted #8] 🦀 ${'contenu '.repeat(24)}fin`
  const initial = 'avant retirer après'
  const token = 'avant [pasted #9] après'
  const expectDraft = value => page.waitForFunction(text => document.activeElement?.value === text, value)
  const present = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await field.fill(initial)
  await expectDraft(initial)
  await field.evaluate(el => el.setSelectionRange(6, 13))
  await present()
  assert(await field.evaluate((el, {text, png}) => {
    const file = new File([Uint8Array.from(atob(png), c => c.charCodeAt(0))], 'capture.png', {type:'image/png'})
    const origArrayBuffer = file.arrayBuffer.bind(file)
    globalThis.__pngPasteReads = 0
    Object.defineProperty(file, 'arrayBuffer', {
      value: () => { globalThis.__pngPasteReads += 1; return origArrayBuffer() },
    })
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/plain', text)
    clipboardData.items.add(file)
    return !el.dispatchEvent(new ClipboardEvent('paste', {clipboardData, bubbles: true, cancelable: true}))
  }, {text, png}), 'Rune must handle both formats in one browser paste event')
  await expectDraft(token)
  const chip = composer.getByText(`${messages['messagePart.pastedText.summary']} #9`, {exact: true})
  const image = composer.getByText('capture.png', {exact: true})
  await chip.waitFor({state: 'attached'})
  await image.waitFor({state: 'attached'})
  assert.equal(await page.evaluate(() => globalThis.__pngPasteReads), 1,
    'Valid pasted PNG must be read once and reused via Source::Png')
  assert.equal(await composer.getByText('clipboard.png', {exact: true}).count(), 0,
    'Pasted PNG must attach once with its WebFile name, without a duplicate clipboard.png chip')
  assert(await page.locator('canvas').first().evaluate(canvas => {
    const file = new File(['dropped text body'], 'dropped.txt', {type: 'text/plain'})
    globalThis.__dropTextReads = 0
    Object.defineProperty(file, 'text', {
      value: () => { globalThis.__dropTextReads += 1; return Promise.resolve('dropped text body') },
    })
    const dataTransfer = new DataTransfer()
    dataTransfer.items.add(file)
    return !canvas.dispatchEvent(new DragEvent('drop', {dataTransfer, bubbles: true, cancelable: true}))
  }), 'Focused composer must capture dropped browser files synchronously')
  const dropped = composer.getByText('dropped.txt', {exact: true})
  await dropped.waitFor({state: 'attached'})
  assert.equal(await page.evaluate(() => globalThis.__dropTextReads), 0,
    'Composer drop must not invoke Rune async File.text()')
  await expectDraft(token)
  const mac = process.platform === 'darwin'
  await page.keyboard.press(mac ? 'Meta+z' : 'Control+z')
  await expectDraft(initial)
  await page.keyboard.press(mac ? 'Meta+Shift+z' : 'Control+Shift+z')
  await expectDraft(token)
  // Start a delayed mixed text+PNG paste before sending (which rotates the composer epoch),
  // then resolve its arrayBuffer() only after the new draft is active.
  assert(await field.evaluate((el, png) => {
    const bytes = Uint8Array.from(atob(png), c => c.charCodeAt(0))
    const delayed = new File([bytes], 'A-delayed.png', {type: 'image/png'})
    globalThis.__releaseDelayedPng = undefined
    Object.defineProperty(delayed, 'arrayBuffer', {
      value: () => new Promise(resolve => { globalThis.__releaseDelayedPng = () => resolve(bytes.buffer.slice(0)) }),
    })
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/plain', ' stale-from-A')
    clipboardData.items.add(delayed)
    return !el.dispatchEvent(new ClipboardEvent('paste', {clipboardData, bubbles: true, cancelable: true}))
  }, png), 'Delayed PNG paste must enter Rune before the epoch change')
  await page.waitForFunction(() => typeof globalThis.__releaseDelayedPng === 'function')
  await page.keyboard.press('Enter')
  const sent = page.getByText(`avant ${text} après`, {exact: true})
  await sent.waitFor({state: 'attached'})
  await expectDraft('')
  await field.fill('nouveau brouillon')
  await expectDraft('nouveau brouillon')
  const refused = page.getByText(messages['promptInput.send.errorTitle'], {exact:true})
  assert.equal(await refused.count(), 0, 'The new draft must be entered before the first receipt')
  await refused.waitFor()
  await sent.waitFor({state:'detached'})
  await expectDraft('nouveau brouillon')
  await page.evaluate(() => {
    if (typeof globalThis.__releaseDelayedPng !== 'function') throw Error('Delayed PNG resolver was not installed')
    globalThis.__releaseDelayedPng()
  })
  await present()
  await field.evaluate(el => el.setSelectionRange(el.value.length, el.value.length))
  await present()
  assert.equal(await page.getByText('A-delayed.png', {exact: true}).count(), 0,
    'A delayed PNG paste resolved after an epoch switch must not attach to the new draft')
  await expectDraft('nouveau brouillon')
  const more = composer.getByRole('button', {name: messages['messageItem.actions.more'], exact:true})
  const click = async locator => {
    await present()
    const {x, y, width, height} = await locator.boundingBox()
    await page.mouse.click(x + width / 2, y + height / 2)
  }
  const pressMenu = async label => {
    await click(more)
    const item = page.getByRole('menuitem', {name: label, exact:true})
    await item.waitFor({state:'attached'})
    await click(item)
    await item.waitFor({state:'detached'})
  }
  const press = name => pressMenu(messages[`promptInput.history.${name}AriaLabel`])
  await press('previous')
  await expectDraft(token)
  await chip.waitFor({state:'attached'})
  await image.waitFor({state:'attached'})
  await dropped.waitFor({state:'attached'})
  await press('next')
  await expectDraft('nouveau brouillon')
  await press('previous')
  await expectDraft(token)
  assert.equal(await sent.count(), 0, 'Browsing history must not send a prompt')
  await click(page.getByRole('button', {name: messages['promptInput.overlay.send'], exact:true}))
  await sent.waitFor({state:'attached'})
  assert.equal(await sent.count(), 1)
  await chip.waitFor({state: 'detached'})
  await image.waitFor({state: 'detached'})
  await dropped.waitFor({state: 'detached'})
  await page.getByText('dropped.txt', {exact: true}).waitFor({state: 'attached'})
  await refused.waitFor({state: 'detached'})
  await present()
  const group = await composer.boundingBox()
  await page.mouse.click(group.x + group.width / 2, group.y + 24)
  await expectDraft('nouveau brouillon')
  // Mixed text + oversized PNG paste must still insert the accompanying clipboard text.
  await field.evaluate(el => el.setSelectionRange(el.value.length, el.value.length))
  await present()
  assert(await field.evaluate(el => {
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/plain', ' suite')
    clipboardData.items.add(new File([new Uint8Array(5 * 1024 * 1024 + 64)], 'oversized.png', {type: 'image/png'}))
    return !el.dispatchEvent(new ClipboardEvent('paste', {clipboardData, bubbles: true, cancelable: true}))
  }), 'Mixed paste with oversized PNG must still route through Rune')
  await expectDraft('nouveau brouillon suite')
  assert.equal(await composer.getByText('oversized.png', {exact: true}).count(), 0,
    'Oversized PNG must not attach')
  // Corrupt under-limit PNG + text must preserve text, reject the corrupt PNG, and never reread it.
  await field.evaluate(el => el.setSelectionRange(el.value.length, el.value.length))
  await present()
  assert(await field.evaluate(el => {
    const file = new File([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])], 'corrupt.png', {type: 'image/png'})
    const origArrayBuffer = file.arrayBuffer.bind(file)
    globalThis.__corruptPngReads = 0
    Object.defineProperty(file, 'arrayBuffer', {
      value: () => { globalThis.__corruptPngReads += 1; return origArrayBuffer() },
    })
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/plain', ' ok')
    clipboardData.items.add(file)
    return !el.dispatchEvent(new ClipboardEvent('paste', {clipboardData, bubbles: true, cancelable: true}))
  }), 'Corrupt PNG mixed paste must route through Rune')
  await expectDraft('nouveau brouillon suite ok')
  const corruptNotice = messages['promptInput.attachFiles.rejected.unreadable'].replace('{name}', 'corrupt.png')
  await composer.getByText(corruptNotice, {exact: true}).waitFor({state: 'attached'})
  assert.equal(await composer.getByText('corrupt.png', {exact: true}).count(), 0,
    'Corrupt under-limit PNG must not attach')
  assert.equal(await page.evaluate(() => globalThis.__corruptPngReads), 1,
    'Corrupt under-limit PNG must not be read a second time')
  // Delayed mixed paste across a same-epoch selection/draft edit must not clobber the edited draft.
  assert(await field.evaluate((el, png) => {
    const bytes = Uint8Array.from(atob(png), c => c.charCodeAt(0))
    const delayed = new File([bytes], 'B-selection.png', {type: 'image/png'})
    globalThis.__releaseSelectionPng = undefined
    Object.defineProperty(delayed, 'arrayBuffer', {
      value: () => new Promise(resolve => { globalThis.__releaseSelectionPng = () => resolve(bytes.buffer.slice(0)) }),
    })
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/plain', ' stale-selection')
    clipboardData.items.add(delayed)
    return !el.dispatchEvent(new ClipboardEvent('paste', {clipboardData, bubbles: true, cancelable: true}))
  }, png), 'Selection-fenced PNG paste must enter Rune')
  await page.waitForFunction(() => typeof globalThis.__releaseSelectionPng === 'function')
  await field.fill('nouveau brouillon suite ok!')
  await expectDraft('nouveau brouillon suite ok!')
  await page.evaluate(() => {
    if (typeof globalThis.__releaseSelectionPng !== 'function') throw Error('Selection PNG resolver was not installed')
    globalThis.__releaseSelectionPng()
  })
  await present()
  await field.evaluate(el => el.setSelectionRange(el.value.length, el.value.length))
  await present()
  assert.equal(await composer.getByText('B-selection.png', {exact: true}).count(), 0,
    'Delayed PNG paste after a same-epoch draft edit must not attach')
  await expectDraft('nouveau brouillon suite ok!')
  // PNG-only drop and multi-file drop must attach all chips without injecting file text.
  assert(await page.locator('canvas').first().evaluate((canvas, png) => {
    const dataTransfer = new DataTransfer()
    dataTransfer.items.add(new File([Uint8Array.from(atob(png), c => c.charCodeAt(0))], 'drop.png', {type: 'image/png'}))
    return !canvas.dispatchEvent(new DragEvent('drop', {dataTransfer, bubbles: true, cancelable: true}))
  }, png), 'PNG-only drop must route through Rune')
  await composer.getByText('drop.png', {exact: true}).waitFor({state: 'attached'})
  assert.equal(await composer.getByText('clipboard.png', {exact: true}).count(), 0,
    'PNG-only drop must not create a duplicate clipboard.png chip')
  assert(await page.locator('canvas').first().evaluate(canvas => {
    const dataTransfer = new DataTransfer()
    dataTransfer.items.add(new File(['first multi'], 'multi-a.txt', {type: 'text/plain'}))
    dataTransfer.items.add(new File(['second multi'], 'multi-b.txt', {type: 'text/plain'}))
    return !canvas.dispatchEvent(new DragEvent('drop', {dataTransfer, bubbles: true, cancelable: true}))
  }), 'Multi-file drop must route through Rune')
  await composer.getByText('multi-a.txt', {exact: true}).waitFor({state: 'attached'})
  await composer.getByText('multi-b.txt', {exact: true}).waitFor({state: 'attached'})
  await expectDraft('nouveau brouillon suite ok!')
  // Mouse clear must focus the real textarea immediately without a second click.
  await pressMenu(messages['promptInput.clear.title'])
  await expectDraft('')
  return {insertedAtSelection: true, undo: true, retainedPng: true, droppedWebFile: true,
    syncComposerDrop: true, delayedPngFenced: true, selectionPasteFenced: true,
    corruptPngRejectedOnce: true, oversizedPngPreservedText: true, pngAndMultiDrop: true,
    mouseClearFocused: true, recalledAfterRefusal: true, nextDraftIntact: true, expandedExactlyOnce: true}
}

export async function focusRing(page, captures, box, inset, color) {
  await installPngReader(page)
  const counts = await page.evaluate(async ({captures, box, inset, color}) => {
    const rgb = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16))
    return (await globalThis.__codenomadReadPngs(captures)).map(({width, pixels}) => {
      const top = Math.round(box.y + inset), left = Math.ceil(box.x + inset + 4)
      const right = Math.floor(box.x + box.width - inset - 4)
      let count = 0
      for (let x = left; x < right; x++) {
        for (let y = top - 1; y <= top + 2; y++) {
          const i = (y * width + x) * 4
          if (rgb.every((n, c) => Math.abs(n - pixels[i + c]) <= 18)) { count++; break }
        }
      }
      return count
    })
  }, {captures: captures.map(png => `data:image/png;base64,${png.toString('base64')}`), box, inset, color})
  assert(counts[0] < 20 && counts[1] > box.width / 2, `Composer focus outline pixels: ${counts}`)
  return {unfocusedPixels: counts[0], focusedPixels: counts[1]}
}
