// Capture before Rune consumes the event; ship the trace only after release/cancel.
export async function recordTouches(context, touches) {
  await context.exposeBinding('__fixtureRecordTouch', (_source, gesture) => {
    touches.push(gesture)
  })
  await context.addInitScript(() => {
    const fingers = new Map()
    const point = (event, touch, receivedAt) => ({
      type:event.type, x:touch.clientX, y:touch.clientY, target:event.target?.tagName,
      eventAt:event.timeStamp, receivedAt,
    })
    for (const type of ['touchstart','touchmove','touchend','touchcancel']) {
      addEventListener(type, event => {
        const receivedAt = performance.now()
        if (!event.isTrusted) return
        for (const touch of event.changedTouches) {
          const id = touch.identifier
          if (type === 'touchstart') {
            fingers.set(id, {path:location.pathname, timeOrigin:performance.timeOrigin,
              start:point(event, touch, receivedAt), moves:0})
            continue
          }
          const gesture = fingers.get(id)
          if (type === 'touchmove') {
            if (gesture && ++gesture.moves === 1) gesture.firstMove = point(event, touch, receivedAt)
          } else {
            fingers.delete(id)
            const end = point(event, touch, receivedAt)
            void globalThis.__fixtureRecordTouch({...gesture, id, end,
              domMs:gesture ? receivedAt-gesture.start.receivedAt : null,
              eventMs:gesture ? end.eventAt-gesture.start.eventAt : null,
            }).catch(() => {})
          }
        }
      }, {capture:true, passive:true})
    }
  })
}
