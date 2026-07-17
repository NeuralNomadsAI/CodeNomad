export async function runWithSerializedCommits<T>(
  items: readonly T[],
  run: (item: T, waitForCommit: Promise<void>, finishCommit: () => void) => Promise<void>,
): Promise<void> {
  let previous = Promise.resolve()
  const tasks = items.map((item) => {
    const waitForCommit = previous
    let finishCommit!: () => void
    const commit = new Promise<void>((resolve) => { finishCommit = resolve })
    const task = run(item, waitForCommit, finishCommit).finally(finishCommit)
    previous = Promise.allSettled([waitForCommit, commit]).then(() => undefined)
    return task
  })
  await Promise.all(tasks)
}
