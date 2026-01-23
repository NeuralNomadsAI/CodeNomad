import { createSignal, createMemo } from "solid-js"
import { getLogger } from "../lib/logger"
import { ERA_CODE_API_BASE } from "../lib/api-client"
import {
  parseDirectivesMarkdown,
  directivesToMarkdown,
  addDirective as addDirectiveToSections,
  removeDirective as removeDirectiveFromSections,
  updateDirective as updateDirectiveInSections,
  type DirectiveSection,
} from "../lib/directive-parser"

const log = getLogger("era-directives")

function apiUrl(path: string): string {
  return ERA_CODE_API_BASE ? `${ERA_CODE_API_BASE}${path}` : path
}

/**
 * Directives file content and metadata
 */
export interface DirectivesFile {
  content: string
  path: string
  exists: boolean
  hash: string // Content hash for conflict detection
}

/**
 * Conflict information returned when a concurrent modification is detected
 */
export interface ConflictInfo {
  currentHash: string
  lastModifiedBy: string | null
  lastModifiedAt: number | null
}

/**
 * Result of a save operation
 */
export interface SaveResult {
  success: boolean
  error?: string
  hash?: string
  conflictInfo?: ConflictInfo
}

/**
 * Directives state
 */
interface DirectivesState {
  loading: boolean
  error: string | null
  global: DirectivesFile | null
  constitution: DirectivesFile | null
  lastFetched: number | null
  // Per-folder project directives cache
  projectByFolder: Map<string, DirectivesFile>
  // Currently selected folder for project directives
  currentProjectFolder: string | null
}

const initialState: DirectivesState = {
  loading: false,
  error: null,
  global: null,
  constitution: null,
  lastFetched: null,
  projectByFolder: new Map(),
  currentProjectFolder: null,
}

const [directivesState, setDirectivesState] = createSignal<DirectivesState>(initialState)

// Debounce/dedup tracking to prevent ERR_INSUFFICIENT_RESOURCES
let pendingFetch: { folder: string | undefined; promise: Promise<void> } | null = null
let lastFetchTime = 0
const FETCH_DEBOUNCE_MS = 500 // Don't re-fetch same folder within this window

/**
 * Fetch directives from the server
 * Caches project directives per-folder to avoid data loss when switching projects
 * Includes debouncing to prevent ERR_INSUFFICIENT_RESOURCES from duplicate calls
 */
export async function fetchDirectives(folder?: string): Promise<void> {
  const now = Date.now()

  // If there's already a pending fetch for the same folder, return that promise
  if (pendingFetch && pendingFetch.folder === folder) {
    return pendingFetch.promise
  }

  // Debounce: if we just fetched this folder recently, skip
  const state = directivesState()
  if (
    state.currentProjectFolder === folder &&
    state.lastFetched &&
    now - state.lastFetched < FETCH_DEBOUNCE_MS
  ) {
    log.info("Skipping duplicate fetch (debounce)", { folder, timeSinceLastFetch: now - state.lastFetched })
    return
  }

  // Check if we have cached data for this folder
  const cachedProject = folder ? state.projectByFolder.get(folder) ?? null : null

  // Set loading state, but preserve cached project data if available
  setDirectivesState((prev) => ({
    ...prev,
    loading: true,
    error: null,
    currentProjectFolder: folder || null,
  }))

  // Create the fetch promise and track it
  const fetchPromise = doFetchDirectives(folder, cachedProject)
  pendingFetch = { folder, promise: fetchPromise }

  try {
    await fetchPromise
  } finally {
    // Clear pending fetch when done
    if (pendingFetch?.folder === folder) {
      pendingFetch = null
    }
  }
}

/**
 * Internal function that actually performs the fetch
 */
async function doFetchDirectives(folder: string | undefined, cachedProject: DirectivesFile | null): Promise<void> {

  try {
    const params = folder ? `?folder=${encodeURIComponent(folder)}` : ""

    // Fetch project, global, and constitution in parallel
    const [projectRes, globalRes, constitutionRes] = await Promise.all([
      folder ? fetch(apiUrl(`/api/era/directives${params}&type=project`)) : Promise.resolve(null),
      fetch(apiUrl("/api/era/directives?type=global")),
      folder ? fetch(apiUrl(`/api/era/constitution${params}`)) : Promise.resolve(null),
    ])

    let project: DirectivesFile | null = cachedProject ?? null // Start with cached value
    let global: DirectivesFile | null = null
    let constitution: DirectivesFile | null = null

    if (projectRes?.ok) {
      const data = await projectRes.json()
      if (data.success) {
        project = {
          content: data.content,
          path: data.path,
          exists: data.exists,
          hash: data.hash || "",
        }
      }
    }

    if (globalRes.ok) {
      const data = await globalRes.json()
      if (data.success) {
        global = {
          content: data.content,
          path: data.path,
          exists: data.exists,
          hash: data.hash || "",
        }
      }
    }

    if (constitutionRes?.ok) {
      const data = await constitutionRes.json()
      if (data.success) {
        constitution = {
          content: data.content,
          path: data.path,
          exists: data.exists,
          hash: data.hash || "",
        }
      }
    }

    // Update the cache with the new project data
    setDirectivesState((prev) => {
      const newProjectByFolder = new Map(prev.projectByFolder)
      if (folder && project) {
        newProjectByFolder.set(folder, project)
      }

      return {
        loading: false,
        error: null,
        global,
        constitution,
        lastFetched: Date.now(),
        projectByFolder: newProjectByFolder,
        currentProjectFolder: folder || null,
      }
    })

    log.info("Directives fetched", {
      folder,
      hasProject: project?.exists,
      hasGlobal: global?.exists,
      hasConstitution: constitution?.exists,
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error"
    log.warn("Failed to fetch directives", { error: errorMessage, folder })

    setDirectivesState((prev) => ({
      ...prev,
      loading: false,
      error: errorMessage,
    }))
  }
}

/**
 * Generate a unique session ID for this browser tab
 */
const sessionId = `ui-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`

/**
 * Save directives content with optimistic locking
 * @param folder - The project folder (empty for global)
 * @param type - "project" or "global"
 * @param content - The new content to save
 * @param expectedHash - Optional hash from last read for conflict detection
 */
export async function saveDirectives(
  folder: string,
  type: "project" | "global",
  content: string,
  expectedHash?: string
): Promise<SaveResult> {
  // Get the current hash if not provided
  const currentFile = type === "project"
    ? (folder ? directivesState().projectByFolder.get(folder) : null)
    : directivesState().global

  const hashToUse = expectedHash ?? currentFile?.hash

  try {
    const response = await fetch(apiUrl("/api/era/directives"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        folder,
        type,
        content,
        sessionId,
        expectedHash: hashToUse,
      }),
    })

    const data = await response.json()

    // Handle conflict (409 status)
    if (response.status === 409 && data.conflictInfo) {
      log.warn("Save conflict detected", {
        type,
        folder,
        expectedHash: hashToUse,
        currentHash: data.conflictInfo.currentHash,
      })
      return {
        success: false,
        error: data.error || "File was modified by another session",
        conflictInfo: data.conflictInfo,
      }
    }

    if (data.success) {
      // Update local state with new hash
      setDirectivesState((prev) => {
        if (type === "project" && folder) {
          // Update the per-folder cache for project directives
          const newProjectByFolder = new Map(prev.projectByFolder)
          newProjectByFolder.set(folder, {
            content,
            path: data.path,
            exists: true,
            hash: data.hash || "",
          })
          return {
            ...prev,
            projectByFolder: newProjectByFolder,
          }
        } else {
          // Global directives
          return {
            ...prev,
            global: {
              content,
              path: data.path,
              exists: true,
              hash: data.hash || "",
            },
          }
        }
      })
      log.info("Directives saved", { type, folder, path: data.path, hash: data.hash })
    }

    return {
      success: data.success,
      error: data.error,
      hash: data.hash,
    }
  } catch (error) {
    log.warn("Failed to save directives", { error })
    return { success: false, error: "Failed to save directives" }
  }
}

/**
 * Refresh directives for a folder
 */
export function refreshDirectives(folder?: string): void {
  void fetchDirectives(folder)
}

/**
 * Get the current directives state
 */
export function useDirectivesState() {
  return directivesState
}

/**
 * Derived: Project directives for the currently selected folder
 */
export const projectDirectives = createMemo(() => {
  const state = directivesState()
  if (!state.currentProjectFolder) return null
  return state.projectByFolder.get(state.currentProjectFolder) ?? null
})

/**
 * Get project directives for a specific folder (from cache)
 */
export function getProjectDirectivesForFolder(folder: string): DirectivesFile | null {
  return directivesState().projectByFolder.get(folder) ?? null
}

/**
 * Derived: Global directives
 */
export const globalDirectives = createMemo(() => directivesState().global)

/**
 * Derived: Constitution
 */
export const constitution = createMemo(() => directivesState().constitution)

/**
 * Derived: Is loading
 */
export const isDirectivesLoading = createMemo(() => directivesState().loading)

/**
 * Derived: Error message
 */
export const directivesError = createMemo(() => directivesState().error)

/**
 * Derived: Has project directives configured (for current folder)
 */
export const hasProjectDirectives = createMemo(() => {
  const project = projectDirectives()
  return project?.exists && project.content.trim().length > 0
})

/**
 * Derived: Project directives preview (first ~200 chars)
 */
export const projectDirectivesPreview = createMemo(() => {
  const project = projectDirectives()
  if (!project?.exists || !project.content) return null
  const content = project.content.trim()
  if (content.length <= 200) return content
  return content.slice(0, 200) + "..."
})

// ============================================
// Parsed Directive Memos
// ============================================

/**
 * Derived: Parsed global directives as sections
 */
export const parsedGlobalDirectives = createMemo((): DirectiveSection[] => {
  const global = directivesState().global
  if (!global?.content) return []
  return parseDirectivesMarkdown(global.content)
})

/**
 * Derived: Parsed project directives as sections (for current folder)
 */
export const parsedProjectDirectives = createMemo((): DirectiveSection[] => {
  const project = projectDirectives()
  if (!project?.content) return []
  return parseDirectivesMarkdown(project.content)
})

/**
 * Derived: Parsed constitution as sections
 */
export const parsedConstitution = createMemo((): DirectiveSection[] => {
  const constitution = directivesState().constitution
  if (!constitution?.content) return []
  return parseDirectivesMarkdown(constitution.content)
})

// ============================================
// Mutation Functions
// ============================================

/**
 * Add a directive to global directives
 */
export async function addDirectiveToGlobal(
  text: string,
  section?: string
): Promise<{ success: boolean; error?: string }> {
  const currentSections = parsedGlobalDirectives()
  const newSections = addDirectiveToSections(currentSections, text, section)
  const newContent = directivesToMarkdown(newSections)
  return saveDirectives("", "global", newContent)
}

/**
 * Add a directive to project directives
 */
export async function addDirectiveToProject(
  folder: string,
  text: string,
  section?: string
): Promise<{ success: boolean; error?: string }> {
  if (!folder) {
    return { success: false, error: "No folder specified" }
  }
  const currentSections = parsedProjectDirectives()
  const newSections = addDirectiveToSections(currentSections, text, section)
  const newContent = directivesToMarkdown(newSections)
  return saveDirectives(folder, "project", newContent)
}

/**
 * Update a directive in global directives
 */
export async function updateDirectiveInGlobal(
  id: string,
  newText: string
): Promise<{ success: boolean; error?: string }> {
  const currentSections = parsedGlobalDirectives()
  const newSections = updateDirectiveInSections(currentSections, id, newText)
  const newContent = directivesToMarkdown(newSections)
  return saveDirectives("", "global", newContent)
}

/**
 * Update a directive in project directives
 */
export async function updateDirectiveInProject(
  folder: string,
  id: string,
  newText: string
): Promise<{ success: boolean; error?: string }> {
  if (!folder) {
    return { success: false, error: "No folder specified" }
  }
  const currentSections = parsedProjectDirectives()
  const newSections = updateDirectiveInSections(currentSections, id, newText)
  const newContent = directivesToMarkdown(newSections)
  return saveDirectives(folder, "project", newContent)
}

/**
 * Delete a directive from global directives
 */
export async function deleteDirectiveFromGlobal(
  id: string
): Promise<{ success: boolean; error?: string }> {
  const currentSections = parsedGlobalDirectives()
  const newSections = removeDirectiveFromSections(currentSections, id)
  const newContent = directivesToMarkdown(newSections)
  return saveDirectives("", "global", newContent)
}

/**
 * Delete a directive from project directives
 */
export async function deleteDirectiveFromProject(
  folder: string,
  id: string
): Promise<{ success: boolean; error?: string }> {
  if (!folder) {
    return { success: false, error: "No folder specified" }
  }
  const currentSections = parsedProjectDirectives()
  const newSections = removeDirectiveFromSections(currentSections, id)
  const newContent = directivesToMarkdown(newSections)
  return saveDirectives(folder, "project", newContent)
}

// ============================================
// Hash Management
// ============================================

/**
 * Get the current hash for project directives
 */
export function getProjectDirectivesHash(folder: string): string | null {
  const file = directivesState().projectByFolder.get(folder)
  return file?.hash ?? null
}

/**
 * Get the current hash for global directives
 */
export function getGlobalDirectivesHash(): string | null {
  return directivesState().global?.hash ?? null
}

/**
 * Get the current hash for constitution
 */
export function getConstitutionHash(): string | null {
  return directivesState().constitution?.hash ?? null
}

/**
 * Export the session ID for use in other stores
 */
export function getSessionId(): string {
  return sessionId
}
