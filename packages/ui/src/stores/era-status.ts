import { createSignal, createMemo } from "solid-js"
import type { EraStatusResponse } from "../../../server/src/api-types"
import { getLogger } from "../lib/logger"
import { ERA_CODE_API_BASE } from "../lib/api-client"

const log = getLogger("era-status")

/**
 * Era Code installation and project status
 */
interface EraStatus extends EraStatusResponse {
  loading: boolean
  error: string | null
  lastFetched: number | null
}

const initialStatus: EraStatus = {
  installed: false,
  version: null,
  binaryPath: null,
  projectInitialized: false,
  assetsAvailable: false,
  loading: false,
  error: null,
  lastFetched: null,
}

const [eraStatus, setEraStatus] = createSignal<EraStatus>(initialStatus)

let initialized = false
let currentFolder: string | null = null

/**
 * Fetch era status from the server
 */
async function fetchEraStatus(folder?: string): Promise<void> {
  setEraStatus((prev) => ({ ...prev, loading: true, error: null }))

  try {
    const params = folder ? `?folder=${encodeURIComponent(folder)}` : ""
    const url = ERA_CODE_API_BASE ? `${ERA_CODE_API_BASE}/api/era/status${params}` : `/api/era/status${params}`
    const response = await fetch(url)

    if (!response.ok) {
      throw new Error(`Failed to fetch era status: ${response.statusText}`)
    }

    const data: EraStatusResponse = await response.json()

    setEraStatus({
      ...data,
      loading: false,
      error: null,
      lastFetched: Date.now(),
    })

    log.info("Era status fetched", {
      installed: data.installed,
      version: data.version,
      projectInitialized: data.projectInitialized,
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error"
    log.warn("Failed to fetch era status", { error: errorMessage })

    setEraStatus((prev) => ({
      ...prev,
      loading: false,
      error: errorMessage,
    }))
  }
}

/**
 * Initialize era status monitoring
 */
export function initEraStatus(): void {
  if (initialized) {
    return
  }
  initialized = true

  // Initial fetch without folder context
  void fetchEraStatus()
}

/**
 * Refresh era status for a specific folder
 */
export function refreshEraStatus(folder?: string): void {
  currentFolder = folder ?? null
  void fetchEraStatus(folder)
}

/**
 * Get the current era status
 */
export function useEraStatus() {
  return eraStatus
}

/**
 * Derived: Is era-code installed?
 */
export const isEraInstalled = createMemo(() => eraStatus().installed)

/**
 * Derived: Era-code version
 */
export const eraVersion = createMemo(() => eraStatus().version)

/**
 * Derived: Is era-code project initialized for current folder?
 */
export const isEraProjectInitialized = createMemo(() => eraStatus().projectInitialized)

/**
 * Derived: Are era assets available?
 */
export const areEraAssetsAvailable = createMemo(() => eraStatus().assetsAvailable)

/**
 * Derived: Era asset counts
 */
export const eraAssetCounts = createMemo(() => eraStatus().assets)

/**
 * Derived: Is era status loading?
 */
export const isEraStatusLoading = createMemo(() => eraStatus().loading)

/**
 * Derived: Era status error
 */
export const eraStatusError = createMemo(() => eraStatus().error)

/**
 * Get era status summary for display
 */
export const eraStatusSummary = createMemo(() => {
  const status = eraStatus()

  if (status.loading) {
    return "Loading..."
  }

  if (status.error) {
    return "Error checking status"
  }

  if (!status.installed) {
    return "Not installed"
  }

  if (status.projectInitialized) {
    return `v${status.version} - Project enabled`
  }

  return `v${status.version}`
})
