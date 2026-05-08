import { Select } from "@kobalte/core/select"
import { createEffect, createMemo, createResource, createSignal, type Component } from "solid-js"
import { ChevronDown, Info } from "lucide-solid"
import { useI18n } from "../../lib/i18n"
import { getServerMeta } from "../../lib/server-meta"
import { runtimeEnv } from "../../lib/runtime-env"
import { instances, getInstanceLogs } from "../../stores/instances"
import type { ServerMeta } from "../../../../server/src/api-types"

type LogScope = "summary" | "summary_logs"

interface LogScopeOption {
  value: LogScope
  label: string
}

function detectOs(): string {
  if (typeof navigator === "undefined") return "Unknown"

  const uaData = (navigator as any).userAgentData
  if (uaData?.platform) {
    const arch = uaData.getHighEntropyValues
      ? undefined
      : extractArchFromUA(navigator.userAgent)
    return arch ? `${uaData.platform} ${arch}` : uaData.platform
  }

  const ua = navigator.userAgent
  const p = navigator.platform
  if (!p) return "Unknown"

  const maybeArch = extractArchFromUA(ua)
  if (maybeArch && !p.includes(maybeArch)) {
    return `${p} ${maybeArch}`
  }
  return p
}

function extractArchFromUA(ua: string): string | null {
  const match = ua.match(/Linux\s+(x86_64|aarch64|armv[0-9]+[a-z]*|i[3-6]86)/i)
    ?? ua.match(/Win64;\s*(x64|arm64)/i)
    ?? ua.match(/Mac\s*OS\s*X[^)]*?_(x86_64|arm64)/i)
  return match ? match[1] : null
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toISOString()
}

function buildDiagnosticReport(
  meta: ServerMeta | null,
  scope: LogScope,
): string {
  const lines: string[] = []
  lines.push("CodeNomad Diagnostic Report")
  lines.push("============================")
  lines.push(`Generated: ${new Date().toISOString()}`)
  lines.push(`Server version: ${meta?.serverVersion ?? "unknown"}`)
  lines.push(`UI version: ${meta?.ui?.version ?? "unknown"} (source: ${meta?.ui?.source ?? "unknown"})`)
  lines.push(`Runtime: ${runtimeEnv.host}`)
  lines.push(`Platform: ${runtimeEnv.platform}`)
  lines.push(`Window context: ${runtimeEnv.windowContext}`)
  lines.push(`OS: ${detectOs()}`)
  lines.push(`Server URL: ${meta?.localUrl ?? "unknown"}`)
  lines.push(`Workspace root: ${meta?.workspaceRoot ?? "unknown"}`)
  lines.push(`UI source: ${meta?.ui?.source ?? "unknown"}`)

  if (scope === "summary_logs") {
    lines.push("============================")
    const instanceEntries = instances()
    if (instanceEntries.size === 0) {
      lines.push("")
      lines.push("--- No active instances ---")
    }

    for (const [instanceId, instance] of instanceEntries) {
      const logs = getInstanceLogs(instanceId)
      const label = instance.metadata?.project?.name ?? instance.folder ?? instanceId
      lines.push("")
      lines.push(`--- Workspace: ${label} (last 500 entries) ---`)
      const recent = logs.slice(-500)
      if (recent.length === 0) {
        lines.push("  (no log entries)")
      } else {
        for (const entry of recent) {
          const ts = formatTimestamp(entry.timestamp)
          lines.push(`  [${ts}] [${entry.level}] ${entry.message}`)
        }
      }
    }
  }

  lines.push("")
  return lines.join("\n")
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

function downloadTextFile(filename: string, text: string) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export const InfoSettingsSection: Component = () => {
  const { t } = useI18n()
  const [meta] = createResource(() => getServerMeta())
  const [logScope, setLogScope] = createSignal<LogScope>("summary")
  const [copyFeedback, setCopyFeedback] = createSignal(false)

  const scopeOptions = createMemo<LogScopeOption[]>(() => [
    { value: "summary", label: t("settings.info.diagnostics.scope.summary") },
    { value: "summary_logs", label: t("settings.info.diagnostics.scope.withLogs") },
  ])

  const selectedScope = createMemo(() =>
    scopeOptions().find((opt) => opt.value === logScope()),
  )

  const updateInfo = createMemo(() => {
    const m = meta()
    if (!m?.update) return null
    return m.update
  })

  createEffect(() => {
    if (copyFeedback()) {
      const timer = setTimeout(() => setCopyFeedback(false), 2500)
      return () => clearTimeout(timer)
    }
  })

  const handleCopy = async () => {
    const report = buildDiagnosticReport(meta() ?? null, logScope())
    const ok = await copyToClipboard(report)
    if (ok) setCopyFeedback(true)
  }

  const handleDownload = () => {
    const report = buildDiagnosticReport(meta() ?? null, logScope())
    const ts = new Date().toISOString().replace(/[:.]/g, "-")
    downloadTextFile(`codenomad-diagnostics-${ts}.txt`, report)
  }

  return (
    <div class="settings-section-stack">
      <div class="settings-card">
        <div class="settings-card-header">
          <div class="settings-card-heading-with-icon">
            <Info class="settings-card-heading-icon" />
            <div>
              <h3 class="settings-card-title">{t("settings.section.info.title")}</h3>
              <p class="settings-card-subtitle">{t("settings.section.info.subtitle")}</p>
            </div>
          </div>
        </div>

        <div class="settings-info-grid">
          <div class="settings-info-row">
            <span class="settings-info-label">{t("settings.info.version.server")}</span>
            <span class="settings-info-value">{meta()?.serverVersion ?? "—"}</span>
          </div>
          <div class="settings-info-row">
            <span class="settings-info-label">{t("settings.info.version.ui")}</span>
            <span class="settings-info-value">{meta()?.ui?.version ?? "—"}</span>
          </div>
          <div class="settings-info-row">
            <span class="settings-info-label">{t("settings.info.version.uiSource")}</span>
            <span class="settings-info-value settings-info-value-muted">
              {meta()?.ui?.source ?? "—"}
            </span>
          </div>
          <div class="settings-info-row">
            <span class="settings-info-label">{t("settings.info.runtime.type")}</span>
            <span class="settings-info-value">{runtimeEnv.host}</span>
          </div>
          <div class="settings-info-row">
            <span class="settings-info-label">{t("settings.info.runtime.platform")}</span>
            <span class="settings-info-value">{runtimeEnv.platform}</span>
          </div>
          <div class="settings-info-row">
            <span class="settings-info-label">{t("settings.info.runtime.os")}</span>
            <span class="settings-info-value settings-info-value-muted">{detectOs()}</span>
          </div>
          <div class="settings-info-row">
            <span class="settings-info-label">{t("settings.info.server.url")}</span>
            <span class="settings-info-value settings-info-value-muted">
              {meta()?.localUrl ?? "—"}
            </span>
          </div>
          <div class="settings-info-row">
            <span class="settings-info-label">{t("settings.info.server.root")}</span>
            <span class="settings-info-value settings-info-value-muted">
              {meta()?.workspaceRoot ?? "—"}
            </span>
          </div>
        </div>
      </div>

      <div class="settings-card">
        <div class="settings-card-header">
          <div>
            <h3 class="settings-card-title">{t("settings.info.updates.title")}</h3>
            <p class="settings-card-subtitle">{t("settings.info.updates.subtitle")}</p>
          </div>
        </div>
        <div class="settings-info-actions">
          <button
            type="button"
            class="settings-pill-button"
            disabled
          >
            {updateInfo()
              ? t("settings.info.updates.available", { version: updateInfo()!.version })
              : t("settings.info.updates.upToDate")}
          </button>
        </div>
        <p class="settings-info-update-note">{t("settings.info.updates.check")}</p>
      </div>

      <div class="settings-card">
        <div class="settings-card-header">
          <div>
            <h3 class="settings-card-title">{t("settings.info.diagnostics.title")}</h3>
            <p class="settings-card-subtitle">{t("settings.info.diagnostics.subtitle")}</p>
          </div>
        </div>

        <div class="settings-info-select-row">
          <span class="settings-info-select-label">{t("settings.info.diagnostics.scope.label")}</span>
          <Select<LogScopeOption>
            value={selectedScope()}
            onChange={(opt) => {
              if (opt) setLogScope(opt.value)
            }}
            options={scopeOptions()}
            optionValue="value"
            optionTextValue="label"
            itemComponent={(itemProps) => (
              <Select.Item item={itemProps.item} class="selector-option">
                <Select.ItemLabel class="selector-option-label">{itemProps.item.rawValue.label}</Select.ItemLabel>
              </Select.Item>
            )}
          >
            <Select.Trigger class="selector-trigger" aria-label={t("settings.info.diagnostics.scope.label")}>
              <div class="flex-1 min-w-0">
                <Select.Value<LogScopeOption>>
                  {(state) => (
                    <span class="selector-trigger-primary selector-trigger-primary--align-left">
                      {state.selectedOption()?.label}
                    </span>
                  )}
                </Select.Value>
              </div>
              <Select.Icon class="selector-trigger-icon">
                <ChevronDown class="w-3 h-3" />
              </Select.Icon>
            </Select.Trigger>
            <Select.Portal>
              <Select.Content class="selector-popover">
                <Select.Listbox class="selector-listbox" />
              </Select.Content>
            </Select.Portal>
          </Select>
        </div>

        <div class="settings-info-actions">
          <button
            type="button"
            class="settings-pill-button"
            onClick={handleCopy}
          >
            {t("settings.info.diagnostics.copy")}
          </button>
          <button
            type="button"
            class="settings-pill-button"
            onClick={handleDownload}
          >
            {t("settings.info.diagnostics.download")}
          </button>
        </div>

        {copyFeedback() && (
          <div class="settings-info-toast" role="status" aria-live="polite">
            {t("settings.info.diagnostics.copied")}
          </div>
        )}
      </div>
    </div>
  )
}
