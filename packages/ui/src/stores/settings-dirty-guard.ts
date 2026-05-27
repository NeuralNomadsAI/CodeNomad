type SettingsDirtyGuard = () => boolean | Promise<boolean>

const guards = new Set<SettingsDirtyGuard>()

export function registerSettingsDirtyGuard(guard: SettingsDirtyGuard) {
  guards.add(guard)
  return () => guards.delete(guard)
}

export async function confirmSettingsDiscard() {
  for (const guard of Array.from(guards)) {
    const confirmed = await guard()
    if (!confirmed) return false
  }
  return true
}
