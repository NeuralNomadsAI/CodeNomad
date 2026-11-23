import assert from 'node:assert/strict'

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
  assert(await field.evaluate((el, text) => {
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/plain', text)
    return !el.dispatchEvent(new ClipboardEvent('paste', {clipboardData, bubbles: true, cancelable: true}))
  }, text), 'Rune must handle the browser paste event')
  await expectDraft(token)
  const chip = page.getByText(`${messages['messagePart.pastedText.summary']} #9`, {exact: true})
  await chip.waitFor({state: 'attached'})
  const mac = process.platform === 'darwin'
  await page.keyboard.press(mac ? 'Meta+z' : 'Control+z')
  await expectDraft(initial)
  await page.keyboard.press(mac ? 'Meta+Shift+z' : 'Control+Shift+z')
  await expectDraft(token)
  await page.keyboard.press('Enter')
  const sent = page.getByText(`avant ${text} après`, {exact: true})
  await sent.waitFor({state: 'attached'})
  assert.equal(await sent.count(), 1)
  await chip.waitFor({state: 'detached'})
  return {insertedAtSelection: true, undo: true, expandedExactlyOnce: true}
}
