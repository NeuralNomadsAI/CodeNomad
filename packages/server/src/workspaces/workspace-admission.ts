const tails = new Map<string, Promise<void>>()

export async function withWorkspaceAdmission<T>(keys: string[], operation: () => Promise<T>): Promise<T> {
  const uniqueKeys = Array.from(new Set(keys)).sort()
  const previous = uniqueKeys.map((key) => tails.get(key) ?? Promise.resolve())
  let release!: () => void
  const current = new Promise<void>((resolve) => { release = resolve })
  const tail = Promise.all(previous).then(() => current)
  for (const key of uniqueKeys) tails.set(key, tail)
  await Promise.all(previous)
  try {
    return await operation()
  } finally {
    release()
    for (const key of uniqueKeys) {
      if (tails.get(key) === tail) tails.delete(key)
    }
  }
}
