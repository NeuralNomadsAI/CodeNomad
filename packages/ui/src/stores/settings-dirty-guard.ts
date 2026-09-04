type SettingsDirtyGuard = () => boolean | Promise<boolean>

const guards = new Set<SettingsDirtyGuard>()
let confirmationQueue = Promise.resolve()

export function registerSettingsDirtyGuard(guard: SettingsDirtyGuard) {
  guards.add(guard)
  return () => guards.delete(guard)
}

export function confirmSettingsDiscard() {
  const confirmation = confirmationQueue.then(async () => {
    for (const guard of Array.from(guards)) {
      if (!(await guard())) return false
    }
    return true
  })
  confirmationQueue = confirmation.then(() => undefined, () => undefined)
  return confirmation
}
