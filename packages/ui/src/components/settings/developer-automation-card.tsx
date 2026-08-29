import { For, Show, createSignal, onCleanup, onMount, type Component } from "solid-js"
import { useI18n } from "../../lib/i18n"
import {
  getDeveloperRun,
  onDeveloperRunLog,
  onDeveloperRunStatus,
  startDeveloperRun,
  stopDeveloperRun,
  type DeveloperRunLog,
  type DeveloperRunStatus,
  type DeveloperRunTarget,
} from "../../lib/native/developer-run"
import { openNativeFileDialog } from "../../lib/native/native-functions"

const MAX_LOG_ENTRIES = 200

export const DeveloperAutomationCard: Component = () => {
  const { t } = useI18n()
  const [target, setTarget] = createSignal<DeveloperRunTarget>("electron")
  const [executable, setExecutable] = createSignal("")
  const [status, setStatus] = createSignal<DeveloperRunStatus>()
  const [logs, setLogs] = createSignal<DeveloperRunLog[]>([])
  const [starting, setStarting] = createSignal(false)
  const [stopping, setStopping] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  let disposed = false
  let statusRevision = 0
  let logRevision = 0
  let stopRequested = false
  let refreshTimer: number | undefined
  const cleanups: Array<() => void> = []

  const active = () => {
    const state = status()?.state
    return state === "starting" || state === "ready" || state === "stopping" || (state === "error" && Boolean(status()?.runId))
  }

  function applyStatus(next: DeveloperRunStatus) {
    setStatus(next)
    if (next.target) setTarget(next.target)
    if (next.executable) setExecutable(next.executable)
    if (next.error) setError(next.error)
    else setError(null)
  }

  function reportError(cause: unknown, fallbackKey: string) {
    setError(cause instanceof Error && cause.message ? cause.message : t(fallbackKey))
  }

  function register(subscription: Promise<() => void>) {
    void subscription
      .then((cleanup) => disposed ? cleanup() : cleanups.push(cleanup))
      .catch((cause) => {
        if (!disposed) reportError(cause, "settings.developerAutomation.errors.load")
      })
  }

  async function refresh() {
    const currentStatusRevision = statusRevision
    const currentLogRevision = logRevision
    try {
      const snapshot = await getDeveloperRun()
      if (disposed) return
      if (currentStatusRevision === statusRevision) applyStatus(snapshot.status)
      if (currentLogRevision === logRevision) setLogs(snapshot.logs.slice(-MAX_LOG_ENTRIES))
    } catch (cause) {
      if (!disposed) reportError(cause, "settings.developerAutomation.errors.load")
    }
  }

  onMount(() => {
    register(onDeveloperRunStatus((next) => {
      if (disposed) return
      statusRevision += 1
      applyStatus(next)
    }))
    register(onDeveloperRunLog((entry) => {
      if (disposed) return
      logRevision += 1
      setLogs((current) => [...current, entry].slice(-MAX_LOG_ENTRIES))
    }))

    void refresh()
    refreshTimer = window.setInterval(() => void refresh(), 750)
  })

  onCleanup(() => {
    disposed = true
    if (refreshTimer !== undefined) window.clearInterval(refreshTimer)
    cleanups.forEach((cleanup) => cleanup())
  })

  async function chooseExecutable() {
    setError(null)
    try {
      const selected = await openNativeFileDialog({ title: t("settings.developerAutomation.executable.dialogTitle") })
      if (selected) setExecutable(selected)
    } catch (cause) {
      reportError(cause, "settings.developerAutomation.errors.pick")
    }
  }

  async function start() {
    const path = executable().trim()
    if (!path || starting() || stopping() || active()) return
    stopRequested = false
    setStarting(true)
    setError(null)
    logRevision += 1
    setLogs([])
    try {
      applyStatus(await startDeveloperRun({ target: target(), executable: path }))
    } catch (cause) {
      if (!stopRequested) reportError(cause, "settings.developerAutomation.errors.start")
    } finally {
      setStarting(false)
    }
  }

  async function stop() {
    if (stopping() || (!active() && !starting())) return
    stopRequested = true
    setStopping(true)
    setError(null)
    try {
      await stopDeveloperRun()
      const currentLogRevision = logRevision
      const snapshot = await getDeveloperRun()
      applyStatus(snapshot.status)
      if (currentLogRevision === logRevision) setLogs(snapshot.logs.slice(-MAX_LOG_ENTRIES))
    } catch (cause) {
      reportError(cause, "settings.developerAutomation.errors.stop")
    } finally {
      setStopping(false)
    }
  }

  function stateLabel() {
    const state = status()?.state
    if (!state) return t("settings.developerAutomation.state.loading")
    if (state === "stopped") return t("settings.developerAutomation.state.idle")
    if (state === "ready") return t("settings.developerAutomation.state.running")
    if (state === "error") return t("settings.developerAutomation.state.failed")
    return t(`settings.developerAutomation.state.${state}`)
  }

  function formatLogTime(timestamp?: number) {
    return new Date(timestamp ?? Date.now()).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
  }

  function cdpTarget() {
    const current = status()
    const url = current?.targetUrl ?? current?.cdpUrl
    return current?.targetTitle && url ? `${current.targetTitle} (${url})` : current?.targetTitle ?? url
  }

  return (
    <div class="settings-card">
      <div class="settings-card-header">
        <div>
          <h3 class="settings-card-title">{t("settings.developerAutomation.title")}</h3>
          <p class="settings-card-subtitle">{t("settings.developerAutomation.subtitle")}</p>
        </div>
        <span class="settings-scope-badge">{t("settings.scope.device")}</span>
      </div>

      <div class="settings-stack">
        <div class="settings-toggle-row settings-toggle-row-compact">
          <div>
            <label class="settings-toggle-title" for="developer-automation-target">
              {t("settings.developerAutomation.target.title")}
            </label>
            <div class="settings-toggle-caption" id="developer-automation-target-help">
              {t("settings.developerAutomation.target.subtitle")}
            </div>
          </div>
          <select
            id="developer-automation-target"
            class="selector-input w-full max-w-xs"
            value={target()}
            disabled={active() || starting() || stopping()}
            aria-describedby="developer-automation-target-help"
            onChange={(event) => setTarget(event.currentTarget.value as DeveloperRunTarget)}
          >
            <option value="electron">{t("settings.developerAutomation.target.electron")}</option>
            <option value="tauri">{t("settings.developerAutomation.target.tauri")}</option>
          </select>
        </div>

        <div class="settings-toggle-row settings-toggle-row-compact">
          <div>
            <label class="settings-toggle-title" for="developer-automation-executable">
              {t("settings.developerAutomation.executable.title")}
            </label>
            <div class="settings-toggle-caption" id="developer-automation-executable-help">
              {t("settings.developerAutomation.executable.subtitle")}
            </div>
          </div>
          <div class="selector-input-group w-full max-w-md">
            <input
              id="developer-automation-executable"
              class="selector-input"
              value={executable()}
              placeholder={t("settings.developerAutomation.executable.placeholder")}
              readOnly
              disabled={active() || starting() || stopping()}
              aria-describedby="developer-automation-executable-help"
            />
            <button
              type="button"
              class="selector-button selector-button-secondary w-auto whitespace-nowrap"
              disabled={active() || starting() || stopping()}
              onClick={() => void chooseExecutable()}
            >
              {t("settings.developerAutomation.executable.browse")}
            </button>
          </div>
        </div>

        <Show when={error()}>
          {(message) => <div class="settings-error-message" role="alert">{message()}</div>}
        </Show>

        <div class="settings-info-actions">
          <button
            type="button"
            class="selector-button selector-button-primary w-auto"
            disabled={!executable().trim() || active() || starting() || stopping()}
            onClick={() => void start()}
          >
            {starting()
              ? t("settings.developerAutomation.actions.starting")
              : t("settings.developerAutomation.actions.start")}
          </button>
          <button
            type="button"
            class="selector-button selector-button-secondary w-auto"
            disabled={(!active() && !starting()) || stopping()}
            onClick={() => void stop()}
          >
            {stopping()
              ? t("settings.developerAutomation.actions.stopping")
              : t("settings.developerAutomation.actions.stop")}
          </button>
        </div>

        <div>
          <div class="settings-card-section-header">
            <h4 class="settings-card-section-title">{t("settings.developerAutomation.details.title")}</h4>
          </div>
          <dl class="settings-info-grid">
            <div class="settings-info-row">
              <dt class="settings-info-label">{t("settings.developerAutomation.details.state")}</dt>
              <dd class="settings-info-value" aria-live="polite">{stateLabel()}</dd>
            </div>
            <For each={[
              ["build", status()?.executable],
              ["profile", status()?.profilePath],
              ["cdpTarget", cdpTarget()],
            ] as const}>
              {([key, value]) => (
                <div class="settings-info-row">
                  <dt class="settings-info-label">{t(`settings.developerAutomation.details.${key}`)}</dt>
                  <dd class={`settings-info-value${value ? "" : " settings-info-value-muted"}`}>
                    {value || t("settings.developerAutomation.details.unavailable")}
                  </dd>
                </div>
              )}
            </For>
          </dl>
        </div>

        <div class="log-container border border-base max-h-64 min-h-32">
          <div class="log-header">
            <h4 class="settings-card-section-title">{t("settings.developerAutomation.logs.title")}</h4>
          </div>
          <div
            class="log-content"
            role="log"
            aria-live="polite"
            aria-relevant="additions"
            aria-label={t("settings.developerAutomation.logs.ariaLabel")}
          >
            <Show when={logs().length} fallback={<div class="log-empty-state">{t("settings.developerAutomation.logs.empty")}</div>}>
              <For each={logs()}>
                {(entry) => (
                  <div class="log-entry">
                    <span class="log-timestamp">{formatLogTime(entry.timestamp)}</span>
                    <span class={`log-message log-level-${entry.stream === "stderr" ? "error" : "default"}`}>
                      {entry.message}
                    </span>
                  </div>
                )}
              </For>
            </Show>
          </div>
        </div>
      </div>
    </div>
  )
}
