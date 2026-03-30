import { createMemo, createSignal } from "solid-js"
import type { Instance } from "../types/instance"
import { activeInstanceId, instances, setActiveInstanceId } from "./instances"
import { activeSidecarToken, setActiveSidecarToken, sidecarTabs, type SideCarTabRecord } from "./sidecars"

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

export type AppTabRecord = InstanceAppTab | SideCarAppTab

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

function rememberTabOrder(tabId: string) {
  setTabOrder((prev) => (prev.includes(tabId) ? prev : [...prev, tabId]))
}

const appTabs = createMemo<AppTabRecord[]>(() => {
  const currentTabs = [
    ...Array.from(instances().values()).map((instance) => ({
      id: getInstanceAppTabId(instance.id),
      kind: "instance" as const,
      instance,
    })),
    ...sidecarTabs().map((sidecarTab) => ({
      id: getSidecarAppTabId(sidecarTab.token),
      kind: "sidecar" as const,
      sidecarTab,
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

function selectAppTab(tabId: string | null) {
  if (!tabId) {
    setActiveAppTabId(null)
    setActiveSidecarToken(null)
    return
  }

  const tab = appTabs().find((entry) => entry.id === tabId)
  if (!tab) return

  rememberTabOrder(tab.id)
  setActiveAppTabId(tab.id)

  if (tab.kind === "instance") {
    setActiveSidecarToken(null)
    setActiveInstanceId(tab.instance.id)
    return
  }

  setActiveSidecarToken(tab.sidecarTab.token)
}

function selectInstanceTab(instanceId: string) {
  selectAppTab(getInstanceAppTabId(instanceId))
}

function selectSidecarTab(token: string) {
  selectAppTab(getSidecarAppTabId(token))
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

  selectAppTab(tabs[0]?.id ?? null)
}

export {
  activeAppTabId,
  activeAppTab,
  appTabs,
  ensureActiveAppTab,
  getAdjacentAppTabId,
  getAppTabById,
  getInstanceAppTabId,
  getSidecarAppTabId,
  selectAppTab,
  selectAppTabByIndex,
  selectInstanceTab,
  selectNextAppTab,
  selectPreviousAppTab,
  selectSidecarTab,
}
