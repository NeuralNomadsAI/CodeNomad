/** Shared, browser-independent sRGB primitives. Colors are canonical opaque RGB. */
export const isCanonicalHexColor = (value: unknown): value is string =>
  typeof value === "string" && /^#[0-9A-F]{6}$/.test(value)

export const channel = (color: string, offset: number) => Number.parseInt(color.slice(offset, offset + 2), 16)

const linear = (value: number): number => {
  const normalized = value / 255
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
}

export const luminance = (color: string): number =>
  0.2126 * linear(channel(color, 1)) + 0.7152 * linear(channel(color, 3)) + 0.0722 * linear(channel(color, 5))

export function contrastRatio(first: string, second: string): number {
  if (!isCanonicalHexColor(first) || !isCanonicalHexColor(second)) return 0
  const [bright, dark] = [luminance(first), luminance(second)].sort((a, b) => b - a)
  return (bright + 0.05) / (dark + 0.05)
}

export const mix = (first: string, second: string, firstWeight: number): string => {
  const mixed = [1, 3, 5].map((offset) =>
    Math.round(channel(first, offset) * firstWeight + channel(second, offset) * (1 - firstWeight)),
  )
  return `#${mixed.map((value) => value.toString(16).padStart(2, "0")).join("").toUpperCase()}`
}

/** OKLab coordinates for opaque canonical sRGB; lightness is on a 0–1 scale. */
export function oklab(color: string): [number, number, number] {
  const [r, g, b] = [1, 3, 5].map(offset => linear(channel(color, offset)))
  const l = Math.cbrt(.4122214708 * r + .5363325363 * g + .0514459929 * b)
  const m = Math.cbrt(.2119034982 * r + .6806995451 * g + .1073969566 * b)
  const s = Math.cbrt(.0883024619 * r + .2817188376 * g + .6299787005 * b)
  return [
    .2104542553 * l + .793617785 * m - .0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + .4505937099 * s,
    .0259040371 * l + .7827717662 * m - .808675766 * s,
  ]
}

export const oklabLightness = (color: string): number => oklab(color)[0]
