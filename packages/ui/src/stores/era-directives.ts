import { createSignal, createMemo } from "solid-js"
import { getLogger } from "../lib/logger"
import { ERA_CODE_API_BASE } from "../lib/api-client"

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
}

/**
 * Directives state
 */
interface DirectivesState {
  loading: boolean
  error: string | null
  project: DirectivesFile | null
  global: DirectivesFile | null
  constitution: DirectivesFile | null
  lastFetched: number | null
}

const initialState: DirectivesState = {
  loading: false,
  error: null,
  project: null,
  global: null,
  constitution: null,
  lastFetched: null,
}

const [directivesState, setDirectivesState] = createSignal<DirectivesState>(initialState)

/**
 * Fetch directives from the server
 */
export async function fetchDirectives(folder?: string): Promise<void> {
  setDirectivesState((prev) => ({ ...prev, loading: true, error: null }))

  try {
    const params = folder ? `?folder=${encodeURIComponent(folder)}` : ""

    // Fetch project, global, and constitution in parallel
    const [projectRes, globalRes, constitutionRes] = await Promise.all([
      folder ? fetch(apiUrl(`/api/era/directives${params}&type=project`)) : Promise.resolve(null),
      fetch(apiUrl("/api/era/directives?type=global")),
      folder ? fetch(apiUrl(`/api/era/constitution${params}`)) : Promise.resolve(null),
    ])

    let project: DirectivesFile | null = null
    let global: DirectivesFile | null = null
    let constitution: DirectivesFile | null = null

    if (projectRes?.ok) {
      const data = await projectRes.json()
      if (data.success) {
        project = {
          content: data.content,
          path: data.path,
          exists: data.exists,
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
        }
      }
    }

    setDirectivesState({
      loading: false,
      error: null,
      project,
      global,
      constitution,
      lastFetched: Date.now(),
    })

    log.info("Directives fetched", {
      hasProject: project?.exists,
      hasGlobal: global?.exists,
      hasConstitution: constitution?.exists,
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error"
    log.warn("Failed to fetch directives", { error: errorMessage })

    setDirectivesState((prev) => ({
      ...prev,
      loading: false,
      error: errorMessage,
    }))
  }
}

/**
 * Save directives content
 */
export async function saveDirectives(
  folder: string,
  type: "project" | "global",
  content: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const response = await fetch(apiUrl("/api/era/directives"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folder, type, content }),
    })

    const data = await response.json()

    if (data.success) {
      // Update local state
      setDirectivesState((prev) => ({
        ...prev,
        [type]: {
          content,
          path: data.path,
          exists: true,
        },
      }))
      log.info("Directives saved", { type, path: data.path })
    }

    return data
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
 * Derived: Project directives
 */
export const projectDirectives = createMemo(() => directivesState().project)

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
