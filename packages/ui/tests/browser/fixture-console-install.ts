// Runs synchronously in each fixture document, before its bootstrap scripts.
export function installConsoleCapture({ binding, token }: { binding: string; token: string }) {
  const global = globalThis as any
  if (global[Symbol.for(binding)]) return
  global[Symbol.for(binding)] = true
  const document = Array.from(crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, "0")).join("")
  let sequence = 0
  global[binding](JSON.stringify({ kind: "init", document }))
  for (const level of ["debug", "log", "info", "warn", "error", "trace"] as const) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]) => {
      // Chromium emits nothing for empty calls except trace's implicit label.
      if (!args.length) {
        if (level !== "trace") return original()
        args = ["console.trace"]
      }
      const seq = ++sequence, id = document + ":" + seq
      let payload
      try {
        const copy = JSON.parse(JSON.stringify(args, (_key, item) => item instanceof Error
          ? { ...item, name: item.name, message: item.message, stack: item.stack } : item))
        payload = { kind: "call", document, sequence: seq, id, level, args: copy }
      } catch {
        payload = { kind: "serialization-error", document, sequence: seq, id, level }
      }
      // Original arguments and their immutable copy share ONE native notification.
      return original(...args, token + id + "|" + JSON.stringify(payload))
    }
  }
}
