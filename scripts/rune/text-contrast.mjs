// Check drawn glyph pixels, independently of accessible names or declared ink colours.
import assert from 'node:assert/strict'
import {installPngReader} from './png-pixels.mjs'

export async function installTextContrast(page) {
  await page.evaluate(() => {
    const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))
    const linear = Array.from({length:256}, (_, value) => {
      const s = value / 255
      return s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4
    })
    const luminance = color => linear[color[0]] * .2126 + linear[color[1]] * .7152 + linear[color[2]] * .0722
    globalThis.__codenomadTextContrast = (surface, text) => {
      const background = luminance(rgb(surface)), ink = rgb(text)
      const ratio = color => {
        const value = luminance(color)
        return (Math.max(value, background) + .05) / (Math.min(value, background) + .05)
      }
      return {ratio, matches: color => ratio(color) >= 4.5 &&
        Math.max(Math.abs(color[0]-ink[0]), Math.abs(color[1]-ink[1]), Math.abs(color[2]-ink[2])) <= 40}
    }
  })
}

export async function assertRenderedTextContrast(page, png, regions, palette) {
  await installPngReader(page)
  await installTextContrast(page)
  const records = await page.evaluate(async ({source, regions, palette}) => {
    const [image] = await globalThis.__codenomadReadPngs([source])
    const pixels = image.pixels
    return regions.map(({name, rect, surface, inset = 0, text = 'text-primary'}) => {
      const background = [1,3,5].map(i=>parseInt(palette[surface].slice(i,i+2),16))
      const {ratio,matches} = globalThis.__codenomadTextContrast(palette[surface],palette[text])
      const [x, y, width, height] = rect
      const box = [Math.max(0, Math.ceil(x + inset)), Math.max(0, Math.ceil(y + inset)),
        Math.min(image.width, Math.floor(x + width - inset)), Math.min(image.height, Math.floor(y + height - inset))]
      function measure(pixels) {
        let drawnInkPixels = 0, maxContrast = 1
        for (let py = box[1]; py < box[3]; py++) for (let px = box[0]; px < box[2]; px++) {
        const index = (py * image.width + px) * 4, color = [...pixels.slice(index, index + 3)]
        maxContrast = Math.max(maxContrast, ratio(color))
        // Excludes focus outlines, caret blue, borders, and coloured emoji from the ink count.
        if (matches(color)) drawnInkPixels++
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
