// Check drawn glyph pixels, independently of accessible names or declared ink colours.
import assert from 'node:assert/strict'
import {installPngReader} from './png-pixels.mjs'

export async function assertRenderedTextContrast(page, png, regions, palette) {
  await installPngReader(page)
  const records = await page.evaluate(async ({source, regions, palette}) => {
    const [image] = await globalThis.__codenomadReadPngs([source])
    const pixels = image.pixels
    const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))
    const luminance = rgb => rgb.map(value => {const s = value / 255; return s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4})
      .reduce((sum, value, i) => sum + value * [.2126, .7152, .0722][i], 0)
    const contrast = (a, b) => {const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05)}
    return regions.map(({name, rect, surface, inset = 0, text = 'text-primary'}) => {
      const background = rgb(palette[surface]), ink = rgb(palette[text])
      const [x, y, width, height] = rect
      const box = [Math.max(0, Math.ceil(x + inset)), Math.max(0, Math.ceil(y + inset)),
        Math.min(image.width, Math.floor(x + width - inset)), Math.min(image.height, Math.floor(y + height - inset))]
      function measure(pixels) {
        let drawnInkPixels = 0, maxContrast = 1
        for (let py = box[1]; py < box[3]; py++) for (let px = box[0]; px < box[2]; px++) {
        const index = (py * image.width + px) * 4, color = [...pixels.slice(index, index + 3)]
        const ratio = contrast(color, background)
        maxContrast = Math.max(maxContrast, ratio)
        // Excludes focus outlines, caret blue, borders, and coloured emoji from the ink count.
        if (ratio >= 4.5 && Math.max(...color.map((value, i) => Math.abs(value - ink[i]))) <= 40) drawnInkPixels++
        }
        return {drawnInkPixels, maxContrast}
      }
      const erased = pixels.slice()
      for (let py = box[1]; py < box[3]; py++) for (let px = box[0]; px < box[2]; px++) {
        const index = (py * image.width + px) * 4
        for (let channel = 0; channel < 3; channel++) erased[index + channel] = background[channel]
      }
      const negative = measure(erased)
      return {name, rect, sampledBox: box, ...measure(pixels),
        minimumInkPixels: 20, minimumContrast: 4.5,
        erasedNegativeControlPixels: negative.drawnInkPixels,
        erasedNegativeControlRejected: negative.drawnInkPixels < 20}
    })
  }, {source: `data:image/png;base64,${png.toString('base64')}`, regions, palette})
  for (const record of records) {
    assert(record.sampledBox[2] > record.sampledBox[0] && record.sampledBox[3] > record.sampledBox[1], `${record.name}: empty text crop`)
    assert(record.drawnInkPixels >= record.minimumInkPixels,
      `${record.name}: drawn text lacks contrast (${JSON.stringify(record)})`)
    assert(record.erasedNegativeControlRejected, `${record.name}: missing-ink negative control must fail`)
  }
  return records
}
