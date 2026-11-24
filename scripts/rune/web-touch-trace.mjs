// Capture before Rune consumes touch and touch-pointer events; drain before writing reports.
export async function recordTouches(context, touches) {
  await context.exposeBinding('__fixtureRecordTouch', (_source, gesture) => {
    touches.push(gesture)
  })
  await context.addInitScript(() => {
    const active = new Map()
    const pending = new Set()
    const point = (event, coords, receivedAt) => ({
      type:event.type, x:coords.clientX, y:coords.clientY, target:event.target?.tagName,
      eventAt:event.timeStamp, receivedAt,
    })
    const ship = gesture => {
      const flight = Promise.resolve(globalThis.__fixtureRecordTouch(gesture))
        .catch(() => {})
        .finally(() => pending.delete(flight))
      pending.add(flight)
    }
    const handle = (kind, id, phase, event, coords, receivedAt, extra = {}) => {
      const key = `${kind}:${id}`
      if (phase === 'start') {
        active.set(key, {kind, ...extra, path:location.pathname, timeOrigin:performance.timeOrigin,
          start:point(event, coords, receivedAt), moves:0})
        return
      }
      const gesture = active.get(key)
      if (phase === 'move') {
        if (gesture && ++gesture.moves === 1) gesture.firstMove = point(event, coords, receivedAt)
        return
      }
      active.delete(key)
      const end = point(event, coords, receivedAt)
      ship({...gesture, kind, ...extra, id, end,
        domMs:gesture ? receivedAt-gesture.start.receivedAt : null,
        eventMs:gesture ? end.eventAt-gesture.start.eventAt : null,
      })
    }
    for (const [type, phase] of [['touchstart','start'],['touchmove','move'],['touchend','end'],['touchcancel','end']]) {
      addEventListener(type, event => {
        const receivedAt = performance.now()
        if (!event.isTrusted) return
        for (const touch of event.changedTouches) handle('touch', touch.identifier, phase, event, touch, receivedAt)
      }, {capture:true, passive:true})
    }
    for (const [type, phase] of [['pointerdown','start'],['pointermove','move'],['pointerup','end'],['pointercancel','end']]) {
      addEventListener(type, event => {
        const receivedAt = performance.now()
        if (!event.isTrusted || event.pointerType !== 'touch') return
        handle('pointer', event.pointerId, phase, event, event, receivedAt,
          {pointerType:event.pointerType, isPrimary:event.isPrimary})
      }, {capture:true, passive:true})
    }
    globalThis.__fixtureFlushTouches = async () => {
      while (pending.size) await Promise.all([...pending])
    }
  })
  return async () => {
    await Promise.allSettled(
      context.pages().map(page => page.evaluate(() => globalThis.__fixtureFlushTouches?.()).catch(() => {})),
    )
  }
}
