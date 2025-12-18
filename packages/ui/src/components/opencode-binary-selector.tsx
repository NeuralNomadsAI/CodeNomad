import { Component, For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { FolderOpen, Trash2, Check, AlertCircle, Loader2, Plus } from "lucide-solid"
import { useConfig } from "../stores/preferences"
import { serverApi } from "../lib/api-client"
import FileSystemBrowserDialog from "./filesystem-browser-dialog"
import { openNativeFileDialog, supportsNativeDialogs } from "../lib/native/native-functions"
import { getLogger } from "../lib/logger"
const log = getLogger("actions")


interface BinaryOption {
  path: string
  version?: string
  lastUsed?: number
  isDefault?: boolean
}

interface OpenCodeBinarySelectorProps {
  selectedBinary: string
  onBinaryChange: (binary: string) => void
  disabled?: boolean
  isVisible?: boolean
}

const OpenCodeBinarySelector: Component<OpenCodeBinarySelectorProps> = (props) => {
  const {
    opencodeBinaries,
    addOpenCodeBinary,
    removeOpenCodeBinary,
    preferences,
    updatePreferences,
  } = useConfig()
  const [customPath, setCustomPath] = createSignal("")
  const [validating, setValidating] = createSignal(false)
  const [validationError, setValidationError] = createSignal<string | null>(null)
  const [versionInfo, setVersionInfo] = createSignal<Map<string, string>>(new Map<string, string>())
  const [validatingPaths, setValidatingPaths] = createSignal<Set<string>>(new Set<string>())
  const [isBinaryBrowserOpen, setIsBinaryBrowserOpen] = createSignal(false)
  const nativeDialogsAvailable = supportsNativeDialogs()
 
  const binaries = () => opencodeBinaries()

  const lastUsedBinary = () => preferences().lastUsedBinary

  const customBinaries = createMemo(() => binaries().filter((binary) => binary.path !== "opencode"))

  const binaryOptions = createMemo<BinaryOption[]>(() => [{ path: "opencode", isDefault: true }, ...customBinaries()])

  const currentSelectionPath = () => props.selectedBinary || "opencode"

  createEffect(() => {
    if (!props.selectedBinary && lastUsedBinary()) {
      props.onBinaryChange(lastUsedBinary()!)
    } else if (!props.selectedBinary) {
      const firstBinary = binaries()[0]
      if (firstBinary) {
        props.onBinaryChange(firstBinary.path)
      }
    }
  })

  createEffect(() => {
    const cache = new Map(versionInfo())
    let updated = false

    binaries().forEach((binary) => {
      if (binary.version && !cache.has(binary.path)) {
        cache.set(binary.path, binary.version)
        updated = true
      }
    })

    if (updated) {
      setVersionInfo(cache)
    }
  })

  createEffect(() => {
    if (!props.isVisible) return
    const cache = versionInfo()
    const pathsToValidate = ["opencode", ...customBinaries().map((binary) => binary.path)].filter(
      (path) => !cache.has(path),
    )

    if (pathsToValidate.length === 0) return

    setTimeout(() => {
      pathsToValidate.forEach((path) => {
        validateBinary(path).catch((error) => log.error("Failed to validate binary", { path, error }))
      })
    }, 0)
  })

  onCleanup(() => {
    setValidatingPaths(new Set<string>())
    setValidating(false)
  })

  async function validateBinary(path: string): Promise<{ valid: boolean; version?: string; error?: string }> {
    if (versionInfo().has(path)) {
      const cachedVersion = versionInfo().get(path)
      return cachedVersion ? { valid: true, version: cachedVersion } : { valid: true }
    }

    if (validatingPaths().has(path)) {
      return { valid: false, error: "Already validating" }
    }

    try {
      setValidatingPaths((prev) => new Set(prev).add(path))
      setValidating(true)
      setValidationError(null)

      const result = await serverApi.validateBinary(path)

      if (result.valid && result.version) {
        const updatedVersionInfo = new Map(versionInfo())
        updatedVersionInfo.set(path, result.version)
        setVersionInfo(updatedVersionInfo)
      }

      return result
    } catch (error) {
      return { valid: false, error: error instanceof Error ? error.message : String(error) }
    } finally {
      setValidatingPaths((prev) => {
        const next = new Set(prev)
        next.delete(path)
        if (next.size === 0) {
          setValidating(false)
        }
        return next
      })
    }
  }

  async function handleBrowseBinary() {
    if (props.disabled) return
    setValidationError(null)
    if (nativeDialogsAvailable) {
      const selected = await openNativeFileDialog({
        title: "Select OpenCode Binary",
      })
      if (selected) {
        setCustomPath(selected)
        void handleValidateAndAdd(selected)
      }
      return
    }
    setIsBinaryBrowserOpen(true)
  }
 
  async function handleValidateAndAdd(path: string) {
    const validation = await validateBinary(path)

    if (validation.valid) {
      addOpenCodeBinary(path, validation.version)
      props.onBinaryChange(path)
      updatePreferences({ lastUsedBinary: path })
      setCustomPath("")
      setValidationError(null)
    } else {
      setValidationError(validation.error || "Invalid OpenCode binary")
    }
  }
 
  function handleBinaryBrowserSelect(path: string) {
    setIsBinaryBrowserOpen(false)
    setCustomPath(path)
    void handleValidateAndAdd(path)
  }
 
  async function handleCustomPathSubmit() {

    const path = customPath().trim()
    if (!path) return
    await handleValidateAndAdd(path)
  }

  function handleSelectBinary(path: string) {
    if (props.disabled) return
    if (path === props.selectedBinary) return
    props.onBinaryChange(path)
    updatePreferences({ lastUsedBinary: path })
  }

  function handleRemoveBinary(path: string, event: Event) {
    event.stopPropagation()
    if (props.disabled) return
    removeOpenCodeBinary(path)

    if (props.selectedBinary === path) {
      props.onBinaryChange("opencode")
      updatePreferences({ lastUsedBinary: "opencode" })
    }
  }

  function formatRelativeTime(timestamp?: number): string {
    if (!timestamp) return ""
    const seconds = Math.floor((Date.now() - timestamp) / 1000)
    const minutes = Math.floor(seconds / 60)
    const hours = Math.floor(minutes / 60)
    const days = Math.floor(hours / 24)

    if (days > 0) return `${days}d ago`
    if (hours > 0) return `${hours}h ago`
    if (minutes > 0) return `${minutes}m ago`
    return "just now"
  }

  function getDisplayName(path: string): string {
    if (path === "opencode") return "opencode (system PATH)"
    const parts = path.split(/[/\\]/)
    return parts[parts.length - 1] ?? path
  }

  const isPathValidating = (path: string) => validatingPaths().has(path)

  return (
    <>
      <div class="panel">
        <div class="panel-header flex items-center justify-between" style={{ gap: "var(--space-md)" }}>
          <div>
            <h3 class="panel-title">OpenCode Binary</h3>
            <p class="panel-subtitle">Choose which executable OpenCode should run</p>
          </div>
          <Show when={validating()}>
            <div class="flex items-center text-xs text-muted" style={{ gap: "var(--space-sm)" }}>
              <Loader2 class="w-4 h-4 animate-spin text-accent" />
              <span>Checking versions…</span>
            </div>
          </Show>
        </div>

        <div class="panel-body" style={{ gap: "var(--space-md)" }}>
          <div class="flex items-center" style={{ gap: "var(--space-sm)" }}>
            <input
              type="text"
              value={customPath()}
              onInput={(e) => setCustomPath(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault()
                  handleCustomPathSubmit()
                }
              }}
              disabled={props.disabled}
              placeholder="Enter path to opencode binary…"
              class="modal-input flex-1"
            />
            <button
              type="button"
              onClick={handleCustomPathSubmit}
              disabled={props.disabled || !customPath().trim()}
              class="modal-button modal-button--primary"
            >
              <Plus class="w-4 h-4" />
              Add
            </button>
          </div>

          <button
            type="button"
            onClick={() => void handleBrowseBinary()}
            disabled={props.disabled}
            class="modal-button modal-button--secondary w-full"
          >
            <FolderOpen class="w-4 h-4" />
            Browse for Binary…
          </button>

          <Show when={validationError()}>
            <div class="px-3 py-2 rounded-md bg-danger-soft-bg border border-base">
              <div class="flex items-center" style={{ gap: "var(--space-sm)" }}>
                <AlertCircle class="w-4 h-4 text-status-error flex-shrink-0" />
                <span class="text-sm text-status-error">{validationError()}</span>
              </div>
            </div>
          </Show>
        </div>

        <div class="panel-list panel-list--fill max-h-80 overflow-y-auto">
          <For each={binaryOptions()}>
            {(binary) => {
              const isDefault = binary.isDefault
              const versionLabel = () => versionInfo().get(binary.path) ?? binary.version

              return (
                <div
                  class="panel-list-item flex items-center"
                  classList={{ "panel-list-item-highlight": currentSelectionPath() === binary.path }}
                >
                  <button
                    type="button"
                    class="panel-list-item-content flex-1"
                    onClick={() => handleSelectBinary(binary.path)}
                    disabled={props.disabled}
                  >
                    <div class="flex flex-col flex-1 min-w-0 gap-1.5">
                      <div class="flex items-center gap-2">
                        <Check
                          class={`w-4 h-4 transition-opacity ${currentSelectionPath() === binary.path ? "opacity-100" : "opacity-0"}`}
                        />
                        <span class="text-sm font-medium truncate text-primary">{getDisplayName(binary.path)}</span>
                      </div>
                      <Show when={!isDefault}>
                        <div class="text-xs font-mono truncate pl-6 text-muted">{binary.path}</div>
                      </Show>
                      <div class="flex items-center gap-2 text-xs text-muted pl-6 flex-wrap">
                        <Show when={versionLabel()}>
                          <span class="selector-badge-version">v{versionLabel()}</span>
                        </Show>
                        <Show when={isPathValidating(binary.path)}>
                          <span class="selector-badge-time">Checking…</span>
                        </Show>
                        <Show when={!isDefault && binary.lastUsed}>
                          <span class="selector-badge-time">{formatRelativeTime(binary.lastUsed)}</span>
                        </Show>
                        <Show when={isDefault}>
                          <span class="selector-badge-time">Use binary from system PATH</span>
                        </Show>
                      </div>
                    </div>
                  </button>
                  <Show when={!isDefault}>
                    <button
                      type="button"
                      class="p-2 text-muted hover:text-primary"
                      onClick={(event) => handleRemoveBinary(binary.path, event)}
                      disabled={props.disabled}
                      title="Remove binary"
                    >
                      <Trash2 class="w-3.5 h-3.5" />
                    </button>
                  </Show>
                </div>
              )
            }}
          </For>
        </div>
      </div>

      <FileSystemBrowserDialog
        open={isBinaryBrowserOpen()}
        mode="files"
        title="Select OpenCode Binary"
        description="Browse files exposed by the CLI server."
        onClose={() => setIsBinaryBrowserOpen(false)}
        onSelect={handleBinaryBrowserSelect}
      />
    </>
  )
}
 
export default OpenCodeBinarySelector

