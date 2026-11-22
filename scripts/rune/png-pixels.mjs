// One PNG decoder for browser/reference and Rune offscreen raster checks.
export async function installPngReader(page) {
  await page.evaluate(() => {
    globalThis.__codenomadReadPngs = async sources => Promise.all(sources.map(async source => {
      const image = await new Promise((resolve, reject) => {
        const image = new Image(); image.onload = () => resolve(image)
        image.onerror = () => reject(Error('Invalid PNG')); image.src = source
      })
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height
      const context = canvas.getContext('2d', {willReadFrequently: true}); context.drawImage(image, 0, 0)
      return {width: canvas.width, height: canvas.height,
        pixels: context.getImageData(0, 0, canvas.width, canvas.height).data}
    }))
  })
}
