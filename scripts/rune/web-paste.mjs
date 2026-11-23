import assert from 'node:assert/strict'
import {installPngReader} from './png-pixels.mjs'

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aN0AAAAASUVORK5CYII='

export async function longPaste(page, messages) {
  const field = page.locator('textarea:focus')
  const text = `Fixture web @./literal [pasted #8] 🦀 ${'contenu '.repeat(24)}fin`
  const initial = 'avant retirer après'
  const token = 'avant [pasted #9] après'
  const expectDraft = value => page.waitForFunction(text => document.activeElement?.value === text, value)
  await field.fill(initial)
  await expectDraft(initial)
  await field.evaluate(el => el.setSelectionRange(6, 13))
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
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
  const group = page.getByRole('group', {name: messages['rune.prompt'], exact:true})
  const submit = page.getByRole('button', {name: messages['promptInput.overlay.send'], exact:true})
  const point = async () => {
    const groupBox = await group.boundingBox(), submitBox = await submit.boundingBox()
    assert(groupBox && submitBox, 'Composer must expose its field and actions')
    return [groupBox.x + groupBox.width / 2, groupBox.y + Math.min(54, (submitBox.y - groupBox.y) / 2)]
  }
  await page.keyboard.press('Enter')
  const sent = page.getByText(`avant ${text} après`, {exact: true})
  await sent.waitFor({state: 'attached'})
  await field.waitFor({state:'detached'})
  await page.mouse.click(...await point())
  assert.equal(await field.count(), 0, 'The pending field must not accept pointer focus')
  await page.keyboard.type('must not overwrite')
  await page.getByText(messages['promptInput.send.errorTitle'], {exact:true}).waitFor()
  await page.mouse.click(...await point())
  await expectDraft(token)
  await chip.waitFor({state:'attached'})
  await image.waitFor({state:'attached'})
  await page.keyboard.press('Enter')
  await sent.waitFor({state:'attached'})
  assert.equal(await sent.count(), 1)
  await chip.waitFor({state: 'detached'})
  return {insertedAtSelection: true, undo: true, retainedPng: true, restoredAfterRefusal: true, expandedExactlyOnce: true}
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
