import { Worker } from "node:worker_threads"

interface GitRequest { id: number; directory: string; args: string[]; env: NodeJS.ProcessEnv; timeout?: number }
interface GitResponse { id: number; stdout: string; stderr: string; error?: { message: string; code?: string | number | null } }

// Even asynchronous execFile spends synchronous time creating a Windows process.
// Keep that work off the HTTP/SSE thread. The worker is self-contained so the same
// entry works in compiled desktop resources and TypeScript test runners.
function workerMain() {
  const { parentPort } = require("node:worker_threads") as typeof import("node:worker_threads")
  const { execFile } = require("node:child_process") as typeof import("node:child_process")
  const queue: GitRequest[] = []
  let running = 0
  const scheduler = { pump() {
    while (running < 2 && queue.length) {
      const request = queue.shift()!
      running += 1
      execFile("git", ["-C", request.directory, ...request.args], {
        encoding: "utf8", windowsHide: true, maxBuffer: 1024 * 1024,
        env: request.env, timeout: request.timeout,
      }, (error, stdout, stderr) => {
        parentPort!.postMessage({ id: request.id, stdout, stderr,
          ...(error ? { error: { message: error.message, code: error.code } } : {}),
        } satisfies GitResponse)
        running -= 1
        scheduler.pump()
      })
    }
  } }
  parentPort!.on("message", (request: GitRequest) => { queue.push(request); scheduler.pump() })
}

let worker: Worker | undefined
let sequence = 0
const pending = new Map<number, { resolve: (stdout: string) => void; reject: (error: Error) => void }>()

function getWorker(): Worker {
  if (worker) return worker
  const created = new Worker(`(${workerMain.toString()})()`, { eval: true, execArgv: [] })
  worker = created
  const failed = (error: Error) => {
    if (worker !== created) return
    worker = undefined
    for (const task of pending.values()) task.reject(error)
    pending.clear()
  }
  created.on("error", failed)
  created.on("exit", code => failed(new Error(`Git process worker exited (${code})`)))
  created.on("message", (response: GitResponse) => {
    const task = pending.get(response.id)
    if (!task) return
    pending.delete(response.id)
    if (response.error) task.reject(Object.assign(new Error(response.error.message), {
      code: response.error.code, stdout: response.stdout, stderr: response.stderr,
    }))
    else task.resolve(response.stdout.replace(/\r?\n$/, ""))
    if (pending.size === 0) created.unref()
  })
  created.unref()
  return created
}

export function runWorktreeGit(directory: string, args: string[], timeout?: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const current = getWorker()
    const id = ++sequence
    pending.set(id, { resolve, reject })
    current.ref()
    try {
      current.postMessage({ id, directory, args, env: { ...process.env }, timeout } satisfies GitRequest)
    } catch (error) {
      pending.delete(id)
      if (pending.size === 0) current.unref()
      reject(error)
    }
  })
}
