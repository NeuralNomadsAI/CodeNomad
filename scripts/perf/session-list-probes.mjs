const percentile = (numbers, fraction) => numbers.length
  ? numbers.toSorted((a, b) => a - b)[Math.ceil(numbers.length * fraction) - 1]
  : null

/** Sample only the fixture tab, using Chromium's task boundaries (not the 50 ms Long Tasks API). */
export async function sampleSessionList(context, page) {
  const cdp = await context.newCDPSession(page)
  await cdp.send("Performance.enable")
  const metrics = async () => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map(({ name, value }) => [name, value]))
  await page.evaluate(() => {
    window.perfKeyEvents = []
    new PerformanceObserver(list => {
      for (const event of list.getEntries()) {
        if (/^key/.test(event.name) && event.target instanceof HTMLTextAreaElement) window.perfKeyEvents.push(event.duration)
      }
    }).observe({ type: "event", durationThreshold: 16 })
  })
  const threads = new Set(), taskCounts = new Map(), candidates = [], callbacks = []
  const thread = event => `${event.pid}:${event.tid}`
  cdp.on("Tracing.dataCollected", ({ value }) => {
    for (const event of value) {
      if (event.name === "thread_name" && event.args.name === "CrRendererMain") threads.add(thread(event))
      if (event.ph !== "X") continue
      if (event.name === "ThreadControllerImpl::RunTask") {
        const key = thread(event)
        taskCounts.set(key, (taskCounts.get(key) ?? 0) + 1)
        if (event.dur >= 16_000) candidates.push(event)
      } else if (["EventDispatch", "TimerFire", "FireAnimationFrame"].includes(event.name)) callbacks.push(event)
    }
  })
  await cdp.send("Tracing.start", { categories: "toplevel,devtools.timeline", transferMode: "ReportEvents" })
  const before = await metrics()
  return async () => {
    const after = await metrics()
    const completed = new Promise(resolve => cdp.once("Tracing.tracingComplete", resolve))
    await cdp.send("Tracing.end")
    const { dataLossOccurred } = await completed
    const rendererTasks = [...threads].reduce((sum, key) => sum + (taskCounts.get(key) ?? 0), 0)
    if (dataLossOccurred || rendererTasks === 0) throw new Error("Chromium trace did not retain renderer task boundaries")
    const tasks = candidates.filter(event => threads.has(thread(event))).map(event => ({
      atMs: event.ts / 1000,
      durationMs: event.dur / 1000,
      callbacks: [...new Set(callbacks.filter(callback => thread(callback) === thread(event)
        && callback.ts >= event.ts && callback.ts < event.ts + event.dur)
        .map(callback => callback.args?.data?.type ?? callback.name))],
    }))
    const keyEvents = await page.evaluate(() => window.perfKeyEvents)
    await cdp.detach()
    return {
      seconds: after.Timestamp - before.Timestamp,
      mainThreadBusyPct: 100 * (after.TaskDuration - before.TaskDuration) / (after.Timestamp - before.Timestamp),
      filteredKeyEventP95: percentile(keyEvents, 0.95),
      rendererTasks,
      tasksAtLeast16ms: tasks.length,
      eventOrTimerTasksAtLeast16ms: tasks.filter(task => task.callbacks.length > 0).length,
      tasks,
    }
  }
}
