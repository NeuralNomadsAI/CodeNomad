import { createMemo, createSignal } from "solid-js"
import { serverApi } from "../lib/api-client"
import { tGlobal } from "../lib/i18n"
import { serverEvents } from "../lib/server-events"
import { getLogger } from "../lib/logger"
import type { SideCar } from "../../../server/src/api-types"

const log = getLogger("api")

export interface SideCarTabRecord {
  token: string
  sidecarId: string
  name: string
  port?: number
  prefixMode: SideCar["prefixMode"]
  proxyBasePath: string
  shellUrl: string
}

function buildSidecarShellUrl(sidecarId: string): string {
  return `/sidecars/${encodeURIComponent(sidecarId)}/`
}

const [sidecars, setSidecars] = createSignal<Map<string, SideCar>>(new Map())
const [sidecarTabs, setSidecarTabs] = createSignal<SideCarTabRecord[]>([])
const [activeSidecarToken, setActiveSidecarToken] = createSignal<string | null>(null)
const [sidecarsLoading, setSidecarsLoading] = createSignal(false)

let loadPromise: Promise<void> | null = null

async function ensureSidecarsLoaded() {
  if (loadPromise) return loadPromise
  setSidecarsLoading(true)
  loadPromise = serverApi.fetchSidecars()
    .then((result) => {
      setSidecars(new Map(result.sidecars.map((sidecar) => [sidecar.id, sidecar])))
    })
    .catch((error) => {
      log.error("Failed to load SideCars", error)
    })
    .finally(() => {
      setSidecarsLoading(false)
      loadPromise = null
    })
  return loadPromise
}

function upsertSidecar(sidecar: SideCar) {
  setSidecars((prev) => {
    const next = new Map(prev)
    next.set(sidecar.id, sidecar)
    return next
  })

  setSidecarTabs((prev) => prev.map((tab) => (tab.sidecarId === sidecar.id ? { ...tab, name: sidecar.name } : tab)))
}

function removeSidecar(sidecarId: string) {
  setSidecars((prev) => {
    const next = new Map(prev)
    next.delete(sidecarId)
    return next
  })

  setSidecarTabs((prev) => {
    const next = prev.filter((tab) => tab.sidecarId !== sidecarId)
    if (!next.some((tab) => tab.token === activeSidecarToken())) {
      setActiveSidecarToken(next[0]?.token ?? null)
    }
    return next
  })
}

serverEvents.on("sidecar.updated", (event) => {
  if (event.type !== "sidecar.updated") return
  upsertSidecar(event.sidecar)
})

serverEvents.on("sidecar.removed", (event) => {
  if (event.type !== "sidecar.removed") return
  removeSidecar(event.sidecarId)
})

async function openSidecarTab(sidecarId: string) {
  await ensureSidecarsLoaded()

  const sidecar = sidecars().get(sidecarId)
  if (!sidecar) {
    throw new Error(tGlobal("sidecars.open.notFound"))
  }
  if (sidecar.status !== "running") {
    throw new Error(tGlobal("sidecars.open.notRunning"))
  }

  const token = `${sidecarId}:${Date.now().toString(36)}`
  const nextTab: SideCarTabRecord = {
    token,
    sidecarId,
    name: sidecar.name,
    port: sidecar.port,
    prefixMode: sidecar.prefixMode,
    proxyBasePath: buildSidecarShellUrl(sidecarId).replace(/\/$/, ""),
    shellUrl: buildSidecarShellUrl(sidecarId),
  }

  setSidecarTabs((prev) => [...prev, nextTab])
  setActiveSidecarToken(nextTab.token)
  return nextTab
}

function closeSidecarTab(token: string) {
  setSidecarTabs((prev) => {
    const index = prev.findIndex((tab) => tab.token === token)
    if (index < 0) return prev
    const next = prev.filter((tab) => tab.token !== token)
    if (activeSidecarToken() === token) {
      const fallback = next[index - 1] ?? next[index] ?? null
      setActiveSidecarToken(fallback?.token ?? null)
    }
    return next
  })
}

const activeSidecarTab = createMemo(() => sidecarTabs().find((tab) => tab.token === activeSidecarToken()) ?? null)

export {
  sidecars,
  sidecarTabs,
  activeSidecarToken,
  activeSidecarTab,
  sidecarsLoading,
  setActiveSidecarToken,
  ensureSidecarsLoaded,
  openSidecarTab,
  closeSidecarTab,
}
