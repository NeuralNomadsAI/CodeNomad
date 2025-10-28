import { Component, createSignal, Show, For, onMount, createEffect, onCleanup } from "solid-js"
import { ChevronDown, ChevronUp, FolderOpen, Trash2, Check, AlertCircle, Loader2 } from "lucide-solid"
import {
  opencodeBinaries,
  addOpenCodeBinary,
  removeOpenCodeBinary,
  preferences,
  updateLastUsedBinary,
} from "../stores/preferences"

interface OpenCodeBinarySelectorProps {
  selectedBinary: string
  onBinaryChange: (binary: string) => void
  disabled?: boolean
}

const OpenCodeBinarySelector: Component<OpenCodeBinarySelectorProps> = (props) => {
  const [isOpen, setIsOpen] = createSignal(false)
  const [customPath, setCustomPath] = createSignal("")
  const [validating, setValidating] = createSignal(false)
  const [validationError, setValidationError] = createSignal<string | null>(null)
  const [versionInfo, setVersionInfo] = createSignal<Map<string, string>>(new Map())
  const [validatingPaths, setValidatingPaths] = createSignal<Set<string>>(new Set())
  let buttonRef: HTMLButtonElement | undefined

  const binaries = () => opencodeBinaries()
  const lastUsedBinary = () => preferences().lastUsedBinary

  // Set initial selected binary
  createEffect(() => {
    console.log(
      `[BinarySelector] Component effect - selectedBinary: ${props.selectedBinary}, lastUsed: ${lastUsedBinary()}, binaries count: ${binaries().length}`,
    )
    if (!props.selectedBinary && lastUsedBinary()) {
      props.onBinaryChange(lastUsedBinary()!)
    } else if (!props.selectedBinary && binaries().length > 0) {
      props.onBinaryChange(binaries()[0].path)
    }
  })

  // Validate all binaries when selector opens (only once)
  createEffect(() => {
    if (isOpen()) {
      const pathsToValidate = ["opencode", ...binaries().map((b) => b.path)]

      // Use setTimeout to break the reactive cycle and validate once
      setTimeout(() => {
        pathsToValidate.forEach((path) => {
          validateBinary(path).catch(console.error)
        })
      }, 0)
    }
  })

  // Click outside handler
  onMount(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (buttonRef && !buttonRef.contains(event.target as Node)) {
        const dropdown = document.querySelector("[data-binary-dropdown]")
        if (dropdown && !dropdown.contains(event.target as Node)) {
          setIsOpen(false)
        }
      }
    }

    document.addEventListener("click", handleClickOutside)
    onCleanup(() => {
      document.removeEventListener("click", handleClickOutside)
      // Clean up validating state on unmount
      setValidatingPaths(new Set<string>())
      setValidating(false)
    })
  })

  async function validateBinary(path: string): Promise<{ valid: boolean; version?: string; error?: string }> {
    // Prevent duplicate validation calls
    if (validatingPaths().has(path)) {
      console.log(`[BinarySelector] Already validating ${path}, skipping...`)
      return { valid: false, error: "Already validating" }
    }

    try {
      // Add to validating set
      setValidatingPaths((prev) => new Set(prev).add(path))
      setValidating(true)
      setValidationError(null)

      console.log(`[BinarySelector] Starting validation for: ${path}`)

      const result = await window.electronAPI.validateOpenCodeBinary(path)
      console.log(`[BinarySelector] Validation result:`, result)

      if (result.valid && result.version) {
        const updatedVersionInfo = new Map(versionInfo())
        updatedVersionInfo.set(path, result.version)
        setVersionInfo(updatedVersionInfo)
        console.log(`[BinarySelector] Updated version info for ${path}: ${result.version}`)
      } else {
        console.log(`[BinarySelector] No valid version returned for ${path}`)
      }

      return result
    } catch (error) {
      console.error(`[BinarySelector] Validation error for ${path}:`, error)
      return { valid: false, error: error instanceof Error ? error.message : String(error) }
    } finally {
      // Remove from validating set
      setValidatingPaths((prev) => {
        const newSet = new Set(prev)
        newSet.delete(path)
        return newSet
      })

      // Only set validating to false if no other paths are being validated
      if (validatingPaths().size <= 1) {
        setValidating(false)
      }
    }
  }

  async function handleBrowseBinary() {
    try {
      const path = await window.electronAPI.selectOpenCodeBinary()
      if (path) {
        setCustomPath(path)
        const validation = await validateBinary(path)

        if (validation.valid) {
          addOpenCodeBinary(path, validation.version)
          props.onBinaryChange(path)
          updateLastUsedBinary(path)
          setCustomPath("")
        } else {
          setValidationError(validation.error || "Invalid OpenCode binary")
        }
      }
    } catch (error) {
      setValidationError(error instanceof Error ? error.message : "Failed to select binary")
    }
  }

  async function handleCustomPathSubmit() {
    const path = customPath().trim()
    if (!path) return

    const validation = await validateBinary(path)

    if (validation.valid) {
      addOpenCodeBinary(path, validation.version)
      props.onBinaryChange(path)
      updateLastUsedBinary(path)
      setCustomPath("")
      setValidationError(null)
    } else {
      setValidationError(validation.error || "Invalid OpenCode binary")
    }
  }

  function handleSelectBinary(path: string) {
    props.onBinaryChange(path)
    updateLastUsedBinary(path)
    setIsOpen(false)
  }

  function handleRemoveBinary(path: string, e: Event) {
    e.stopPropagation()
    removeOpenCodeBinary(path)

    if (props.selectedBinary === path) {
      const remaining = binaries().filter((b) => b.path !== path)
      if (remaining.length > 0) {
        handleSelectBinary(remaining[0].path)
      } else {
        props.onBinaryChange("opencode") // Default to system PATH
      }
    }
  }

  function formatRelativeTime(timestamp: number): string {
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

    // Extract just the binary name from path
    const parts = path.split(/[/\\]/)
    const name = parts[parts.length - 1]

    // If it's the same as default, show full path
    if (name === "opencode") {
      return path
    }

    return name
  }

  function handleButtonClick() {
    setIsOpen(!isOpen())
  }

  return (
    <div class="relative" style={{ position: "relative" }}>
      {/* Main selector button */}
      <button
        type="button"
        onClick={handleButtonClick}
        disabled={props.disabled}
        classList={{
          "selector-trigger": true,
          "w-full": true,
          "px-3": true,
          "py-2": true,
          "text-sm": true,
          "shadow-sm": true,
          "selector-trigger-disabled": props.disabled
        }}
        ref={buttonRef}
      >
        <div class="flex items-center gap-2 flex-1 min-w-0">
          <Show when={validating()} fallback={<FolderOpen class="w-4 h-4 selector-trigger-icon" />}>
            <Loader2 class="w-4 h-4 selector-loading-spinner" />
          </Show>
          <span class="truncate">
            {getDisplayName(props.selectedBinary || "opencode")}
          </span>
          <Show when={versionInfo().get(props.selectedBinary)}>
            <span class="selector-badge-version">v{versionInfo().get(props.selectedBinary)}</span>
          </Show>
        </div>
        <ChevronDown
          class={`w-4 h-4 selector-trigger-icon transition-transform ${isOpen() ? "rotate-180" : ""}`}
        />
      </button>

      {/* Dropdown */}
      <Show when={isOpen()}>
        <div
          data-binary-dropdown
          class="selector-popover absolute top-full left-0 right-0 mt-1 max-h-96 overflow-y-auto"
          style={{
            position: "absolute",
            "z-index": 500,
            "max-height": "24rem",
          }}
        >
          <div class="selector-section">
            <div class="selector-section-title mb-2">OpenCode Binary Selection</div>

            {/* Custom path input */}
            <div class="space-y-2">
              <div class="selector-input-group">
                <input
                  type="text"
                  value={customPath()}
                  onInput={(e) => setCustomPath(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      handleCustomPathSubmit()
                    } else if (e.key === "Escape") {
                      setCustomPath("")
                      setValidationError(null)
                    }
                  }}
                  placeholder="Enter path to opencode binary..."
                  class="selector-input"
                />
                <button
                  onClick={handleCustomPathSubmit}
                  disabled={!customPath().trim() || validating()}
                  class="selector-button selector-button-primary"
                >
                  Add
                </button>
              </div>

              {/* Browse button */}
              <button
                onClick={handleBrowseBinary}
                disabled={validating()}
                class="selector-button selector-button-secondary w-full flex items-center justify-center gap-2"
              >
                <FolderOpen class="w-4 h-4" />
                Browse for Binary...
              </button>
            </div>

            {/* Validation error */}
            <Show when={validationError()}>
              <div class="selector-validation-error mt-2">
                <div class="selector-validation-error-content">
                  <AlertCircle class="selector-validation-error-icon" />
                  <span class="selector-validation-error-text">{validationError()}</span>
                </div>
              </div>
            </Show>
          </div>

          {/* Recent binaries list */}
          <div class="max-h-60 overflow-y-auto">
            <Show
              when={binaries().length > 0}
              fallback={
                <div class="selector-empty-state">
                  No recent binaries. Add one above or use system PATH.
                </div>
              }
            >
              <For each={binaries()}>
                {(binary) => {
                  const isSelected = () => props.selectedBinary === binary.path
                  const version = () => {
                    const ver = versionInfo().get(binary.path)
                    console.log(`[BinarySelector] Rendering version for ${binary.path}: ${ver || "undefined"}`)
                    return ver
                  }

                  return (
                    <div
                      class={`selector-option border-b last:border-b-0 ${
                        isSelected() ? "selector-option-selected" : ""
                      }`}
                      onClick={() => handleSelectBinary(binary.path)}
                    >
                      <div class="flex items-center justify-between">
                        <div class="flex items-center gap-2 flex-1 min-w-0">
                          <Show
                            when={isSelected()}
                            fallback={<FolderOpen class="w-4 h-4 selector-trigger-icon" />}
                          >
                            <Check class="w-4 h-4 selector-option-indicator" />
                          </Show>
                          <div class="flex-1 min-w-0">
                            <div class="selector-option-label truncate">
                              {getDisplayName(binary.path)}
                            </div>
                            <div class="flex items-center gap-2 mt-0.5">
                              <Show when={version()}>
                                <span class="selector-badge-version">v{version()}</span>
                              </Show>
                              <span class="selector-badge-time">
                                {formatRelativeTime(binary.lastUsed)}
                              </span>
                            </div>
                          </div>
                        </div>
                        <button
                          onClick={(e) => handleRemoveBinary(binary.path, e)}
                          class="opacity-0 group-hover:opacity-100 p-1 hover:bg-red-100 dark:hover:bg-red-900/30 rounded transition-all"
                          title="Remove binary"
                        >
                          <Trash2 class="w-3.5 h-3.5 text-gray-400 dark:text-gray-500 hover:text-red-600 dark:hover:text-red-400" />
                        </button>
                      </div>
                    </div>
                  )
                }}
              </For>
            </Show>
          </div>

          {/* Default option */}
          <div class="selector-section">
            <div
              class={`selector-option ${
                props.selectedBinary === "opencode" ? "selector-option-selected" : ""
              }`}
              onClick={() => handleSelectBinary("opencode")}
            >
              <div class="flex items-center gap-2">
                <Show
                  when={props.selectedBinary === "opencode"}
                  fallback={<FolderOpen class="w-4 h-4 selector-trigger-icon" />}
                >
                  <Check class="w-4 h-4 selector-option-indicator" />
                </Show>
                <div class="flex-1 min-w-0">
                  <div class="selector-option-label">opencode (system PATH)</div>
                  <div class="flex items-center gap-2 mt-0.5">
                    <Show when={versionInfo().get("opencode")}>
                      <span class="selector-badge-version">v{versionInfo().get("opencode")}</span>
                    </Show>
                    <Show when={!versionInfo().get("opencode") && validating()}>
                      <span class="selector-badge-time">Checking...</span>
                    </Show>
                    <span class="selector-badge-time">Use binary from system PATH</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </Show>

      {/* Click outside to close */}
      <Show when={isOpen()}>
        <div class="fixed inset-0 z-40" onClick={() => setIsOpen(false)} />
      </Show>
    </div>
  )
}

export default OpenCodeBinarySelector
