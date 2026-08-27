interface DrawerLayoutOptions {
  hostWidth: number
  minimumCenterWidth: number
  leftWidth: number
  rightWidth: number
  minimumLeftWidth: number
  minimumRightWidth: number
  leftOpen: boolean
  rightOpen: boolean
}

export function resolveEmbeddedDrawers(options: DrawerLayoutOptions) {
  const left = options.leftOpen && options.hostWidth >= options.minimumCenterWidth + options.minimumLeftWidth
  const right =
    options.rightOpen &&
    options.hostWidth >=
      options.minimumCenterWidth + options.minimumRightWidth + (options.leftOpen ? options.minimumLeftWidth : 0)
  const availableWidth = Math.max(0, options.hostWidth - options.minimumCenterWidth)
  const desiredLeftWidth = Math.max(options.minimumLeftWidth, options.leftWidth)
  const desiredRightWidth = Math.max(options.minimumRightWidth, options.rightWidth)

  if (left && right) {
    const leftWidth = Math.min(desiredLeftWidth, availableWidth - options.minimumRightWidth)
    return { left, right, leftWidth, rightWidth: Math.min(desiredRightWidth, availableWidth - leftWidth) }
  }

  return {
    left,
    right,
    leftWidth: left ? Math.min(desiredLeftWidth, availableWidth - (right ? desiredRightWidth : 0)) : desiredLeftWidth,
    rightWidth: right ? Math.min(desiredRightWidth, availableWidth - (left ? desiredLeftWidth : 0)) : desiredRightWidth,
  }
}

export function clampEmbeddedDrawerWidth(width: number, minimumWidth: number, maximumWidth: number, desiredWidth: number) {
  if (width >= maximumWidth && desiredWidth > maximumWidth) return desiredWidth
  return Math.min(Math.max(minimumWidth, width), maximumWidth)
}
