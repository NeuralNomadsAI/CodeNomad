import { fetch } from "undici"
import type { UpdateCheckResult, OpenCodeUpdateInfo } from "../api-types"
import type { ConfigStore } from "../config/store"
import type { EventBus } from "../events/bus"
import type { EraDetectionService } from "../era/detection"
import type { BinaryRegistry } from "../config/binaries"
import type { Logger } from "../logger"

const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000 // 24 hours
const NPM_REGISTRY_URL = "https://registry.npmjs.org/opencode-ai/latest"

interface UpdateMonitorOptions {
  configStore: ConfigStore
  eventBus: EventBus
  eraDetection: EraDetectionService
  binaryRegistry: BinaryRegistry
  logger: Logger
}

export interface UpdateMonitor {
  stop(): void
  checkNow(): Promise<UpdateCheckResult>
  getLastResult(): UpdateCheckResult | null
}

interface NpmRegistryResponse {
  version: string
  name?: string
}

/**
 * Compare two semantic version strings.
 * Returns 1 if a > b, -1 if a < b, 0 if equal.
 */
function compareVersions(a: string, b: string): number {
  const partsA = a.replace(/^v/i, "").split(".").map((n) => parseInt(n, 10) || 0)
  const partsB = b.replace(/^v/i, "").split(".").map((n) => parseInt(n, 10) || 0)

  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const numA = partsA[i] ?? 0
    const numB = partsB[i] ?? 0
    if (numA !== numB) {
      return numA > numB ? 1 : -1
    }
  }
  return 0
}

/**
 * Start the update monitor service that checks for Era Code and OpenCode updates.
 * Checks on startup if >24 hours since last check, and schedules periodic checks.
 */
export function startUpdateMonitor(options: UpdateMonitorOptions): UpdateMonitor {
  const { configStore, eventBus, eraDetection, binaryRegistry, logger } = options

  let stopped = false
  let timeoutId: NodeJS.Timeout | null = null
  let lastResult: UpdateCheckResult | null = null

  const runCheck = async (): Promise<UpdateCheckResult> => {
    logger.debug("Running update check")

    const [eraCodeResult, openCodeResult] = await Promise.all([
      checkEraCodeUpdate(eraDetection, logger),
      checkOpenCodeUpdate(binaryRegistry, logger),
    ])

    const result: UpdateCheckResult = {
      eraCode: eraCodeResult,
      openCode: openCodeResult,
      lastChecked: Date.now(),
    }

    // Save last check time to config
    const config = configStore.get()
    configStore.replace({
      ...config,
      preferences: {
        ...config.preferences,
        lastUpdateCheckTime: result.lastChecked,
      },
    })

    lastResult = result

    // Only publish event if there are updates available
    const hasUpdates =
      (eraCodeResult?.available ?? false) || (openCodeResult?.available ?? false)

    if (hasUpdates) {
      logger.info(
        {
          eraCodeUpdate: eraCodeResult?.available,
          openCodeUpdate: openCodeResult?.available,
        },
        "Updates available"
      )
      eventBus.publish({ type: "app.updateAvailable", updates: result })
    } else {
      logger.debug("No updates available")
    }

    return result
  }

  const scheduleNextCheck = (delayMs: number) => {
    if (stopped) return

    timeoutId = setTimeout(async () => {
      if (stopped) return

      try {
        await runCheck()
      } catch (error) {
        logger.warn({ err: error }, "Update check failed")
      }

      // Schedule next check
      scheduleNextCheck(UPDATE_INTERVAL_MS)
    }, delayMs)
  }

  // Initial check logic: check if >24 hours since last check
  const initialize = async () => {
    const config = configStore.get()

    // Respect the user's preference
    if (!config.preferences.autoCheckForUpdates) {
      logger.debug("Auto update checking is disabled")
      return
    }

    const lastCheckTime = config.preferences.lastUpdateCheckTime ?? 0
    const timeSinceLastCheck = Date.now() - lastCheckTime

    if (timeSinceLastCheck >= UPDATE_INTERVAL_MS) {
      // More than 24 hours since last check, run immediately
      logger.info("Running initial update check (last check was >24 hours ago)")
      try {
        await runCheck()
      } catch (error) {
        logger.warn({ err: error }, "Initial update check failed")
      }
      scheduleNextCheck(UPDATE_INTERVAL_MS)
    } else {
      // Schedule check for remaining time
      const remainingTime = UPDATE_INTERVAL_MS - timeSinceLastCheck
      logger.debug(
        { remainingMs: remainingTime },
        "Scheduling next update check"
      )
      scheduleNextCheck(remainingTime)
    }
  }

  // Start initialization asynchronously
  void initialize()

  return {
    stop() {
      stopped = true
      if (timeoutId) {
        clearTimeout(timeoutId)
        timeoutId = null
      }
    },

    async checkNow(): Promise<UpdateCheckResult> {
      return runCheck()
    },

    getLastResult(): UpdateCheckResult | null {
      return lastResult
    },
  }
}

/**
 * Check for Era Code CLI updates using the existing detection service.
 */
async function checkEraCodeUpdate(
  eraDetection: EraDetectionService,
  logger: Logger
): Promise<UpdateCheckResult["eraCode"]> {
  try {
    const result = eraDetection.checkUpgrade()

    if (result.error) {
      logger.debug({ error: result.error }, "Era Code update check returned error")
      return null
    }

    return {
      available: result.available,
      currentVersion: result.currentVersion ?? undefined,
      targetVersion: result.targetVersion ?? undefined,
    }
  } catch (error) {
    logger.debug({ err: error }, "Era Code update check failed")
    return null
  }
}

/**
 * Check for OpenCode updates via npm registry.
 * Compares with the currently installed version from the binary registry.
 */
async function checkOpenCodeUpdate(
  binaryRegistry: BinaryRegistry,
  logger: Logger
): Promise<OpenCodeUpdateInfo | null> {
  try {
    // Get current OpenCode version from binary registry
    const binaries = binaryRegistry.list()
    const openCodeBinary = binaries.find(
      (b) => b.id === "opencode" || b.path.includes("opencode")
    )

    // If opencode is not installed, we can't compare versions
    if (!openCodeBinary?.version) {
      logger.debug("OpenCode binary not found or version unknown")
      return null
    }

    const currentVersion = openCodeBinary.version

    // Fetch latest version from npm registry
    const response = await fetch(NPM_REGISTRY_URL, {
      headers: {
        Accept: "application/json",
        "User-Agent": "Era-Code-CLI",
      },
    })

    if (!response.ok) {
      logger.debug(
        { status: response.status },
        "npm registry request failed"
      )
      return null
    }

    const data = (await response.json()) as NpmRegistryResponse
    const latestVersion = data.version

    if (!latestVersion) {
      logger.debug("npm registry response missing version")
      return null
    }

    // Compare versions
    const updateAvailable = compareVersions(latestVersion, currentVersion) > 0

    logger.debug(
      { currentVersion, latestVersion, updateAvailable },
      "OpenCode version check complete"
    )

    return {
      available: updateAvailable,
      currentVersion,
      latestVersion,
    }
  } catch (error) {
    logger.debug({ err: error }, "OpenCode update check failed")
    return null
  }
}
