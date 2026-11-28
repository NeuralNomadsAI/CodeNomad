import { backendIdOf } from "../lib/backend-identity"
import { serverDisplayName } from "../lib/codenomad-link"
import { getGlobalLocale, tGlobal } from "../lib/i18n"
import { showConfirmDialog } from "./alerts"
import { closeAppTab } from "./app-tab-close"
import { appTabs } from "./app-tabs"
import { preferencesForBackend } from "./preferences"

function serverTabs(id: string) {
  return appTabs().filter(tab => tab.kind === "instance" && backendIdOf(tab.instance) === id
    || tab.kind === "remote-restore" && backendIdOf(tab.snapshot) === id)
}

export function serverRemovalMessage(name: string, tabs: number, recents: number) {
  const locale = getGlobalLocale()
  const plural = new Intl.PluralRules(locale)
  const format = new Intl.NumberFormat(locale)
  const countLabel = (kind: "tabs" | "recents", count: number) =>
    tGlobal(`settings.servers.remove.${kind}.${plural.select(count)}`, { count: format.format(count) })
  if (!tabs && !recents) return tGlobal("folderSelection.remoteProject.removeConfirm", { name })
  const impact = new Intl.ListFormat(locale).format([
    ...(tabs ? [countLabel("tabs", tabs)] : []),
    ...(recents ? [countLabel("recents", recents)] : []),
  ])
  return tGlobal("settings.servers.remove.impact", { name, impact })
}

export async function confirmAndCloseServerTabs(id: string, current: () => boolean, signal?: AbortSignal): Promise<boolean> {
  const host = preferencesForBackend("local")
  const profile = host.remoteServers().find(entry => entry.id === id)
  if (!profile || !current()) return false
  const recents = host.remoteProjectHistory().recents.filter(recent => recent.policy.id === id).length
  const label = tGlobal("folderSelection.servers.remove")
  const confirmed = await showConfirmDialog(
    serverRemovalMessage(serverDisplayName(profile, host.remoteServers()), serverTabs(id).length, recents),
    { title: label, variant: "warning", confirmLabel: label }, signal,
  )
  if (!confirmed || !current()) return false

  const tabs = serverTabs(id)
  // A cancelled temporary-project choice leaves the connection and ordinary tabs intact.
  for (const tab of tabs) {
    if (tab.kind !== "instance" || !tab.instance.temporary) continue
    await closeAppTab(tab.id, { retainWorkspace: true, current })
    if (!current() || appTabs().some(entry => entry.id === tab.id)) return false
  }
  for (const tab of serverTabs(id)) {
    if (!current()) return false
    await closeAppTab(tab.id, { retainWorkspace: true })
  }
  return current() && serverTabs(id).length === 0
}
