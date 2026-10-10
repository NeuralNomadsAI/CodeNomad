export type DrawerOrientation = "portrait" | "landscape"

export interface DrawerOpenState {
  left: boolean
  right: boolean
}

/**
 * Touch tablets keep one drawer open state per orientation. Portrait starts
 * with both drawers closed so the conversation is reachable; rotating saves the
 * outgoing orientation's state and returns the incoming one's.
 */
export function createOrientationDrawerMemory(landscape: DrawerOpenState) {
  const saved: Record<DrawerOrientation, DrawerOpenState> = {
    portrait: { left: false, right: false },
    landscape: { ...landscape },
  }
  return (from: DrawerOrientation, to: DrawerOrientation, current: DrawerOpenState): DrawerOpenState => {
    saved[from] = { ...current }
    return { ...saved[to] }
  }
}
