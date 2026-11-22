import { batch, createMemo, createSignal } from "solid-js"
import type { Instance } from "../types/instance"
import { activeInstanceId, claimRestoreCreatedInstanceForUser, closeWorkspace, instances, setActiveInstanceId, waitForInstanceInitialSessionHydration, type WorkspaceCreationOwnership } from "./instances"
import { restoreClosedWorkspaceDrafts } from "./closed-workspace-drafts"
import { activeSidecarToken, setActiveSidecarToken, sidecarTabs, type SideCarTabRecord } from "./sidecars"
import { appSessionRestoreGateActive } from "./app-session-restore-gate"
import {
  attachInstanceTabMembership,
  detachInstanceTabMembership,
  onInstanceTabCloseRequested,
  openInstanceTabIds,
} from "./app-tab-membership"
import { workspaceIdentity } from "./app-session-reconciliation"
import { publishInstanceLifecycleAuthority } from "./instance-lifecycle-authority"
import { remoteRestoreTabs, type RemoteRestoreTab } from "./remote-restore-tabs"
import { generateUUID } from "../lib/client-identity"
import { sameServerSelection, type ServerSelectionIntent } from "../lib/native/server-selection-intent"
import { parseInstanceKey } from "../lib/backend-identity"

export interface InstanceAppTab {
  id: string
  kind: "instance"
  instance: Instance
}

export interface SideCarAppTab {
  id: string
  kind: "sidecar"
  sidecarTab: SideCarTabRecord
}

interface BlankAppTab {
  id: string
  kind: "blank"
  server?: ServerSelectionIntent
  setServer: (server: ServerSelectionIntent) => void
}
export type AppTabRecord = InstanceAppTab | SideCarAppTab | RemoteRestoreTab | BlankAppTab

export function allowsAutomaticLocalSetup(tab: AppTabRecord): boolean {
  if (tab.kind === "instance") return parseInstanceKey(tab.instance.id).backendId === "local"
  return tab.kind !== "remote-restore" && (tab.kind !== "blank" || !tab.server)
}

const [blankTabs, setBlankTabs] = createSignal<BlankAppTab[]>([])

export function appendBlankTab(server?: ServerSelectionIntent): string {
  const id = `blank:${generateUUID()}`
  const [selection, setSelection] = createSignal(server && { ...server })
  const tab: BlankAppTab = {
    id, kind: "blank",
    get server() { return selection() },
    setServer: intent => setSelection({ ...intent }),
  }
  setBlankTabs(tabs => [...tabs, tab])
  return id
}

export function openBlankTab(server?: ServerSelectionIntent): void {
  batch(() => {
    if (server) {
      const active = activeAppTab()
      const existing = active?.kind === "blank" ? active : appTabs().find(tab => tab.kind === "blank")
      if (existing) {
        const alreadySelected = existing === active && existing.server && sameServerSelection(server, existing.server)
        existing.setServer(server)
        if (!alreadySelected) selectAppTab(existing.id)
        return
      }
    }
    selectAppTab(appendBlankTab(server))
  })
}

export function closeBlankTab(id: string): void {
  if (!blankTabs().some(tab => tab.id === id)) return
  const fallback = getAdjacentAppTabId(id)
  batch(() => {
    setBlankTabs(tabs => tabs.filter(tab => tab.id !== id))
    setTabOrder(ids => ids.filter(entry => entry !== id))
    setAppTabOrderRevision(revision => revision + 1)
    if (activeAppTabId() === id) selectAppTab(fallback)
  })
}

/** A successful choice occupies its originating blank tab's position. */
export function replaceBlankTab(blankId: string | undefined, chosenId: string): void {
  if (!blankId || !blankTabs().some(tab => tab.id === blankId) || !getAppTabById(chosenId)) return
  const ids = appTabs().map(tab => tab.id).filter(id => id !== chosenId)
  batch(() => {
    setBlankTabs(tabs => tabs.filter(tab => tab.id !== blankId))
    setAppTabOrder(ids.map(id => id === blankId ? chosenId : id))
    setAppTabOrderRevision(revision => revision + 1)
  })
}

export const activeBlankTabId = () => activeAppTab()?.kind === "blank" ? activeAppTabId() ?? undefined : undefined

function getInstanceAppTabId(instanceId: string): string {
  return `instance:${instanceId}`
}

function getSidecarAppTabId(token: string): string {
  return `sidecar:${token}`
}

function getAdjacentAppTabId(tabId: string): string | null {
  const tabs = appTabs()
  const index = tabs.findIndex((tab) => tab.id === tabId)
  if (index < 0) return activeAppTabId()
  return tabs[index - 1]?.id ?? tabs[index + 1]?.id ?? null
}

function getPreferredTabId(): string | null {
  const sidecarToken = activeSidecarToken()
  if (sidecarToken) {
    return getSidecarAppTabId(sidecarToken)
  }

  const instanceId = activeInstanceId()
  if (instanceId) {
    return getInstanceAppTabId(instanceId)
  }

  return null
}

const [activeAppTabId, setActiveAppTabId] = createSignal<string | null>(null)
const [tabOrder, setTabOrder] = createSignal<string[]>([])
const [appTabSelectionRevision, setAppTabSelectionRevision] = createSignal(0)
const [appTabOrderRevision, setAppTabOrderRevision] = createSignal(0)

function rememberTabOrder(tabId: string) {
  setTabOrder((prev) => (prev.includes(tabId) ? prev : [...prev, tabId]))
}

const appTabs = createMemo<AppTabRecord[]>((previous = []) => {
  // Solid's <For> keys by object identity. Metadata refreshes and opening another
  // project must not remount every shell (and restart their Git/status reads).
  const previousById = new Map(previous.map((tab) => [tab.id, tab]))
  const currentTabs = [
    ...blankTabs(),
    ...remoteRestoreTabs(),
    ...Array.from(instances().values())
      .filter((instance) => openInstanceTabIds().has(instance.id))
      .map((instance) => previousById.get(getInstanceAppTabId(instance.id)) ?? ({
        id: getInstanceAppTabId(instance.id),
        kind: "instance" as const,
        get instance() { return instances().get(instance.id) ?? instance },
      })),
    ...sidecarTabs().map((sidecarTab) => previousById.get(getSidecarAppTabId(sidecarTab.token)) ?? ({
      id: getSidecarAppTabId(sidecarTab.token),
      kind: "sidecar" as const,
      get sidecarTab() { return sidecarTabs().find((tab) => tab.token === sidecarTab.token) ?? sidecarTab },
    })),
  ]

  const tabsById = new Map(currentTabs.map((tab) => [tab.id, tab]))
  const orderedIds = tabOrder().filter((tabId) => tabsById.has(tabId))
  const missingIds = currentTabs.map((tab) => tab.id).filter((tabId) => !orderedIds.includes(tabId))

  return [...orderedIds, ...missingIds].map((tabId) => tabsById.get(tabId)!).filter(Boolean)
})

const activeAppTab = createMemo(() => appTabs().find((tab) => tab.id === activeAppTabId()) ?? null)

function getAppTabById(tabId: string | null): AppTabRecord | null {
  if (!tabId) return null
  return appTabs().find((tab) => tab.id === tabId) ?? null
}

function selectAppTab(tabId: string | null, options?: { source?: "restore"; creation?: WorkspaceCreationOwnership }) {
  if (options?.source !== "restore") setAppTabSelectionRevision((revision) => revision + 1)
  if (!tabId) {
    setActiveAppTabId(null)
    setActiveInstanceId(null)
    setActiveSidecarToken(null)
    return
  }

  if (options?.source === "restore" && tabId.startsWith("instance:")) {
    const instanceId = tabId.slice("instance:".length)
    if (instances().has(instanceId)) attachInstanceTabMembership(instanceId)
  }

  const tab = appTabs().find((entry) => entry.id === tabId)
  if (!tab || options?.creation && (tab.kind !== "instance" || !options.creation.current(tab.instance.id))) return false

  rememberTabOrder(tab.id)
  setActiveAppTabId(tab.id)

  if (tab.kind === "instance") {
    if (options?.source !== "restore") claimRestoreCreatedInstanceForUser(tab.instance.id, options?.creation)
    setActiveSidecarToken(null)
    setActiveInstanceId(tab.instance.id)
    return true
  }

  setActiveInstanceId(null)
  setActiveSidecarToken(tab.kind === "sidecar" ? tab.sidecarTab.token : null)
  return true
}

function selectInstanceTab(instanceId: string, creation?: WorkspaceCreationOwnership): boolean {
  if (!instances().has(instanceId) || creation && !creation.current(instanceId)) return false
  // Publish membership and explicit selection together so the opening transfers
  // before automatic tab selection can run.
  return batch(() => {
    attachInstanceTab(instanceId)
    return selectAppTab(getInstanceAppTabId(instanceId), creation ? { creation } : undefined) === true
  })
}

function publishLocalInstanceTabLifecycle(type: "opened" | "removed", instanceId: string): void {
  const instance = instances().get(instanceId)
  if (!instance) return
  const project = workspaceIdentity(instance.folder, instance.backendId)
  const occurrence = Array.from(instances().values())
    .filter((candidate) => workspaceIdentity(candidate.folder, candidate.backendId) === project)
    .findIndex((candidate) => candidate.id === instanceId)
  if (occurrence >= 0) publishInstanceLifecycleAuthority({
    type, instanceId, folder: instance.folder, occurrence, projectTab: true,
    ...(instance.backendId ? { backendId: instance.backendId } : {}),
    ...(instance.serverId ? { serverId: instance.serverId } : {}),
  })
}

function attachInstanceTab(instanceId: string, options?: { source?: "restore" }): void {
  const instance = instances().get(instanceId)
  if (!instance || openInstanceTabIds().has(instanceId)) return
  if (options?.source !== "restore") {
    // Capture can bind a saved occurrence synchronously; otherwise this is a plain opening.
    publishLocalInstanceTabLifecycle("opened", instanceId)
    void restoreClosedWorkspaceDrafts(instanceId, instance.folder, () => waitForInstanceInitialSessionHydration(instanceId))
  }
  attachInstanceTabMembership(instanceId)
}

function closeInstanceTab(instanceId: string): void {
  if (!openInstanceTabIds().has(instanceId)) return
  detachInstanceTab(instanceId)
  void closeWorkspace(instanceId, { keepalive: true }).catch(() => {})
}

/** Local-only removal for server stops, temporary discard and disconnected-dialog dismissal. */
function detachInstanceTab(instanceId: string, options?: { forceFallbackSelection?: boolean }): void {
  if (!openInstanceTabIds().has(instanceId)) return
  const tabId = getInstanceAppTabId(instanceId)
  const fallbackTabId = activeAppTabId() === tabId ? getAdjacentAppTabId(tabId) : activeAppTabId()
  detachInstanceTabMembership(instanceId)
  publishLocalInstanceTabLifecycle("removed", instanceId)
  setTabOrder((previous) => previous.filter((id) => id !== tabId))
  setAppTabSelectionRevision((revision) => revision + 1)
  setAppTabOrderRevision((revision) => revision + 1)
  if (activeAppTabId() !== tabId) return
  setActiveAppTabId(null)
  setActiveInstanceId(null)
  if (options?.forceFallbackSelection) selectAppTab(fallbackTabId)
  else ensureActiveAppTab(fallbackTabId)
}

onInstanceTabCloseRequested((instanceId) => detachInstanceTab(instanceId, { forceFallbackSelection: true }))

function selectSidecarTab(token: string) {
  selectAppTab(getSidecarAppTabId(token))
}

function moveAppTab(tabId: string, targetTabId: string, placement: "before" | "after") {
  if (tabId === targetTabId) return

  const tabs = appTabs()
  const ids = tabs.map((tab) => tab.id)
  if (!ids.includes(tabId) || !ids.includes(targetTabId)) return

  const reorderedIds = ids.filter((id) => id !== tabId)
  const targetIndex = reorderedIds.indexOf(targetTabId)
  if (targetIndex < 0) return

  reorderedIds.splice(placement === "after" ? targetIndex + 1 : targetIndex, 0, tabId)
  setTabOrder(reorderedIds)
  setAppTabOrderRevision((revision) => revision + 1)
}

function markAppTabUserInteraction() {
  setAppTabSelectionRevision((revision) => revision + 1)
  setAppTabOrderRevision((revision) => revision + 1)
}

function setAppTabOrder(tabIds: string[]) {
  const availableIds = appTabs().map((tab) => tab.id)
  const available = new Set(availableIds)
  const seen = new Set<string>()
  const orderedIds: string[] = []

  for (const tabId of tabIds) {
    if (!available.has(tabId) || seen.has(tabId)) continue
    seen.add(tabId)
    orderedIds.push(tabId)
  }
  for (const tabId of availableIds) {
    if (seen.has(tabId)) continue
    orderedIds.push(tabId)
  }

  setTabOrder(orderedIds)
}

export function replaceRestoredAppTab(tabId: string, replacementId: string, replace: () => void) {
  const order = appTabs().map(tab => tab.id === tabId ? replacementId : tab.id)
  const selected = activeAppTabId() === tabId
  replace()
  setAppTabOrder(order)
  if (selected) selectAppTab(replacementId, { source: "restore" })
}

function selectNextAppTab() {
  const tabs = appTabs()
  if (tabs.length <= 1) return

  const current = tabs.findIndex((tab) => tab.id === activeAppTabId())
  const nextIndex = current < 0 ? 0 : (current + 1) % tabs.length
  const nextTab = tabs[nextIndex]
  if (nextTab) selectAppTab(nextTab.id)
}

function selectPreviousAppTab() {
  const tabs = appTabs()
  if (tabs.length <= 1) return

  const current = tabs.findIndex((tab) => tab.id === activeAppTabId())
  const previousIndex = current <= 0 ? tabs.length - 1 : current - 1
  const previousTab = tabs[previousIndex]
  if (previousTab) selectAppTab(previousTab.id)
}

function selectAppTabByIndex(index: number) {
  const tab = appTabs()[index]
  if (tab) selectAppTab(tab.id)
}

function ensureActiveAppTab(preferredTabId?: string | null) {
  if (appSessionRestoreGateActive()) return
  const tabs = appTabs()
  const current = activeAppTabId()

  if (current && tabs.some((tab) => tab.id === current)) {
    return
  }

  const candidateId = preferredTabId ?? getPreferredTabId()
  if (candidateId && tabs.some((tab) => tab.id === candidateId)) {
    selectAppTab(candidateId)
    return
  }

  // Waiting for setup with no tabs is not a new user selection. Otherwise
  // every workspace discovery would fence the saved active tab's recovery.
  if (current !== null || tabs.length > 0) selectAppTab(tabs[0]?.id ?? null)
}

export {
  activeAppTabId,
  appTabOrderRevision,
  appTabSelectionRevision,
  activeAppTab,
  appTabs,
  attachInstanceTab,
  closeInstanceTab,
  detachInstanceTab,
  ensureActiveAppTab,
  getAdjacentAppTabId,
  getAppTabById,
  getInstanceAppTabId,
  getSidecarAppTabId,
  markAppTabUserInteraction,
  moveAppTab,
  setAppTabOrder,
  selectAppTab,
  selectAppTabByIndex,
  selectInstanceTab,
  selectNextAppTab,
  selectPreviousAppTab,
  selectSidecarTab,
}
