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

/**
 * Narrowing shrinks the conversation to its minimum, then the right panel down to its
 * minimum, where it hides; then the left panel down to its minimum, where it hides.
 * Each panel shrinks once and hides at the end of its own compression, so the other
 * never changes width when one hides and widening retraces the same layouts.
 */
export function resolveEmbeddedDrawers(options: DrawerLayoutOptions) {
  const availableWidth = Math.max(0, options.hostWidth - options.minimumCenterWidth)
  const desiredLeftWidth = Math.max(options.minimumLeftWidth, options.leftWidth)
  const desiredRightWidth = Math.max(options.minimumRightWidth, options.rightWidth)
  const left = options.leftOpen && availableWidth >= options.minimumLeftWidth
  // The right panel shrinks first: it docks only beside a wanted left panel at full width.
  const right = options.rightOpen && availableWidth >= options.minimumRightWidth + (options.leftOpen ? desiredLeftWidth : 0)
  const leftWidth = left ? Math.min(desiredLeftWidth, availableWidth) : desiredLeftWidth
  const rightWidth = right ? Math.min(desiredRightWidth, availableWidth - (left ? leftWidth : 0)) : desiredRightWidth
  return { left, right, leftWidth, rightWidth }
}

export function clampEmbeddedDrawerWidth(width: number, minimumWidth: number, maximumWidth: number, desiredWidth: number) {
  if (width >= maximumWidth && desiredWidth > maximumWidth) return desiredWidth
  return Math.min(Math.max(minimumWidth, width), maximumWidth)
}
