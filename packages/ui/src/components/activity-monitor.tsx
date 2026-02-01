import { Component, createSignal, createResource, For, Show } from "solid-js"
import {
  AlertTriangle,
  Trash2,
  RefreshCw,
  Skull,
  Clock,
  Package,
  Inbox,
  CheckCircle,
} from "lucide-solid"
import {
  serverApi,
  type ProcessInfo,
  type SessionStatsResponse,
} from "../lib/api-client"
import { showToastNotification } from "../lib/notifications"
import { getLogger } from "../lib/logger"
import { cn } from "../lib/cn"
import { Card, Button, Badge, Separator } from "./ui"

const log = getLogger("activity-monitor")

interface ActivityData {
  processes: ProcessInfo
  sessionStats: SessionStatsResponse
}

const ActivityMonitor: Component = () => {
  const [isLoading, setIsLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  const [data, { refetch }] = createResource<ActivityData | null>(async () => {
    try {
      const [processes, sessionStats] = await Promise.all([
        serverApi.fetchProcesses(),
        serverApi.fetchSessionStats(),
      ])
      setError(null)
      return { processes, sessionStats }
    } catch (err) {
      log.error("Failed to fetch activity data", err)
      setError(err instanceof Error ? err.message : "Failed to fetch activity data")
      return null
    }
  })

  const handleKillProcess = async (pid: number) => {
    setIsLoading(true)
    setError(null)
    try {
      await serverApi.killProcess(pid)
      log.info("Killed process", { pid })
      showToastNotification({
        message: `Killed process ${pid}`,
        variant: "success",
      })
      await refetch()
    } catch (err) {
      log.error("Failed to kill process", { pid, err })
      setError(err instanceof Error ? err.message : `Failed to kill process ${pid}`)
    } finally {
      setIsLoading(false)
    }
  }

  const handleKillAllOrphans = async () => {
    setIsLoading(true)
    setError(null)
    try {
      const result = await serverApi.killAllOrphans()
      log.info("Kill all orphans completed", result)
      showToastNotification({
        message: `Killed ${result.unregisteredCleanup.killed} orphan process(es)`,
        variant: "success",
      })
      await refetch()
    } catch (err) {
      log.error("Failed to kill orphans", err)
      setError(err instanceof Error ? err.message : "Failed to kill orphans")
    } finally {
      setIsLoading(false)
    }
  }

  const handlePurgeStale = async () => {
    const stats = data()?.sessionStats
    if (!stats || stats.staleCount === 0) return
    if (!confirm(`Purge ${stats.staleCount} stale session(s) (not updated in 7+ days)? This cannot be undone.`)) return

    setIsLoading(true)
    setError(null)
    try {
      const result = await serverApi.purgeStaleSession()
      log.info("Purged stale sessions", result)
      showToastNotification({
        message: `Deleted ${result.deleted} stale session(s)`,
        variant: "success",
      })
      await refetch()
    } catch (err) {
      log.error("Failed to purge stale sessions", err)
      setError(err instanceof Error ? err.message : "Failed to purge stale sessions")
    } finally {
      setIsLoading(false)
    }
  }

  const handleCleanBlank = async () => {
    const stats = data()?.sessionStats
    if (!stats || stats.blankCount === 0) return
    if (!confirm(`Delete ${stats.blankCount} blank session(s) with no changes? This cannot be undone.`)) return

    setIsLoading(true)
    setError(null)
    try {
      const result = await serverApi.cleanBlankSessions()
      log.info("Cleaned blank sessions", result)
      showToastNotification({
        message: `Deleted ${result.deleted} blank session(s)`,
        variant: "success",
      })
      await refetch()
    } catch (err) {
      log.error("Failed to clean blank sessions", err)
      setError(err instanceof Error ? err.message : "Failed to clean blank sessions")
    } finally {
      setIsLoading(false)
    }
  }

  const getUptime = (startedAt: string): string => {
    try {
      const started = new Date(startedAt).getTime()
      const now = Date.now()
      const diffMs = now - started
      const diffMinutes = Math.floor(diffMs / 60000)
      const diffHours = Math.floor(diffMinutes / 60)
      const diffDays = Math.floor(diffHours / 24)

      if (diffDays > 0) return `${diffDays}d ${diffHours % 24}h`
      if (diffHours > 0) return `${diffHours}h ${diffMinutes % 60}m`
      return `${diffMinutes}m`
    } catch {
      return "unknown"
    }
  }

  const getFolderName = (folderPath: string): string => {
    return folderPath.split("/").pop() || folderPath
  }

  return (
    <div class="full-settings-section">
      <div class="flex items-center justify-between">
        <div>
          <h2 class="full-settings-section-title">Activity Monitor</h2>
          <p class="full-settings-section-subtitle">Running processes, orphan detection, and session cleanup</p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => refetch()}
          disabled={isLoading() || data.loading}
        >
          <RefreshCw class={cn("w-4 h-4", data.loading && "animate-spin")} />
          Refresh
        </Button>
      </div>

      {/* Error */}
      <Show when={error()}>
        <div class="flex items-center gap-2 rounded-md px-3 py-2.5 text-sm mt-4 bg-destructive/10 text-destructive">
          <AlertTriangle class="w-4 h-4 flex-shrink-0" />
          <span>{error()}</span>
        </div>
      </Show>

      {/* Loading */}
      <Show when={data.loading && !data()}>
        <div class="flex items-center justify-center gap-2 p-8 text-muted-foreground text-sm">
          <RefreshCw class="w-5 h-5 animate-spin" />
          <span>Loading activity data...</span>
        </div>
      </Show>

      <Show when={data()}>
        {(activityData) => (
          <>
            {/* Summary stats */}
            <div class="full-settings-subsection">
              <h3 class="full-settings-subsection-title">Overview</h3>
              <div class="grid grid-cols-4 gap-3 max-sm:grid-cols-2">
                <Card class="flex flex-col items-center gap-1 p-4">
                  <span class="text-2xl font-bold text-foreground">
                    {activityData().processes.summary.totalRegistered}
                  </span>
                  <span class="text-xs text-muted-foreground">Instances</span>
                </Card>
                <Card class="flex flex-col items-center gap-1 p-4">
                  <span class="text-2xl font-bold text-success">
                    {activityData().processes.summary.runningRegistered}
                  </span>
                  <span class="text-xs text-muted-foreground">Running</span>
                </Card>
                <Card class="flex flex-col items-center gap-1 p-4">
                  <span class={cn(
                    "text-2xl font-bold",
                    activityData().processes.summary.unregisteredOrphans > 0 ? "text-destructive" : "text-foreground"
                  )}>
                    {activityData().processes.summary.unregisteredOrphans}
                  </span>
                  <span class="text-xs text-muted-foreground">Orphans</span>
                </Card>
                <Card class="flex flex-col items-center gap-1 p-4">
                  <span class="text-2xl font-bold text-foreground">
                    {activityData().sessionStats.total}
                  </span>
                  <span class="text-xs text-muted-foreground">Sessions</span>
                </Card>
              </div>
            </div>

            <Separator class="my-4" />

            {/* Active Instances */}
            <div class="full-settings-subsection">
              <h3 class="full-settings-subsection-title">Active Instances</h3>
              <Show
                when={activityData().processes.registered.length > 0}
                fallback={
                  <Card class="p-4 text-center text-muted-foreground text-sm">
                    No registered instances
                  </Card>
                }
              >
                <div class="full-settings-list">
                  <For each={activityData().processes.registered}>
                    {(proc) => (
                      <div class={cn(
                        "full-settings-list-item",
                        !proc.running && "opacity-60"
                      )}>
                        <div class={cn(
                          "w-2 h-2 rounded-full flex-shrink-0",
                          proc.running
                            ? "bg-success shadow-[0_0_6px_hsl(var(--success))]"
                            : "bg-muted-foreground"
                        )} />
                        <div class="full-settings-list-item-info">
                          <div class="full-settings-list-item-title">
                            {getFolderName(proc.entry.folder)}
                            <Badge variant="secondary" class="ml-2 font-mono font-normal text-muted-foreground">
                              PID {proc.entry.pid}
                            </Badge>
                          </div>
                          <div class="full-settings-list-item-subtitle">
                            <span class="font-mono overflow-hidden text-ellipsis whitespace-nowrap block">{proc.entry.folder}</span>
                            <Show when={proc.running} fallback={
                              <span class="italic text-muted-foreground">Stale entry</span>
                            }>
                              <span class="inline-flex items-center gap-1 mt-0.5">
                                <Clock class="w-3 h-3" />
                                {getUptime(proc.entry.startedAt)}
                              </span>
                            </Show>
                          </div>
                        </div>
                        <Show when={proc.running}>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleKillProcess(proc.entry.pid)}
                            disabled={isLoading()}
                            title="Kill this process"
                            class="hover:text-destructive"
                          >
                            <Trash2 class="w-4 h-4" />
                          </Button>
                        </Show>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </div>

            {/* Orphaned Processes */}
            <Show when={activityData().processes.unregistered.length > 0}>
              <Separator class="my-4" />
              <div class="full-settings-subsection">
                <div class="flex items-center justify-between mb-3 pb-2 border-b border-border">
                  <h3 class="text-base font-medium text-destructive m-0 flex items-center gap-2">
                    <AlertTriangle class="w-4 h-4" />
                    Orphaned Processes
                  </h3>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={handleKillAllOrphans}
                    disabled={isLoading()}
                  >
                    <Skull class="w-4 h-4" />
                    Kill All
                  </Button>
                </div>
                <div class="full-settings-list">
                  <For each={activityData().processes.unregistered}>
                    {(pid) => (
                      <div class="full-settings-list-item border-destructive">
                        <div class="w-2 h-2 rounded-full flex-shrink-0 bg-destructive animate-pulse" />
                        <div class="full-settings-list-item-info">
                          <div class="full-settings-list-item-title">
                            PID {pid}
                            <Badge variant="destructive" class="ml-2 font-medium">
                              Untracked
                            </Badge>
                          </div>
                          <div class="full-settings-list-item-subtitle">
                            Not associated with any registered workspace
                          </div>
                        </div>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleKillProcess(pid)}
                          disabled={isLoading()}
                          title="Kill this orphan process"
                          class="hover:text-destructive"
                        >
                          <Trash2 class="w-4 h-4" />
                        </Button>
                      </div>
                    )}
                  </For>
                </div>
              </div>
            </Show>

            <Separator class="my-4" />

            {/* Session Cleanup */}
            <div class="full-settings-subsection">
              <h3 class="full-settings-subsection-title">Session Cleanup</h3>
              <p class="text-sm text-muted-foreground -mt-2 mb-3">
                {activityData().sessionStats.total} sessions across {activityData().sessionStats.projectCount} project(s)
              </p>

              <Show
                when={activityData().sessionStats.staleCount > 0 || activityData().sessionStats.blankCount > 0}
                fallback={
                  <Card class="flex items-center gap-2 px-4 py-3 text-success text-sm">
                    <CheckCircle class="w-4 h-4" />
                    <span>All clean — no stale or blank sessions found.</span>
                  </Card>
                }
              >
                <div class="flex flex-col">
                  <Show when={activityData().sessionStats.staleCount > 0}>
                    <div class="full-settings-toggle-row">
                      <div class="full-settings-toggle-info">
                        <div class="full-settings-toggle-title flex items-center gap-1.5">
                          <Package class="w-4 h-4 flex-shrink-0" />
                          {activityData().sessionStats.staleCount} stale session(s)
                        </div>
                        <div class="full-settings-toggle-description">Not updated in 7+ days</div>
                      </div>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={handlePurgeStale}
                        disabled={isLoading()}
                      >
                        Purge
                      </Button>
                    </div>
                  </Show>
                  <Show when={activityData().sessionStats.blankCount > 0}>
                    <div class="full-settings-toggle-row">
                      <div class="full-settings-toggle-info">
                        <div class="full-settings-toggle-title flex items-center gap-1.5">
                          <Inbox class="w-4 h-4 flex-shrink-0" />
                          {activityData().sessionStats.blankCount} blank session(s)
                        </div>
                        <div class="full-settings-toggle-description">Sessions with no changes</div>
                      </div>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={handleCleanBlank}
                        disabled={isLoading()}
                      >
                        Clean
                      </Button>
                    </div>
                  </Show>
                </div>
              </Show>
            </div>
          </>
        )}
      </Show>
    </div>
  )
}

export default ActivityMonitor
