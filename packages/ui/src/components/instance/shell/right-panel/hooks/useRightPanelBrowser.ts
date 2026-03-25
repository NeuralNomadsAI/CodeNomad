import { createSignal, createEffect, createMemo, type Accessor } from "solid-js"
import type { FileContent, FileNode } from "@opencode-ai/sdk/v2/client"
import { requestData } from "../../../../../lib/opencode-api"
import type { RightPanelTab } from "../types"

type BrowserFileContent = FileContent & {
  encoding?: string
  content?: string
}

export function useRightPanelBrowser({
  browserClient,
  rightPanelTab,
  isPhoneLayout,
  setFilesListOpen,
}: {
  browserClient: Accessor<any>
  rightPanelTab: Accessor<RightPanelTab>
  isPhoneLayout: Accessor<boolean>
  setFilesListOpen: (open: boolean) => void
}) {
  const [browserPath, setBrowserPath] = createSignal(".")
  const [browserEntries, setBrowserEntries] = createSignal<FileNode[] | null>(null)
  const [browserLoading, setBrowserLoading] = createSignal(false)
  const [browserError, setBrowserError] = createSignal<string | null>(null)
  const [browserSelectedPath, setBrowserSelectedPath] = createSignal<string | null>(null)
  const [browserSelectedContent, setBrowserSelectedContent] = createSignal<string | null>(null)
  const [browserSelectedLoading, setBrowserSelectedLoading] = createSignal(false)
  const [browserSelectedError, setBrowserSelectedError] = createSignal<string | null>(null)

  const normalizeBrowserPath = (input: string) => {
    const raw = String(input || ".").trim()
    if (!raw || raw === "./") return "."
    const cleaned = raw.replace(/\\/g, "/").replace(/\/+$/, "")
    return cleaned === "" ? "." : cleaned
  }

  const getParentPath = (path: string): string | null => {
    const current = normalizeBrowserPath(path)
    if (current === ".") return null
    const parts = current.split("/").filter(Boolean)
    parts.pop()
    return parts.length ? parts.join("/") : "."
  }

  const browserParentPath = createMemo(() => getParentPath(browserPath()))

  const loadBrowserEntries = async (path: string) => {
    const normalized = normalizeBrowserPath(path)
    setBrowserLoading(true)
    setBrowserError(null)
    try {
      const nodes = await requestData<FileNode[]>(browserClient().file.list({ path: normalized }), "file.list")
      setBrowserPath(normalized)
      setBrowserEntries(Array.isArray(nodes) ? nodes : [])
    } catch (error) {
      setBrowserError(error instanceof Error ? error.message : "Failed to load files")
      setBrowserEntries([])
    } finally {
      setBrowserLoading(false)
    }
  }

  const openBrowserFile = async (path: string) => {
    setBrowserSelectedPath(path)
    setBrowserSelectedLoading(true)
    setBrowserSelectedError(null)
    setBrowserSelectedContent(null)

    if (isPhoneLayout()) {
      setFilesListOpen(false)
    }
    try {
      const content = await requestData<BrowserFileContent>(browserClient().file.read({ path }), "file.read")
      if (content?.type && content.type !== "text") {
        throw new Error("Binary file cannot be displayed")
      }
      if (content?.encoding === "base64") {
        throw new Error("Binary file cannot be displayed")
      }
      if (typeof content?.content !== "string") {
        throw new Error("Unsupported file type")
      }
      setBrowserSelectedContent(content.content)
    } catch (error) {
      setBrowserSelectedError(error instanceof Error ? error.message : "Failed to read file")
    } finally {
      setBrowserSelectedLoading(false)
    }
  }

  const refreshFilesTab = async () => {
    void loadBrowserEntries(browserPath())
    const selected = browserSelectedPath()
    if (selected) {
      setBrowserSelectedLoading(true)
      setBrowserSelectedError(null)
      try {
        const content = await requestData<BrowserFileContent>(browserClient().file.read({ path: selected }), "file.read")
        if (content?.type && content.type !== "text") {
          throw new Error("Binary file cannot be displayed")
        }
        if (content?.encoding === "base64") {
          throw new Error("Binary file cannot be displayed")
        }
        if (typeof content?.content !== "string") {
          throw new Error("Unsupported file type")
        }
        setBrowserSelectedContent(content.content)
      } catch (error) {
        setBrowserSelectedError(error instanceof Error ? error.message : "Failed to read file")
      } finally {
        setBrowserSelectedLoading(false)
      }
    }
  }

  createEffect(() => {
    if (rightPanelTab() !== "files") return
    if (browserLoading()) return
    if (browserEntries() !== null) return
    void loadBrowserEntries(browserPath())
  })

  createEffect(() => {
    if (rightPanelTab() === "files") return
    setBrowserSelectedContent(null)
    setBrowserSelectedLoading(false)
    setBrowserSelectedError(null)
  })

  return {
    browserPath,
    setBrowserPath,
    browserEntries,
    setBrowserEntries,
    browserLoading,
    setBrowserLoading,
    browserError,
    setBrowserError,
    browserSelectedPath,
    setBrowserSelectedPath,
    browserSelectedContent,
    setBrowserSelectedContent,
    browserSelectedLoading,
    setBrowserSelectedLoading,
    browserSelectedError,
    setBrowserSelectedError,
    browserParentPath,
    loadBrowserEntries,
    openBrowserFile,
    refreshFilesTab,
  }
}
