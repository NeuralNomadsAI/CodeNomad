import { createEffect, createMemo, createResource, createSignal, For, onCleanup, Show, type Component } from "solid-js"
import { Info, Network } from "lucide-solid"
import { copyToClipboard } from "../../lib/clipboard"
import { useI18n } from "../../lib/i18n"
import { getServerMeta } from "../../lib/server-meta"
import { canOpenRemoteWindows, runtimeEnv } from "../../lib/runtime-env"
import { openSettings } from "../../stores/settings-screen"
import { buildDiagnosticReport, getDiagnosticAddresses, getDiagnosticListeningMode } from "./info-settings-diagnostics"

interface UserAgentData {
  platform?: string
  getHighEntropyValues?: (hints: string[]) => Promise<Record<string, string>>
}

function getUserAgentData(): UserAgentData | undefined {
  return (navigator as any).userAgentData
}

function detectOs(): string {
  if (typeof navigator === "undefined") return "Unknown"

  const uaData = getUserAgentData()
  if (uaData?.platform) {
    const arch = extractArchFromUA(navigator.userAgent)
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

async function resolveArchitecture(): Promise<string | null> {
  try {
    const uaData = getUserAgentData()
    if (!uaData?.getHighEntropyValues) return null
    const values = await uaData.getHighEntropyValues(["architecture", "bitness"])
    const parts: string[] = []
    if (values.architecture && !values.architecture.startsWith("x86")) {
      parts.push(values.architecture)
    }
    if (values.bitness && values.bitness !== "64") {
      parts.push(`${values.bitness}-bit`)
    }
    if (!parts.length && values.architecture) {
      parts.push(values.architecture)
    }
    return parts.length > 0 ? parts.join(" ") : null
  } catch {
    return null
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

function extractReleasePrefix(version: string): string {
  return version.replace(/^v/, "").split("-")[0]
}

function versionNewer(current: string, latest: string): boolean | null {
  const c = extractReleasePrefix(current).split(".").map(Number)
  const l = extractReleasePrefix(latest).split(".").map(Number)
  if (c.some(isNaN) || l.some(isNaN)) return null
  if (l[0] > c[0]) return true
  if (l[0] < c[0]) return false
  if (l[1] > c[1]) return true
  if (l[1] < c[1]) return false
  if (l[2] > c[2]) return true
  return false
}

export const InfoSettingsSection: Component = () => {
  const { t } = useI18n()
  const [metaLoadFailed, setMetaLoadFailed] = createSignal(false)
  const [meta, { mutate }] = createResource(async () => {
    setMetaLoadFailed(false)
    try {
      return await getServerMeta()
    } catch {
      setMetaLoadFailed(true)
      return null
    }
  })
  const [copyFeedback, setCopyFeedback] = createSignal<"success" | "error" | null>(null)
  const [osArch, setOsArch] = createSignal<string | null>(null)

  createEffect(() => {
    resolveArchitecture().then((arch) => {
      if (arch) setOsArch(arch)
    })
  })

  const updateInfo = createMemo(() => {
    const m = meta()
    if (!m?.update) return null
    return m.update
  })

  const supportInfo = createMemo(() => meta()?.support ?? null)

  const diagnosticLabels = createMemo(() => ({
    reportTitle: t("settings.info.diagnostics.reportTitle"),
    generated: t("settings.info.diagnostics.generated"),
    serverVersion: t("settings.info.version.server"),
    uiVersion: t("settings.info.version.ui"),
    uiSource: t("settings.info.version.uiSource"),
    runtime: t("settings.info.runtime.type"),
    platform: t("settings.info.runtime.platform"),
    windowContext: t("settings.info.runtime.windowContext"),
    os: t("settings.info.runtime.os"),
    listeningMode: t("remoteAccess.sections.listeningMode.label"),
    bindHost: t("settings.info.connectivity.host"),
    localListener: t("settings.info.connectivity.localListener"),
    remoteListener: t("settings.info.connectivity.remoteListener"),
    workspaceRoot: t("settings.info.server.root"),
    candidateAddresses: t("remoteAccess.sections.addresses.label"),
    modes: {
      local: t("settings.info.connectivity.mode.local"),
      all: t("settings.info.connectivity.mode.all"),
      specific: t("settings.info.connectivity.mode.specific"),
    },
    scopes: {
      external: t("remoteAccess.address.scope.network"),
      internal: t("remoteAccess.address.scope.internal"),
      loopback: t("remoteAccess.address.scope.loopback"),
    },
  }))

  const latestVersion = createMemo(() => {
    const update = updateInfo()
    if (update?.version) return update.version
    return supportInfo()?.latestServerVersion ?? null
  })

  const showDownloadLink = createMemo(() => {
    let url: string | null = null
    const update = updateInfo()
    if (update?.url) url = update.url
    else if (supportInfo()?.latestServerUrl) url = supportInfo()!.latestServerUrl ?? null
    if (!url) return { url: null, show: false }
    if (update?.url) return { url, show: true }
    const current = meta()?.serverVersion
    const latest = latestVersion()
    if (!current || !latest) return { url: null, show: false }
    return { url, show: versionNewer(current, latest) !== false }
  })

  let feedbackTimer: ReturnType<typeof setTimeout> | undefined

  createEffect(() => {
    if (copyFeedback()) {
      clearTimeout(feedbackTimer)
      feedbackTimer = setTimeout(() => setCopyFeedback(null), 2500)
    }
  })

  onCleanup(() => clearTimeout(feedbackTimer))

  const handleRefresh = async () => {
    setMetaLoadFailed(false)
    try {
      const fresh = await getServerMeta(true)
      mutate(fresh)
    } catch {
      setMetaLoadFailed(true)
    }
  }

  const osDisplay = createMemo(() => {
    const base = detectOs()
    const arch = osArch()
    return arch ? `${base} (${arch})` : base
  })

  const handleCopy = async () => {
    const report = buildDiagnosticReport(meta() ?? null, osDisplay(), runtimeEnv, diagnosticLabels())
    const ok = await copyToClipboard(report)
    if (ok) setCopyFeedback("success")
    else setCopyFeedback("error")
  }

  const handleDownload = () => {
    const report = buildDiagnosticReport(meta() ?? null, osDisplay(), runtimeEnv, diagnosticLabels())
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
            <span class="settings-info-value settings-info-value-muted">{osDisplay()}</span>
          </div>
        </div>
      </div>

      <div class="settings-card">
        <div class="settings-card-header">
          <div class="settings-card-heading-with-icon">
            <Network class="settings-card-heading-icon" />
            <div>
              <h3 class="settings-card-title">{t("settings.info.connectivity.title")}</h3>
              <p class="settings-card-subtitle">{t("settings.info.connectivity.subtitle")}</p>
            </div>
          </div>
        </div>

        <Show when={meta.loading}>
          <div class="settings-card-message" role="status" aria-live="polite">
            {t("remoteAccess.addresses.loading")}
          </div>
        </Show>
        <Show when={metaLoadFailed()}>
          <div class="settings-error-message" role="alert">
            {t("settings.info.connectivity.loadFailed")}
          </div>
        </Show>
        <Show when={meta()}>
          {(serverMeta) => (
            <>
              <dl class="settings-info-grid">
                <div class="settings-info-row">
                  <dt class="settings-info-label">{t("settings.info.version.server")}</dt>
                  <dd class="settings-info-value" dir="ltr">{serverMeta().serverVersion ?? "—"}</dd>
                </div>
                <div class="settings-info-row">
                  <dt class="settings-info-label">{t("remoteAccess.sections.listeningMode.label")}</dt>
                  <dd class="settings-info-value">
                    {t(getDiagnosticListeningMode(serverMeta()) === "specific"
                      ? "settings.info.connectivity.mode.specific"
                      : getDiagnosticListeningMode(serverMeta()) === "all"
                        ? "settings.info.connectivity.mode.all"
                        : "settings.info.connectivity.mode.local")}
                  </dd>
                </div>
                <div class="settings-info-row">
                  <dt class="settings-info-label">{t("settings.info.connectivity.host")}</dt>
                  <dd class="settings-info-value settings-info-value-muted" dir="ltr">{serverMeta().host}</dd>
                </div>
                <div class="settings-info-row">
                  <dt class="settings-info-label">{t("settings.info.connectivity.localListener")}</dt>
                  <dd class="settings-info-value settings-info-value-muted" dir="ltr">{serverMeta().localUrl}</dd>
                </div>
                <Show when={serverMeta().remoteUrl}>
                  {(remoteUrl) => (
                    <div class="settings-info-row">
                      <dt class="settings-info-label">{t("settings.info.connectivity.remoteListener")}</dt>
                      <dd class="settings-info-value settings-info-value-muted" dir="ltr">{remoteUrl()}</dd>
                    </div>
                  )}
                </Show>
                <div class="settings-info-row">
                  <dt class="settings-info-label">{t("settings.info.server.root")}</dt>
                  <dd class="settings-info-value settings-info-value-muted" dir="ltr">{serverMeta().workspaceRoot}</dd>
                </div>
              </dl>

              <h4 class="settings-card-title">{t("remoteAccess.sections.addresses.label")}</h4>
              <Show when={getDiagnosticAddresses(serverMeta()).length > 0} fallback={<div class="settings-card-message">{t("remoteAccess.addresses.none")}</div>}>
                <dl class="settings-info-grid">
                  <For each={getDiagnosticAddresses(serverMeta())}>{(address) => (
                    <div class="settings-info-row">
                      <dt class="settings-info-label">
                        {address.family.toUpperCase()} · {t(address.scope === "external"
                          ? "remoteAccess.address.scope.network"
                          : address.scope === "internal"
                            ? "remoteAccess.address.scope.internal"
                            : "remoteAccess.address.scope.loopback")}
                      </dt>
                      <dd class="settings-info-value settings-info-value-muted" dir="ltr">{address.remoteUrl}</dd>
                    </div>
                  )}</For>
                </dl>
              </Show>
              <p class="settings-help-text">{t("settings.info.connectivity.disclaimer")}</p>

              <Show when={canOpenRemoteWindows()}>
                <div class="settings-info-actions">
                  <button type="button" class="settings-pill-button" onClick={() => openSettings("remote")}>
                    {t("settings.nav.remote")}
                  </button>
                </div>
              </Show>
            </>
          )}
        </Show>
      </div>

      <div class="settings-card">
        <div class="settings-card-header">
          <div>
            <h3 class="settings-card-title">{t("settings.info.updates.title")}</h3>
            <p class="settings-card-subtitle">{t("settings.info.updates.subtitle")}</p>
          </div>
        </div>

        <div class="settings-info-grid">
          <div class="settings-info-row">
            <span class="settings-info-label">{t("settings.info.version.server")}</span>
            <span class="settings-info-value">{meta()?.serverVersion ?? "—"}</span>
          </div>
          <div class="settings-info-row">
            <span class="settings-info-label">{t("settings.info.updates.latest")}</span>
            <span class="settings-info-value settings-info-value-muted">
              {latestVersion() ?? "—"}
            </span>
          </div>
        </div>

        <div class="settings-info-actions">
          {showDownloadLink().show && (
            <a
              href={showDownloadLink().url!}
              target="_blank"
              rel="noopener noreferrer"
              class="settings-pill-button"
            >
              {t("settings.info.updates.download")}
            </a>
          )}
          <button
            type="button"
            class="settings-pill-button"
            onClick={handleRefresh}
            disabled={meta.loading}
          >
            {t("settings.info.updates.refresh")}
          </button>
        </div>
      </div>

      <div class="settings-card">
        <div class="settings-card-header">
          <div>
            <h3 class="settings-card-title">{t("settings.info.diagnostics.title")}</h3>
            <p class="settings-card-subtitle">{t("settings.info.diagnostics.subtitle")}</p>
          </div>
        </div>

        <div class="settings-card-message">{t("settings.info.diagnostics.privacy")}</div>

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

        {copyFeedback() === "success" && (
          <div class="settings-info-toast" role="status" aria-live="polite">
            {t("settings.info.diagnostics.copied")}
          </div>
        )}
        {copyFeedback() === "error" && (
          <div class="settings-error-message" role="alert">
            {t("settings.info.diagnostics.copyFailed")}
          </div>
        )}
      </div>
    </div>
  )
}
