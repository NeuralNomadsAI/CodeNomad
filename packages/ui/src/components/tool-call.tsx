import { createSignal, Show, For, createEffect, createMemo, onCleanup } from "solid-js"
import { messageStoreBus } from "../stores/message-v2/bus"
import { Markdown } from "./markdown"
import { ToolCallDiffViewer } from "./diff-viewer"
import { useTheme } from "../lib/theme"
import { useGlobalCache } from "../lib/hooks/use-global-cache"
import { useConfig } from "../stores/preferences"
import type { DiffViewMode } from "../stores/preferences"
import { sendPermissionResponse } from "../stores/instances"
import type { TextPart, RenderCache } from "../types/message"
import { resolveToolRenderer } from "./tool-call/renderers"
import type { DiffPayload, DiffRenderOptions, MarkdownRenderOptions, ToolCallPart, ToolRendererContext } from "./tool-call/types"
import { getRelativePath, getToolIcon, getToolName, isToolStateCompleted, isToolStateError, isToolStateRunning } from "./tool-call/utils"
import { getLogger } from "../lib/logger"

const log = getLogger("session")

type ToolState = import("@opencode-ai/sdk").ToolState

const TOOL_CALL_CACHE_SCOPE = "tool-call"

function makeRenderCacheKey(
  toolCallId?: string | null,
  messageId?: string,
  partId?: string | null,
  variant = "default",
) {
  const messageComponent = messageId ?? "unknown-message"
  const toolCallComponent = partId ?? toolCallId ?? "unknown-tool-call"
  return `${messageComponent}:${toolCallComponent}:${variant}`
}


interface ToolCallProps {
  toolCall: ToolCallPart
  toolCallId?: string
  messageId?: string
  messageVersion?: number
  partVersion?: number
  instanceId: string
  sessionId: string
  onContentRendered?: () => void
 }



interface LspRangePosition {
  line?: number
  character?: number
}

interface LspRange {
  start?: LspRangePosition
}

interface LspDiagnostic {
  message?: string
  severity?: number
  range?: LspRange
}

interface DiagnosticEntry {
  id: string
  severity: number
  tone: "error" | "warning" | "info"
  label: string
  icon: string
  message: string
  filePath: string
  displayPath: string
  line: number
  column: number
}


function normalizeDiagnosticPath(path: string) {
  return path.replace(/\\/g, "/")
}

function determineSeverityTone(severity?: number): DiagnosticEntry["tone"] {
  if (severity === 1) return "error"
  if (severity === 2) return "warning"
  return "info"
}

function getSeverityMeta(tone: DiagnosticEntry["tone"]) {
  if (tone === "error") return { label: "ERR", icon: "!", rank: 0 }
  if (tone === "warning") return { label: "WARN", icon: "!", rank: 1 }
  return { label: "INFO", icon: "i", rank: 2 }
}

function extractDiagnostics(state: ToolState | undefined): DiagnosticEntry[] {
  if (!state) return []
  const supportsMetadata = isToolStateRunning(state) || isToolStateCompleted(state) || isToolStateError(state)
  if (!supportsMetadata) return []

  const metadata = (state.metadata || {}) as Record<string, unknown>
  const input = (state.input || {}) as Record<string, unknown>
  const diagnosticsMap = metadata?.diagnostics as Record<string, LspDiagnostic[] | undefined> | undefined
  if (!diagnosticsMap) return []

  const preferredPath = [
    input.filePath,
    metadata.filePath,
    metadata.filepath,
    input.path,
  ].find((value) => typeof value === "string" && value.length > 0) as string | undefined

  const normalizedPreferred = preferredPath ? normalizeDiagnosticPath(preferredPath) : undefined
  const candidateEntries = Object.entries(diagnosticsMap).filter(([, items]) => Array.isArray(items) && items.length > 0)
  if (candidateEntries.length === 0) return []

  const prioritizedEntries = (() => {
    if (!normalizedPreferred) return candidateEntries
    const matched = candidateEntries.filter(([path]) => {
      const normalized = normalizeDiagnosticPath(path)
      if (normalized === normalizedPreferred) return true
      if (normalized.endsWith(`/${normalizedPreferred}`)) return true
      const normalizedBase = normalized.split("/").pop()
      const preferredBase = normalizedPreferred.split("/").pop()
      return normalizedBase && preferredBase ? normalizedBase === preferredBase : false
    })
    return matched.length > 0 ? matched : candidateEntries
  })()

  const entries: DiagnosticEntry[] = []
  for (const [pathKey, list] of prioritizedEntries) {
    if (!Array.isArray(list)) continue
    const normalizedPath = normalizeDiagnosticPath(pathKey)
    for (let index = 0; index < list.length; index++) {
      const diagnostic = list[index]
      if (!diagnostic || typeof diagnostic.message !== "string") continue
      const tone = determineSeverityTone(typeof diagnostic.severity === "number" ? diagnostic.severity : undefined)
      const severityMeta = getSeverityMeta(tone)
      const line = typeof diagnostic.range?.start?.line === "number" ? diagnostic.range.start.line + 1 : 0
      const column = typeof diagnostic.range?.start?.character === "number" ? diagnostic.range.start.character + 1 : 0
      entries.push({
        id: `${normalizedPath}-${index}-${diagnostic.message}`,
        severity: severityMeta.rank,
        tone,
        label: severityMeta.label,
        icon: severityMeta.icon,
        message: diagnostic.message,
        filePath: normalizedPath,
        displayPath: getRelativePath(normalizedPath),
        line,
        column,
      })
    }
  }

  return entries.sort((a, b) => a.severity - b.severity)
}

function diagnosticFileName(entries: DiagnosticEntry[]) {
  const first = entries[0]
  return first ? first.displayPath : ""
}

function renderDiagnosticsSection(
  entries: DiagnosticEntry[],
  expanded: boolean,
  toggle: () => void,
  fileLabel: string,
) {
  if (entries.length === 0) return null
  return (
    <div class="tool-call-diagnostics-wrapper">
      <button
        type="button"
        class="tool-call-diagnostics-heading"
        aria-expanded={expanded}
        onClick={toggle}
      >
        <span class="tool-call-icon" aria-hidden="true">
          {expanded ? "▼" : "▶"}
        </span>
        <span class="tool-call-emoji" aria-hidden="true">🛠</span>
        <span class="tool-call-summary">Diagnostics</span>
        <span class="tool-call-diagnostics-file" title={fileLabel}>{fileLabel}</span>
      </button>
      <Show when={expanded}>
        <div class="tool-call-diagnostics" role="region" aria-label="Diagnostics">
          <div class="tool-call-diagnostics-body" role="list">
            <For each={entries}>
              {(entry) => (
                <div class="tool-call-diagnostic-row" role="listitem">
                  <span class={`tool-call-diagnostic-chip tool-call-diagnostic-${entry.tone}`}>
                    <span class="tool-call-diagnostic-chip-icon">{entry.icon}</span>
                    <span>{entry.label}</span>
                  </span>
                  <span class="tool-call-diagnostic-path" title={entry.filePath}>
                    {entry.displayPath}
                    <span class="tool-call-diagnostic-coords">
                      :L{entry.line || "-"}:C{entry.column || "-"}
                    </span>
                  </span>
                  <span class="tool-call-diagnostic-message">{entry.message}</span>
                </div>
              )}
            </For>
          </div>
        </div>
      </Show>
    </div>
  )
}

export default function ToolCall(props: ToolCallProps) {
  const { preferences, setDiffViewMode } = useConfig()
  const { isDark } = useTheme()
  const toolCallMemo = createMemo(() => props.toolCall)
  const toolName = createMemo(() => toolCallMemo()?.tool || "")
  const toolCallIdentifier = createMemo(() => toolCallMemo()?.callID || props.toolCallId || toolCallMemo()?.id || "")
  const toolState = createMemo(() => toolCallMemo()?.state)

  const cacheContext = createMemo(() => ({
    toolCallId: toolCallIdentifier(),
    messageId: props.messageId,
    partId: toolCallMemo()?.id ?? null,
  }))

  const store = createMemo(() => messageStoreBus.getOrCreate(props.instanceId))

  const createVariantCache = (variant: string) =>

    useGlobalCache({
      instanceId: () => props.instanceId,
      sessionId: () => props.sessionId,
      scope: TOOL_CALL_CACHE_SCOPE,
      key: () => {
        const context = cacheContext()
        return makeRenderCacheKey(context.toolCallId || undefined, context.messageId, context.partId, variant)
      },
    })

  const diffCache = createVariantCache("diff")
  const permissionDiffCache = createVariantCache("permission-diff")
  const markdownCache = createVariantCache("markdown")
  const permissionState = createMemo(() => store().getPermissionState(props.messageId, toolCallIdentifier()))
  const pendingPermission = createMemo(() => {
    const state = permissionState()
    if (state) {
      return { permission: state.entry.permission, active: state.active }
    }
    return toolCallMemo()?.pendingPermission
  })
  const toolOutputDefaultExpanded = createMemo(() => (preferences().toolOutputExpansion || "expanded") === "expanded")
  const diagnosticsDefaultExpanded = createMemo(() => (preferences().diagnosticsExpansion || "expanded") === "expanded")

  const defaultExpandedForTool = createMemo(() => {
    const prefExpanded = toolOutputDefaultExpanded()
    const toolName = toolCallMemo()?.tool || ""
    if (toolName === "read") {
      return false
    }
    return prefExpanded
  })

  const [userExpanded, setUserExpanded] = createSignal<boolean | null>(null)

  const expanded = () => {
    const permission = pendingPermission()
    if (permission?.active) return true
    const override = userExpanded()
    if (override !== null) return override
    return defaultExpandedForTool()
  }

  const permissionDetails = createMemo(() => pendingPermission()?.permission)
  const isPermissionActive = createMemo(() => pendingPermission()?.active === true)
  const activePermissionKey = createMemo(() => {
    const permission = permissionDetails()
    return permission && isPermissionActive() ? permission.id : ""
  })
  const [permissionSubmitting, setPermissionSubmitting] = createSignal(false)
  const [permissionError, setPermissionError] = createSignal<string | null>(null)
  const [diagnosticsOverride, setDiagnosticsOverride] = createSignal<boolean | undefined>(undefined)

  const diagnosticsExpanded = () => {
    const permission = pendingPermission()
    if (permission?.active) return true
    const override = diagnosticsOverride()
    if (override !== undefined) return override
    return diagnosticsDefaultExpanded()
  }

  const diagnosticsEntries = createMemo(() => {
    const state = toolState()
    if (!state) return []
    return extractDiagnostics(state)
  })


  let scrollContainerRef: HTMLDivElement | undefined
  let toolCallRootRef: HTMLDivElement | undefined

  const persistScrollSnapshot = (_element?: HTMLElement | null) => {}
 
  const handleScrollRendered = () => {}
 
  const initializeScrollContainer = (element: HTMLDivElement | null | undefined) => {
    scrollContainerRef = element || undefined
  }



  createEffect(() => {
    const permission = permissionDetails()
    if (!permission) {
      setPermissionSubmitting(false)
      setPermissionError(null)
    } else {
      setPermissionError(null)
    }
  })


  createEffect(() => {
    const activeKey = activePermissionKey()
    if (!activeKey) return
    requestAnimationFrame(() => {
      toolCallRootRef?.scrollIntoView({ block: "center", behavior: "smooth" })
    })
  })

  createEffect(() => {
    const activeKey = activePermissionKey()
    if (!activeKey) return
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Enter") {
        event.preventDefault()
        handlePermissionResponse("once")
      } else if (event.key === "a" || event.key === "A") {
        event.preventDefault()
        handlePermissionResponse("always")
      } else if (event.key === "d" || event.key === "D") {
        event.preventDefault()
        handlePermissionResponse("reject")
      }
    }
    document.addEventListener("keydown", handler)
    onCleanup(() => document.removeEventListener("keydown", handler))
  })

  createEffect(() => {
    if (!expanded()) {
      scrollContainerRef = undefined
    }
  })

  const statusIcon = () => {
    const status = toolState()?.status || ""
    switch (status) {
      case "pending":
        return "⏸"
      case "running":
        return "⏳"
      case "completed":
        return "✓"
      case "error":
        return "✗"
      default:
        return ""
    }
  }

  const statusClass = () => {
    const status = toolState()?.status || "pending"
    return `tool-call-status-${status}`
  }

  const combinedStatusClass = () => {
    const base = statusClass()
    return pendingPermission() ? `${base} tool-call-awaiting-permission` : base
  }

  function toggle() {
    const permission = pendingPermission()
    if (permission?.active) {
      return
    }
    setUserExpanded((prev) => {
      const current = prev === null ? defaultExpandedForTool() : prev
      return !current
    })
  }

  const renderer = createMemo(() => resolveToolRenderer(toolName()))

  function renderDiffContent(payload: DiffPayload, options?: DiffRenderOptions) {
    const relativePath = payload.filePath ? getRelativePath(payload.filePath) : ""
    const toolbarLabel = options?.label || (relativePath ? `Diff · ${relativePath}` : "Diff")
    const selectedVariant = options?.variant === "permission-diff" ? "permission-diff" : "diff"
    const cacheHandle = selectedVariant === "permission-diff" ? permissionDiffCache : diffCache
    const diffMode = () => (preferences().diffViewMode || "split") as DiffViewMode
    const themeKey = isDark() ? "dark" : "light"

    let cachedHtml: string | undefined
    const cached = cacheHandle.get<RenderCache>()
    const currentMode = diffMode()
    if (cached && cached.text === payload.diffText && cached.theme === themeKey && cached.mode === currentMode) {
      cachedHtml = cached.html
    }

    const handleModeChange = (mode: DiffViewMode) => {
      setDiffViewMode(mode)
    }

    const handleDiffRendered = () => {
      if (!options?.disableScrollTracking) {
        handleScrollRendered()
      }
      props.onContentRendered?.()
    }

    return (
      <div
        class="message-text tool-call-markdown tool-call-markdown-large tool-call-diff-shell"
        ref={(element) => {
          if (options?.disableScrollTracking) return
          initializeScrollContainer(element)
        }}
        onScroll={options?.disableScrollTracking ? undefined : (event) => persistScrollSnapshot(event.currentTarget)}
      >
        <div class="tool-call-diff-toolbar" role="group" aria-label="Diff view mode">
          <span class="tool-call-diff-toolbar-label">{toolbarLabel}</span>
          <div class="tool-call-diff-toggle">
            <button
              type="button"
              class={`tool-call-diff-mode-button${diffMode() === "split" ? " active" : ""}`}
              aria-pressed={diffMode() === "split"}
              onClick={() => handleModeChange("split")}
            >
              Split
            </button>
            <button
              type="button"
              class={`tool-call-diff-mode-button${diffMode() === "unified" ? " active" : ""}`}
              aria-pressed={diffMode() === "unified"}
              onClick={() => handleModeChange("unified")}
            >
              Unified
            </button>
          </div>
        </div>
        <ToolCallDiffViewer
          diffText={payload.diffText}
          filePath={payload.filePath}
          theme={themeKey}
          mode={diffMode()}
          cachedHtml={cachedHtml}
          cacheEntryParams={cacheHandle.params()}
          onRendered={handleDiffRendered}
        />
      </div>
    )
  }

  function renderMarkdownContent(options: MarkdownRenderOptions) {
    if (!options.content) {
      return null
    }

    const size = options.size || "default"
    const disableHighlight = options.disableHighlight || false
    const messageClass = `message-text tool-call-markdown${size === "large" ? " tool-call-markdown-large" : ""}`

    const markdownPart: TextPart = { type: "text", text: options.content }
    const cached = markdownCache.get<RenderCache>()
    if (cached) {
      markdownPart.renderCache = cached
    }

    const handleMarkdownRendered = () => {
      markdownCache.set(markdownPart.renderCache)
      handleScrollRendered()
      props.onContentRendered?.()
    }

    return (
      <div
        class={messageClass}
        ref={(element) => initializeScrollContainer(element)}
        onScroll={(event) => persistScrollSnapshot(event.currentTarget)}
      >
        <Markdown
          part={markdownPart}
          isDark={isDark()}
          disableHighlight={disableHighlight}
          onRendered={handleMarkdownRendered}
        />
      </div>
    )
  }

  const messageVersionAccessor = createMemo(() => props.messageVersion)
  const partVersionAccessor = createMemo(() => props.partVersion)

  const rendererContext: ToolRendererContext = {
    toolCall: toolCallMemo,
    toolState,
    toolName,
    messageVersion: messageVersionAccessor,
    partVersion: partVersionAccessor,
    renderMarkdown: renderMarkdownContent,
    renderDiff: renderDiffContent,
  }

  const getRendererAction = () => renderer().getAction?.(rendererContext) ?? getDefaultToolAction(toolName())

  const renderToolTitle = () => {
    const state = toolState()
    if (!state) return getRendererAction()
    if (state.status === "pending") return getRendererAction()

    if (isToolStateRunning(state) && state.title) {
      return state.title
    }

    if (isToolStateCompleted(state) && state.title) {
      return state.title
    }

    const customTitle = renderer().getTitle?.(rendererContext)
    if (customTitle) return customTitle

    return getToolName(toolName())
  }

  const renderToolBody = () => {
    return renderer().renderBody(rendererContext)
  }

  async function handlePermissionResponse(response: "once" | "always" | "reject") {
    const permission = permissionDetails()
    if (!permission || !isPermissionActive()) {
      return
    }
    setPermissionSubmitting(true)
    setPermissionError(null)
    try {
      const sessionId = permission.sessionID || props.sessionId
      await sendPermissionResponse(props.instanceId, sessionId, permission.id, response)
    } catch (error) {
      log.error("Failed to send permission response", error)
      setPermissionError(error instanceof Error ? error.message : "Unable to update permission")
    } finally {
      setPermissionSubmitting(false)
    }
  }


  const renderError = () => {
    const state = toolState() || {}
    if (state.status === "error" && state.error) {
      return (
        <div class="tool-call-error-content">
          <strong>Error:</strong> {state.error}
        </div>
      )
    }
    return null
  }


  const renderPermissionBlock = () => {
    const permission = permissionDetails()
    if (!permission) return null
    const active = isPermissionActive()
    const metadata = (permission.metadata ?? {}) as Record<string, unknown>
    const diffValue = typeof metadata.diff === "string" ? (metadata.diff as string) : null
    const diffPathRaw = (() => {
      if (typeof metadata.filePath === "string") {
        return metadata.filePath as string
      }
      if (typeof metadata.path === "string") {
        return metadata.path as string
      }
      return undefined
    })()
    const diffPayload = diffValue && diffValue.trim().length > 0 ? { diffText: diffValue, filePath: diffPathRaw } : null

    return (
      <div class={`tool-call-permission ${active ? "tool-call-permission-active" : "tool-call-permission-queued"}`}>
        <div class="tool-call-permission-header">
          <span class="tool-call-permission-label">{active ? "Permission Required" : "Permission Queued"}</span>
          <span class="tool-call-permission-type">{permission.type}</span>
        </div>
        <div class="tool-call-permission-body">
          <div class="tool-call-permission-title">
            <code>{permission.title}</code>
          </div>
          <Show when={diffPayload}>
            {(payload) => (
              <div class="tool-call-permission-diff">
                {renderDiffContent(payload(), {
                  variant: "permission-diff",
                  disableScrollTracking: true,
                  label: payload().filePath ? `Requested diff · ${getRelativePath(payload().filePath || "")}` : "Requested diff",
                })}
              </div>
            )}
          </Show>
          <Show
            when={active}
            fallback={<p class="tool-call-permission-queued-text">Waiting for earlier permission responses.</p>}
          >
            <div class="tool-call-permission-actions">
              <div class="tool-call-permission-buttons">
                <button
                  type="button"
                  class="tool-call-permission-button"
                  disabled={permissionSubmitting()}
                  onClick={() => handlePermissionResponse("once")}
                >
                  Allow Once
                </button>
                <button
                  type="button"
                  class="tool-call-permission-button"
                  disabled={permissionSubmitting()}
                  onClick={() => handlePermissionResponse("always")}
                >
                  Always Allow
                </button>
                <button
                  type="button"
                  class="tool-call-permission-button"
                  disabled={permissionSubmitting()}
                  onClick={() => handlePermissionResponse("reject")}
                >
                  Deny
                </button>
              </div>
              <div class="tool-call-permission-shortcuts">
                <kbd class="kbd">Enter</kbd>
                <span>Allow once</span>
                <kbd class="kbd">A</kbd>
                <span>Always allow</span>
                <kbd class="kbd">D</kbd>
                <span>Deny</span>
              </div>
            </div>
            <Show when={permissionError()}>
              <div class="tool-call-permission-error">{permissionError()}</div>
            </Show>
          </Show>
        </div>
      </div>
    )
  }

  const status = () => toolState()?.status || ""

  return (
    <div
      ref={(element) => {
        toolCallRootRef = element || undefined
      }}
      class={`tool-call ${combinedStatusClass()}`}
    >
      <button
        class="tool-call-header"
        onClick={toggle}
        aria-expanded={expanded()}
        data-status-icon={statusIcon()}
      >
        <span class="tool-call-summary" data-tool-icon={getToolIcon(toolName())}>
          {renderToolTitle()}
        </span>
      </button>

      {expanded() && (
        <div class="tool-call-details">
          {renderToolBody()}
 
          {renderError()}
 
          {renderPermissionBlock()}
 
          <Show when={status() === "pending" && !pendingPermission()}>
            <div class="tool-call-pending-message">
              <span class="spinner-small"></span>
              <span>Waiting for permission...</span>
            </div>
          </Show>
        </div>
      )}
 
      <Show when={diagnosticsEntries().length}>

        {renderDiagnosticsSection(
          diagnosticsEntries(),
          diagnosticsExpanded(),
          () => setDiagnosticsOverride((prev) => {
            const current = prev === undefined ? diagnosticsDefaultExpanded() : prev
            return !current
          }),
          diagnosticFileName(diagnosticsEntries()),
        )}
      </Show>
    </div>
  )
}

function getDefaultToolAction(toolName: string) {
  switch (toolName) {
    case "task":
      return "Delegating..."
    case "bash":
      return "Writing command..."
    case "edit":
      return "Preparing edit..."
    case "webfetch":
      return "Fetching from the web..."
    case "glob":
      return "Finding files..."
    case "grep":
      return "Searching content..."
    case "list":
      return "Listing directory..."
    case "read":
      return "Reading file..."
    case "write":
      return "Preparing write..."
    case "todowrite":
    case "todoread":
      return "Planning..."
    case "patch":
      return "Preparing patch..."
    default:
      return "Working..."
  }
}
