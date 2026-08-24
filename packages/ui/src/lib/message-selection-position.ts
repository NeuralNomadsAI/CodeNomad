interface SelectionRect {
  top: number
  bottom: number
  left: number
}

interface SelectionShellRect {
  top: number
  left: number
}

const EDGE_GAP_PX = 8
const DESKTOP_OFFSET_PX = 40
const MOBILE_HANDLE_GAP_PX = 32
const POPOVER_HEIGHT_PX = 40
const POPOVER_WIDTH_PX = 260

export function getMessageSelectionActionPosition(
  selectionRects: readonly SelectionRect[],
  fallbackRect: SelectionRect,
  shellRect: SelectionShellRect,
  shellWidth: number,
  shellHeight: number,
  placeBelowSelection: boolean,
): { top: number; left: number } {
  const anchor = selectionRects.length
    ? selectionRects[placeBelowSelection ? selectionRects.length - 1 : 0]!
    : fallbackRect
  const belowTop = anchor.bottom - shellRect.top + MOBILE_HANDLE_GAP_PX
  const top = placeBelowSelection
    ? belowTop <= shellHeight - POPOVER_HEIGHT_PX - EDGE_GAP_PX ? belowTop : EDGE_GAP_PX
    : anchor.top - shellRect.top - DESKTOP_OFFSET_PX
  const maxLeft = Math.max(shellWidth - POPOVER_WIDTH_PX, EDGE_GAP_PX)

  return {
    top: Math.max(top, EDGE_GAP_PX),
    left: Math.min(Math.max(anchor.left - shellRect.left, EDGE_GAP_PX), maxLeft),
  }
}
