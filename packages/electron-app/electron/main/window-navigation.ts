import type { BrowserWindow } from "electron"

interface NavigationAuthority {
  generation: number
  trustedOrigins: Set<string>
}

const navigationAuthorities = new WeakMap<BrowserWindow, NavigationAuthority>()

export async function navigateTrustedWindow(
  window: BrowserWindow,
  target: URL,
  nextOrigins: ReadonlySet<string>,
  trustedOrigins: Map<number, Set<string>>,
): Promise<void> {
  let authority = navigationAuthorities.get(window)
  if (!authority) {
    authority = { generation: 0, trustedOrigins: new Set(trustedOrigins.get(window.id)) }
    navigationAuthorities.set(window, authority)
  }
  const generation = ++authority.generation
  const committedOrigins = new Set(nextOrigins)
  trustedOrigins.set(window.id, new Set([...authority.trustedOrigins, ...committedOrigins]))

  try {
    await window.loadURL(target.toString())
  } catch (error) {
    if (authority.generation !== generation) return
    if (authority.trustedOrigins.size) trustedOrigins.set(window.id, new Set(authority.trustedOrigins))
    else trustedOrigins.delete(window.id)
    throw error
  }

  if (authority.generation !== generation) return
  authority.trustedOrigins = committedOrigins
  trustedOrigins.set(window.id, committedOrigins)
}
