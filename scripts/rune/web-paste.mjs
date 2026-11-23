import assert from 'node:assert/strict'
import {installPngReader} from './png-pixels.mjs'

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aN0AAAAASUVORK5CYII='

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
  const recall = name => page.getByRole('button', {name: messages[`promptInput.history.${name}AriaLabel`], exact:true})
  const press = async name => {
    await present()
    const {x, y, width, height} = await recall(name).boundingBox()
    await page.mouse.click(x + width / 2, y + height / 2)
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
  await page.keyboard.press('Enter')
  await sent.waitFor({state:'attached'})
  assert.equal(await sent.count(), 1)
  await chip.waitFor({state: 'detached'})
  await refused.waitFor({state: 'detached'})
  await present()
  const group = await page.getByRole('group', {name: messages['rune.prompt'], exact:true}).boundingBox()
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
