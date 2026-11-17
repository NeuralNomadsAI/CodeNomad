import type { Locator } from "playwright"

export type RGB = [number, number, number]
export type ContrastSample = {
  surface: RGB; fill: RGB; foreground: RGB; ratio: number; opacity: number; css: string
}
const luminance = (rgb: RGB) => rgb.map(value => {
  const v = value / 255
  return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4
}).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0)
export const contrast = (a: RGB, b: RGB) =>
  (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05)

/** Paint a uniform sample through isolated ancestor groups. Applying opacity to
 * each color separately would double-count the group's background under its ink.
 * Supports solid overlay gradients used by the real row/selection primitives. */
export async function sampleContrast(target: Locator, options: { property?: string; pseudo?: string } = {}): Promise<ContrastSample> {
  const result = await target.evaluate((element, options) => {
    const chain: Element[] = []
    for (let node: Element | null = element; node; node = node.parentElement) chain.unshift(node)
    const canvas = () => {
      const c = document.createElement("canvas")
      c.width = c.height = 1
      return c.getContext("2d", { willReadFrequently: true })!
    }
    const overlay = (style: CSSStyleDeclaration, node: Element) => {
      const gradient = /^linear-gradient\((.*)\)$/.exec(style.backgroundImage)?.[1]
      if (!gradient) return undefined
      let depth = 0
      for (let i = 0; i < gradient.length; i++) {
        if (gradient[i] === "(") depth++
        else if (gradient[i] === ")") depth--
        else if (gradient[i] === "," && depth === 0) {
          const color = gradient.slice(0, i).trim()
          // Only uniform color overlays can be sampled without gradient geometry.
          if (CSS.supports("color", color) && gradient.slice(i + 1).trim() === color) return color
          // Header separators are 1px directional stripes. Sample at the target's
          // actual centre within that ancestor, not at the stripe on its edge.
          const stripe = /^(to top|to bottom|to left|to right), (.*) ([\d.]+)px, (.*) \3px$/.exec(gradient)
          if (stripe) {
            const box = node.getBoundingClientRect(), target = element.getBoundingClientRect()
            const x = target.x + target.width / 2, y = target.y + target.height / 2
            const distance = { "to top": box.bottom - y, "to bottom": y - box.top,
              "to left": box.right - x, "to right": x - box.left }[stripe[1]]!
            return distance <= Number(stripe[3]) ? stripe[2] : stripe[4]
          }
          throw new Error(`Unsupported contrast gradient: ${style.backgroundImage}`)
        }
      }
      return undefined
    }
    const style = getComputedStyle(element, options.pseudo)
    const property = options.property ?? "color"
    const paint = (mode: "surface" | "fill" | "foreground") => {
      const layer = (index: number, ctx: CanvasRenderingContext2D): void => {
        const node = chain[index], s = getComputedStyle(node)
        const opacity = Number(s.opacity)
        if (opacity !== 1) {
          // Only actual opacity groups isolate their paint. Ordinary ancestors
          // paint directly, avoiding repeated premultiplied-alpha quantization.
          const group = canvas()
          contents(group)
          ctx.save()
          ctx.globalAlpha = opacity
          ctx.drawImage(group.canvas, 0, 0)
          ctx.restore()
        } else contents(ctx)
        function contents(ctx: CanvasRenderingContext2D) {
          const leaf = index === chain.length - 1
          if (!leaf || mode !== "surface") {
            for (const color of [s.backgroundColor, overlay(s, node)]) {
              if (!color) continue
              ctx.fillStyle = color
              ctx.fillRect(0, 0, 1, 1)
            }
          }
          if (!leaf) {
            layer(index + 1, ctx)
          } else {
            // Highlight/selection backgrounds live above the element's own background.
            if (options.pseudo && mode !== "surface") {
              ctx.fillStyle = style.backgroundColor
              ctx.fillRect(0, 0, 1, 1)
            }
            if (mode === "foreground") {
              ctx.globalAlpha = options.pseudo === "::placeholder" ? Number(style.opacity) : 1
              ctx.fillStyle = style.getPropertyValue(property)
              ctx.fillRect(0, 0, 1, 1)
            }
          }
        }
      }
      const ctx = canvas()
      ctx.fillStyle = "#ffffff"
      ctx.fillRect(0, 0, 1, 1)
      layer(0, ctx)
      return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3) as [number, number, number]
    }
    return { surface: paint("surface"), fill: paint("fill"), foreground: paint("foreground"),
      opacity: chain.reduce((value, node) => value * Number(getComputedStyle(node).opacity), 1),
      css: getComputedStyle(element).backgroundColor }
  }, options)
  return { ...result, ratio: contrast(result.foreground, result.fill) }
}
