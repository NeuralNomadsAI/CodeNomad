import assert from 'node:assert/strict'
import {installPngReader} from './png-pixels.mjs'

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aN0AAAAASUVORK5CYII='

export async function mobileMoreActions(page, messages, press) {
  const name = messages['messageItem.actions.more']
  const composer = page.getByRole('group', {name:messages['rune.prompt'],exact:true})
  const trigger = composer.getByRole('button', {name,exact:true})
  const editor = page.locator('textarea:focus')
  const draft = 'Brouillon mobile'
  const field = await composer.boundingBox()
  assert(field)
  await page.touchscreen.tap(field.x+field.width/2,field.y+20)
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
  // The current Rune browser mirror exposes a disabled menu row as text.
  assert.equal(await page.getByRole('menuitem',{name:queueName,exact:true}).count(),0)
  await press(messages['promptInput.clear.title'],'menuitem')
  await value('')
  await page.keyboard.press('Control+z')
  await value(draft)
  await toggle()
  const chooser = page.waitForEvent('filechooser',{timeout:15000})
  void chooser.catch(()=>{})
  const attach = messages['promptInput.attachFiles.title'].replace(/[.…]+$/u,'')
  await press(new RegExp(`^${RegExp.escape(attach)}[.…]*$`,'u'),'menuitem')
  await chooser
  await queue.waitFor({state:'detached'})
  return {idleQueueDisabled:true,clearUndo:true,devicePicker:true}
}

export async function longPaste(page, messages) {
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
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/plain', text)
    clipboardData.items.add(new File([Uint8Array.from(atob(png), c => c.charCodeAt(0))], 'capture.png', {type:'image/png'}))
    return !el.dispatchEvent(new ClipboardEvent('paste', {clipboardData, bubbles: true, cancelable: true}))
  }, {text, png}), 'Rune must handle both formats in one browser paste event')
  await expectDraft(token)
  const chip = page.getByText(`${messages['messagePart.pastedText.summary']} #9`, {exact: true})
  const image = page.getByText('clipboard.png', {exact: true})
  await chip.waitFor({state: 'attached'})
  await image.waitFor({state: 'attached'})
  const mac = process.platform === 'darwin'
  await page.keyboard.press(mac ? 'Meta+z' : 'Control+z')
  await expectDraft(initial)
  await page.keyboard.press(mac ? 'Meta+Shift+z' : 'Control+Shift+z')
  await expectDraft(token)
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
  const composer = page.getByRole('group', {name: messages['rune.prompt'], exact:true})
  const more = composer.getByRole('button', {name: messages['messageItem.actions.more'], exact:true})
  const click = async locator => {
    await present()
    const {x, y, width, height} = await locator.boundingBox()
    await page.mouse.click(x + width / 2, y + height / 2)
  }
  const press = async name => {
    await click(more)
    const item = page.getByRole('menuitem', {name: messages[`promptInput.history.${name}AriaLabel`], exact:true})
    await item.waitFor({state:'attached'})
    await click(item)
    await item.waitFor({state:'detached'})
  }
  const expectRecalled = value => page.waitForFunction(text => document.querySelector('textarea')?.value === text, value)
  await press('previous')
  await expectRecalled(token)
  await chip.waitFor({state:'attached'})
  await image.waitFor({state:'attached'})
  await press('next')
  await expectRecalled('nouveau brouillon')
  await press('previous')
  await expectRecalled(token)
  assert.equal(await sent.count(), 0, 'Browsing history must not send a prompt')
  await click(page.getByRole('button', {name: messages['promptInput.overlay.send'], exact:true}))
  await sent.waitFor({state:'attached'})
  assert.equal(await sent.count(), 1)
  await chip.waitFor({state: 'detached'})
  await refused.waitFor({state: 'detached'})
  await present()
  const group = await composer.boundingBox()
  await page.mouse.click(group.x + group.width / 2, group.y + 24)
  await expectDraft('nouveau brouillon')
  return {insertedAtSelection: true, undo: true, retainedPng: true, recalledAfterRefusal: true,
    nextDraftIntact: true, expandedExactlyOnce: true}
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
