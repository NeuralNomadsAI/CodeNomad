import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import type { Browser, CDPSession, ConsoleMessage, Page } from "playwright"
import { installConsoleCapture } from "./fixture-console-install"
import { exceptionToError, nativePreview } from "./fixture-console-format"

type Packet = { method: string; params?: any }
type Options = {
  beforeDeliver?: (packet: Packet, slot: number) => Promise<void>
  fault?: (method: string, params: any) => any[]
  onCleanupError?: (error: unknown) => void
}
export type ConsoleEntry = { id?: string; type: string; text: string; args: unknown[]; context?: number; sequence?: number; browserSource?: string }

// Chromium-only test transport. One ordered CDP event channel owns values AND
// completion; Playwright console events can witness/refuse coverage, never fill it.
export async function captureConsole(page: Page, browser: Browser, options: Options = {}) {
  const channel = "fixture_" + randomUUID().replaceAll("-", ""), token = "@" + channel + ":"
  const root = await browser.newBrowserCDPSession()
  let probe: CDPSession | undefined
  let queue = Promise.resolve(), listener: ((event: Packet) => void) | undefined
  const originalInit = page.addInitScript
  try {
    probe = await page.context().newCDPSession(page)
    const targetInfo = (await probe.send("Target.getTargetInfo")).targetInfo, target = targetInfo.targetId
    await probe.detach()
    probe = undefined
    const contexts = new Map<number, any>(), history = new Map<string, any>(), documents = new Set<string>()
    const snapshots = new Map<string, any>(), native = new Map<string, any>(), pending = new Map<number, ReturnType<typeof Promise.withResolvers<any>>>()
    const failures: string[] = [], logs: any[] = [], pageErrors: Array<{ message: string; stack?: string }> = []
    const detachedGate = Promise.withResolvers<void>(), destroyedGate = Promise.withResolvers<void>(), rawRetired = Promise.withResolvers<void>()
    let session = "", next = 0, received = 0, processed = 0, rawCalls = 0, detached = false, destroyed = false, observerClosed = false
    const fail = (kind: string) => { if (!failures.includes(kind)) failures.push(kind) }
    const contractError = (categories: string[]) => Object.assign(new Error("fixture console contract failed"), { categories })
    function consume(method: string, params: any) {
      if (method === "Target.detachedFromTarget" && params.sessionId === session) {
        if (detached) fail("duplicate-terminal-receipt")
        detached = true
        for (const context of contexts.values()) context.retired = true
        contexts.clear()
        detachedGate.resolve()
        return
      }
      if (method === "Target.targetDestroyed" && params.targetId === target) {
        if (destroyed) fail("duplicate-terminal-receipt")
        destroyed = true
        destroyedGate.resolve()
        return
      }
      if (method === "Target.targetCreated" && params.targetInfo.targetId !== target && !["browser", "tab", "browser_ui"].includes(params.targetInfo.type)) {
        if (!params.targetInfo.browserContextId) fail("unattributed-child-target")
        else if (params.targetInfo.browserContextId === targetInfo.browserContextId) fail("unsupported-child-target")
        return
      }
      if (method === "Target.attachedToTarget") { fail("unsupported-child-target"); return }
      if (method === "Runtime.executionContextCreated") {
        const context = { ...params.context, retired: false }
        if (contexts.has(context.id) || history.has(context.uniqueId)) fail("duplicate-context")
        contexts.set(context.id, context)
        history.set(context.uniqueId, context)
        return
      }
      if (method === "Runtime.executionContextDestroyed") {
        const context = contexts.get(params.executionContextId)
        if (!context || params.executionContextUniqueId && context.uniqueId !== params.executionContextUniqueId) fail("unknown-context-retirement")
        else { context.retired = true; contexts.delete(context.id) }
        return
      }
      if (method === "Runtime.executionContextsCleared") {
        for (const context of contexts.values()) context.retired = true
        contexts.clear()
        return
      }
      if (method === "Runtime.bindingCalled" && params.name === channel) {
        try {
          const snapshot = JSON.parse(params.payload), context = contexts.get(params.executionContextId)
          if (!context || context.retired || !context.auxData?.isDefault) throw new Error()
          if (snapshot.kind !== "init" || Object.keys(snapshot).length !== 2 || context.document || !/^[\da-f]{32}$/.test(snapshot.document) || documents.has(snapshot.document)) throw new Error()
          context.document = snapshot.document
          documents.add(snapshot.document)
          context.sequence = 0
        } catch { fail("malformed-snapshot") }
        return
      }
      if (method === "Runtime.consoleAPICalled") {
        if (detached) fail("event-after-target-retirement")
        const context = contexts.get(params.executionContextId), last = params.args.at(-1)
        if (!context || context.retired || !context.auxData?.isDefault) fail("console-context-invalid")
        if (last?.type !== "string" || !last.value.startsWith(token)) { fail("untagged-native-console"); return }
        const separator = last.value.indexOf("|", token.length), id = last.value.slice(token.length, separator)
        if (separator < 0 || !/^[\da-f]{32}:[1-9]\d*$/.test(id)) { fail("malformed-native-tag"); return }
        if (native.has(id)) { fail("duplicate-native"); return }
        try {
          const snapshot = JSON.parse(last.value.slice(separator + 1))
          if (snapshot.kind === "serialization-error") { fail("serialization-failure"); return }
          if (snapshot.id !== id) { fail("orphan-native"); return }
          if (!context || Object.keys(snapshot).length !== 6 || snapshot.kind !== "call" || snapshot.document !== context.document
            || snapshot.id !== snapshot.document + ":" + snapshot.sequence || !Number.isSafeInteger(snapshot.sequence) || snapshot.sequence !== context.sequence + 1
            || !Array.isArray(snapshot.args) || snapshot.args.length !== params.args.length - 1 || !["debug", "log", "info", "warn", "error", "trace"].includes(snapshot.level)) throw new Error()
          context.sequence = snapshot.sequence
          snapshots.set(id, { ...snapshot, context: context.id, uniqueId: context.uniqueId })
          native.set(id, { ...params, args: params.args.slice(0, -1), uniqueId: context.uniqueId })
        } catch { fail("malformed-snapshot") }
        return
      }
      if (method === "Log.entryAdded") { logs.push(params.entry); if (params.entry.args?.length) fail("unsupported-browser-log-arguments"); return }
      if (method === "Runtime.exceptionThrown") {
        const error = exceptionToError(params.exceptionDetails)
        pageErrors.push({ message: error.message, stack: error.stack })
      }
    }
    const deliver = (method: string, params: any) => {
      for (const value of options.fault ? options.fault(method, params) : [params]) consume(method, value)
    }
    listener = event => {
      const packet = structuredClone(event), slot = ++received
      if (packet.method === "Target.targetDestroyed" && packet.params.targetId === target) rawRetired.resolve()
      if (packet.method === "Target.receivedMessageFromTarget" && packet.params.sessionId === session) {
        if (JSON.parse(packet.params.message).method === "Runtime.consoleAPICalled") rawCalls++
      }
      queue = queue.then(async () => {
        await options.beforeDeliver?.(packet, slot)
        if (packet.method === "Target.receivedMessageFromTarget") {
          if (packet.params.sessionId === session) {
            const message = JSON.parse(packet.params.message)
            if (message.id) {
              const waiter = pending.get(message.id)
              pending.delete(message.id)
              if (!waiter) fail("unknown-response")
              else if (message.error) waiter.reject(message.error)
              else waiter.resolve(message.result)
            } else deliver(message.method, message.params)
          }
        } else if (!(packet.method === "Target.attachedToTarget" && packet.params.targetInfo.targetId === target)) deliver(packet.method, packet.params)
        processed++
      }).catch(() => { fail("delivery-failure"); processed++ })
    }
    root.on("event", listener)
    await root.send("Target.setDiscoverTargets", { discover: true })
    session = (await root.send("Target.attachToTarget", { targetId: target, flatten: false })).sessionId
    const send = (method: string, params: any = {}) => {
      const id = ++next, gate = Promise.withResolvers<any>()
      pending.set(id, gate)
      root.send("Target.sendMessageToTarget", { sessionId: session, message: JSON.stringify({ id, method, params }) }).catch(gate.reject)
      return gate.promise
    }
    await send("Runtime.enable")
    await send("Page.enable")
    await send("Log.enable")
    await send("Runtime.addBinding", { name: channel })
    // Refuse all related application targets, including workers and OOPIFs.
    // browser_ui is CDP's internal Chrome WebUI target type.
    await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: false, filter: [{ type: "browser_ui", exclude: true }, {}] })
    const install = "(" + installConsoleCapture.toString() + ")(" + JSON.stringify({ binding: channel, token }) + ")"
    const addInitScript = originalInit.bind(page)
    page.addInitScript = (async (script: any, arg: any) => {
      assert.ok(typeof script === "function" || typeof script === "string", "fixture bootstrap uses callback or source string")
      if (typeof script === "string") assert.equal(arg, undefined)
      const body = typeof script === "function" ? "(" + script.toString() + ")(" + JSON.stringify(arg) + ")" : script
      return addInitScript({ content: install + ";\n" + body })
    }) as Page["addInitScript"]
    // Context installation precedes transfer to the fixture's page bootstrap;
    // each page bootstrap is also explicitly composed above (order independent).
    await page.context().addInitScript({ content: install })
    await send("Runtime.evaluate", { expression: install })
    function reconcile(final = false) {
      const counts = new Map<string, number>()
      for (const snapshot of snapshots.values()) counts.set(snapshot.uniqueId, (counts.get(snapshot.uniqueId) ?? 0) + 1)
      for (const context of history.values()) if (context.document && (counts.get(context.uniqueId) ?? 0) !== context.sequence) fail("context-sequence-incomplete")
      if (final && [...history.values()].some(context => context.auxData?.isDefault && !context.document)) fail("missing-document-registration")
      if (native.size !== rawCalls) fail("missing-native")
      if (snapshots.size !== rawCalls) fail("missing-snapshot")
      for (const [id, snapshot] of snapshots) {
        const message = native.get(id)
        if (!message) fail("missing-native")
        else if (message.executionContextId !== snapshot.context || message.uniqueId !== snapshot.uniqueId || message.args.length !== snapshot.args.length
          || message.type !== (snapshot.level === "warn" ? "warning" : snapshot.level)) fail("association-mismatch")
      }
      for (const id of native.keys()) if (!snapshots.has(id)) fail("orphan-native")
      if (final && (!detached || !destroyed || !observerClosed || pending.size || processed !== received || [...history.values()].some(context => !context.retired))) fail("incomplete-completion")
      if (failures.length) throw contractError([...failures])
      return { calls: snapshots.size, contexts: history.size, documents: documents.size, retired: [...history.values()].filter(context => context.retired).length,
        browserLogs: logs.length, pageErrors: pageErrors.length, received, processed, observerClosed }
    }
    const consoleEntries = (): ConsoleEntry[] => [
      ...[...snapshots].map(([id, snapshot]) => ({ id, type: snapshot.level === "warn" ? "warning" : snapshot.level,
        text: native.get(id)?.args.map(nativePreview).join(" "), args: snapshot.args, context: snapshot.context, sequence: snapshot.sequence })),
      ...logs.map(log => ({ type: log.level, text: log.text, args: [], browserSource: log.source })),
    ]
    return { token, snapshots, native, history, logs, pageErrors, consoleEntries, reconcile, rawRetired: rawRetired.promise,
      async fence() { await send("Runtime.evaluate", { expression: "0", returnByValue: true }); await queue; return reconcile() },
      async complete() {
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          await Promise.race([Promise.all([detachedGate.promise, destroyedGate.promise]), new Promise((_, reject) => {
            timer = setTimeout(() => reject(contractError(["retirement-timeout"])), 20_000)
          })])
          const targets = await root.send("Target.getTargets")
          if (targets.targetInfos.some((info: any) => info.targetId === target)) fail("target-still-live")
          await queue
          await root.detach()
          await queue
          observerClosed = true
          root.off("event", listener!)
          page.addInitScript = originalInit
          return reconcile(true)
        } finally { clearTimeout(timer) }
      },
      async abort() {
        try { if (!observerClosed) await root.detach() }
        finally { await queue; root.off("event", listener!); page.addInitScript = originalInit }
      },
    }
  } catch (error) {
    // Initialization owns its observer until the fully installed collector transfers.
    for (const detach of [() => probe?.detach(), () => root.detach()]) {
      try { await detach() }
      catch (cleanupError) {
        try { options.onCleanupError?.(cleanupError) } catch {}
        console.error("fixture-console-init-cleanup-failed")
      }
    }
    await queue
    if (listener) root.off("event", listener)
    page.addInitScript = originalInit
    throw error
  }
}

// Refusal witness only. Values/text/completion always come from the native channel.
export function refuseUntaggedConsole(message: ConsoleMessage, token: string) {
  const args = message.args()
  if (!args.length) return
  const tag = args.at(-1)!.toString()
  let valid = false
  try {
    const separator = tag.indexOf("|", token.length), id = tag.slice(token.length, separator), snapshot = JSON.parse(tag.slice(separator + 1))
    valid = tag.startsWith(token) && /^[\da-f]{32}:[1-9]\d*$/.test(id) && snapshot.id === id && ["call", "serialization-error"].includes(snapshot.kind)
  } catch {}
  if (!valid) throw Object.assign(new Error("uncovered fixture console arguments"), { categories: ["untagged-playwright-arguments"] })
}
