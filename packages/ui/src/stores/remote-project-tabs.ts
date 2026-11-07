import { createSignal } from "solid-js"

/**
 * A tab showing one project of a saved remote CodeNomad server in a native view.
 * `folder` and `title` are what the embedded page last reported; `entryUrl` is a
 * single-use first address (a pairing link), dropped once the view opened it.
 */
export interface RemoteProjectTabRecord {
  token: string
  profileId: string
  folder?: string
  title?: string
  entryUrl?: string
}

const [remoteProjectTabs, setRemoteProjectTabs] = createSignal<RemoteProjectTabRecord[]>([])
const [activeRemoteProjectToken, setActiveRemoteProjectToken] = createSignal<string | null>(null)
let sequence = 0

function openRemoteProjectTab(profileId: string, options: { folder?: string; entryUrl?: string } = {}): RemoteProjectTabRecord {
  const record: RemoteProjectTabRecord = {
    token: `${Date.now().toString(36)}-${(sequence++).toString(36)}`,
    profileId,
    ...(options.folder ? { folder: options.folder } : {}),
    ...(options.entryUrl ? { entryUrl: options.entryUrl } : {}),
  }
  setRemoteProjectTabs((tabs) => [...tabs, record])
  return record
}

function patchRemoteProjectTab(token: string, patch: Partial<Omit<RemoteProjectTabRecord, "token" | "profileId">>): void {
  setRemoteProjectTabs((tabs) => tabs.map((tab) => {
    if (tab.token !== token) return tab
    const next = { ...tab, ...patch }
    for (const key of Object.keys(patch) as Array<keyof typeof patch>) if (patch[key] === undefined) delete next[key]
    return next
  }))
}

function closeRemoteProjectTab(token: string): void {
  setRemoteProjectTabs((tabs) => tabs.filter((tab) => tab.token !== token))
  if (activeRemoteProjectToken() === token) setActiveRemoteProjectToken(null)
}

function closeRemoteProjectTabsForServer(profileId: string): void {
  for (const tab of remoteProjectTabs()) if (tab.profileId === profileId) closeRemoteProjectTab(tab.token)
}

export {
  activeRemoteProjectToken,
  closeRemoteProjectTab,
  closeRemoteProjectTabsForServer,
  openRemoteProjectTab,
  patchRemoteProjectTab,
  remoteProjectTabs,
  setActiveRemoteProjectToken,
}
