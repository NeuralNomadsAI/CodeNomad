import { serverApi } from "../../../src/lib/api-client"
import { updatePreferences, type UiSettings } from "../../../src/stores/preferences"

// Browser tests answer every /api request with an empty body, so settings
// loads fall back to defaults and writes fail. Fixtures that depend on a
// specific preference keep the "ui" config bucket in memory instead.
export async function applyUiSettings(settings: Partial<UiSettings>): Promise<void> {
  let bucket: { settings?: Record<string, unknown> } = {}
  serverApi.patchConfigOwner = async <T extends Record<string, unknown>>(_owner: string, patch: unknown): Promise<T> => {
    const next = (patch ?? {}) as { settings?: Record<string, unknown> }
    bucket = { settings: { ...bucket.settings, ...next.settings } }
    return bucket as T
  }
  if (!(await updatePreferences(settings))) throw new Error("Fixture ui settings were not applied")
}
