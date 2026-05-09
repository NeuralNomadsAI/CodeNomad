import { Accessor, createEffect, createSignal, onCleanup, onMount } from "solid-js"
import {
  containsFileDrop,
  extractDroppedDirectoryPaths,
  listenForNativeFolderDrops,
  listenForNativeFolderDropState,
  normalizeDroppedDirectoryPaths,
  supportsDesktopFolderDrop,
} from "../native/desktop-file-drop"
import { isTauriHost } from "../runtime-env"

interface UseFolderDropOptions {
  enabled: Accessor<boolean>
  onDrop: (paths: string[]) => void | Promise<void>
  onInvalidDrop?: () => void
}

interface FolderDropBindings {
  onDragEnter: (event: DragEvent) => void
  onDragOver: (event: DragEvent) => void
  onDragLeave: (event: DragEvent) => void
  onDrop: (event: DragEvent) => void
}

export function useFolderDrop(options: UseFolderDropOptions): {
  isActive: Accessor<boolean>
  isSupported: boolean
  bind: FolderDropBindings
} {
  const [isActive, setIsActive] = createSignal(false)
  const [dragDepth, setDragDepth] = createSignal(0)
  const isSupported = supportsDesktopFolderDrop()

  function reset() {
    setDragDepth(0)
    setIsActive(false)
  }

  async function handleResolvedPaths(paths: string[]) {
    reset()
    if (!options.enabled()) {
      return
    }
    const directoryPaths = await normalizeDroppedDirectoryPaths(paths)
    if (directoryPaths.length === 0) {
      options.onInvalidDrop?.()
      return
    }
    await options.onDrop(directoryPaths)
  }

  createEffect(() => {
    if (!options.enabled()) {
      reset()
    }
  })

  onMount(() => {
    if (!isSupported) {
      return
    }

    let disposeNativeDrop = () => {}
    let disposeNativeState = () => {}

    void listenForNativeFolderDrops((paths) => {
      if (!options.enabled()) {
        return
      }
      void handleResolvedPaths(paths)
    }).then((dispose) => {
      disposeNativeDrop = dispose
    })

    void listenForNativeFolderDropState((state) => {
      if (!options.enabled()) {
        reset()
        return
      }
      if (state === "enter") {
        setIsActive(true)
        return
      }
      reset()
    }).then((dispose) => {
      disposeNativeState = dispose
    })

    onCleanup(() => {
      disposeNativeDrop()
      disposeNativeState()
    })
  })

  const bind: FolderDropBindings = {
    onDragEnter(event) {
      if (!isSupported || isTauriHost() || !options.enabled() || !containsFileDrop(event)) {
        return
      }
      event.preventDefault()
      setDragDepth((prev) => prev + 1)
      setIsActive(true)
    },
    onDragOver(event) {
      if (!isSupported || isTauriHost() || !options.enabled() || !containsFileDrop(event)) {
        return
      }
      event.preventDefault()
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = "copy"
      }
      setIsActive(true)
    },
    onDragLeave(event) {
      if (!isSupported || isTauriHost() || !containsFileDrop(event)) {
        return
      }
      event.preventDefault()
      const nextDepth = Math.max(0, dragDepth() - 1)
      setDragDepth(nextDepth)
      if (nextDepth === 0) {
        setIsActive(false)
      }
    },
    onDrop(event) {
      if (!isSupported) {
        return
      }
      event.preventDefault()
      event.stopPropagation()

      if (!options.enabled()) {
        reset()
        return
      }

      if (isTauriHost()) {
        reset()
        return
      }

      const paths = extractDroppedDirectoryPaths(event)
      if (paths.length === 0) {
        reset()
        options.onInvalidDrop?.()
        return
      }

      void handleResolvedPaths(paths)
    },
  }

  return {
    isActive,
    isSupported,
    bind,
  }
}
