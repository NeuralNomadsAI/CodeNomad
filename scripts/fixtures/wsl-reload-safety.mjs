// Destructive reload characterization against an explicitly isolated fixture.
// The synthetic provider holds one real model stream open across location.reload.
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { setTimeout as delay } from "node:timers/promises"
import { boundedFixtureOperation } from "./wsl-fixture-bounds.mjs"
import { stopFixtureChild } from "../native-fixture-guards.mjs"

export async function startReloadSafetyProvider({ distro, root, environment, unc, signal }) {
  const directory = `${root}/reload-provider`
  await mkdir(unc(directory))
  const source = `import http.server, json, pathlib, sys, threading, time
root = pathlib.Path(sys.argv[1])
class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['content-length'])))
        primary = self.headers.get('x-reload-kind') == 'primary'
        with (root / 'requests.jsonl').open('a') as f:
            f.write(json.dumps({'primary': primary, 'stream': body.get('stream', False)}) + '\\n')
        if not body.get('stream'):
            self.send_response(200); self.send_header('content-type', 'application/json'); self.end_headers()
            self.wfile.write(json.dumps({'id':'fixture','choices':[{'message':{'role':'assistant','content':'Fixture'},'finish_reason':'stop'}]}).encode())
            return
        self.send_response(200); self.send_header('content-type','text/event-stream'); self.end_headers()
        def chunk(delta, finish=None):
            self.wfile.write(('data: ' + json.dumps({'id':'fixture','object':'chat.completion.chunk','model':'fixture','choices':[{'index':0,'delta':delta,'finish_reason':finish}]}) + '\\n\\n').encode())
            self.wfile.flush()
        try:
            chunk({'role':'assistant','content':'Before reload. '})
            if primary:
                (root / 'stream-open').touch()
                while not (root / 'release').exists() and not (root / 'stop').exists(): time.sleep(.05)
            chunk({'content':'After reload.'})
            chunk({}, 'stop')
            self.wfile.write(b'data: [DONE]\\n\\n'); self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            (root / 'stream-broken').touch()
server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
(root / 'port').write_text(str(server.server_port))
def stop():
    while not (root / 'stop').exists(): time.sleep(.05)
    server.shutdown()
threading.Thread(target=stop, daemon=True).start()
server.serve_forever()
server.server_close()
`
  const child = spawn("wsl.exe", ["--distribution", distro, "--exec", "/usr/bin/env", "-i",
    ...Object.entries(environment).map(([key, value]) => `${key}=${value}`), "/usr/bin/python3", "-", directory],
  { windowsHide: true, stdio: ["pipe", "ignore", "pipe"] })
  let stderr = ""
  child.stderr.on("data", chunk => { stderr += chunk })
  const closed = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve) })
  // Attach immediately; startup/stop still await the original failure below.
  void closed.catch(() => {})
  child.stdin.end(source)
  const stop = async () => {
    try {
      await boundedFixtureOperation(async () => {
        await writeFile(unc(`${directory}/release`), "")
        await writeFile(unc(`${directory}/stop`), "")
        await closed
      }, Date.now() + 5_000, "local provider shutdown")
    } catch (error) {
      await stopFixtureChild(child, closed)
      throw error
    }
  }
  try {
    let port
    for (let i = 0; i < 100; i++) {
      signal?.throwIfAborted()
      port = Number(await boundedFixtureOperation(() => readFile(unc(`${directory}/port`), "utf8").catch(error => {
        if (error.code !== "ENOENT") throw error
        return "0"
      }), Date.now() + 5_000, "provider startup", signal))
      if (port) break
      if (child.exitCode !== null) throw new Error(`Fixture provider exited: ${stderr}`)
      await delay(100)
    }
    assert.ok(port > 0, "Fixture provider failed to start")
    return {
      port, directory, stop,
      waitForStream: async () => {
        for (let i = 0; i < 200; i++) {
          signal?.throwIfAborted()
          if (await boundedFixtureOperation(() => readFile(unc(`${directory}/stream-open`)).then(() => true, error => {
            if (error.code !== "ENOENT") throw error
            return false
          }), Date.now() + 5_000, "provider stream readiness", signal)) return
          await delay(100)
        }
        throw new Error(`Fixture model stream did not start: ${stderr}`)
      },
      release: () => writeFile(unc(`${directory}/release`), ""),
      requests: async () => (await readFile(unc(`${directory}/requests.jsonl`), "utf8")).trim().split("\n").map(JSON.parse),
    }
  } catch (error) { await stop(); throw error }
}

export async function prepareReloadSafety({ client, root, unc, provider }) {
  const promptLocation = { directory: `${root}/reload-prompt` }
  const resourcesLocation = { directory: `${root}/reload-resources` }
  await mkdir(unc(promptLocation.directory)); await mkdir(unc(resourcesLocation.directory))
  const promptSession = await client.session.create({ location: promptLocation, title: "Held local-provider prompt" })
  const resourceSession = await client.session.create({ location: resourcesLocation, title: "Pending interactions" })
  await client.session.prompt({ sessionID: promptSession.id, text: "Complete one response." })
  await provider.waitForStream()
  const form = await client.session.form.create({ sessionID: resourceSession.id, title: "Must remain pending", fields: [{ key: "answer", type: "string", required: true }] })
  const shell = (await client.shell.create({ location: resourcesLocation, command: "sleep 600" })).data
  const pty = (await client.pty.create({ location: resourcesLocation, command: "/bin/sh", args: ["-c", "sleep 600"], title: "Must remain available" })).data
  assert.ok((await client.session.form.list({ sessionID: resourceSession.id })).some(item => item.id === form.id))
  assert.equal((await client.shell.get({ location: resourcesLocation, id: shell.id })).data.status, "running")
  assert.equal((await client.pty.get({ location: resourcesLocation, ptyID: pty.id })).data.status, "running")
  const events = []
  const controller = new AbortController()
  let consumerFailure
  const consume = (async () => {
    try { for await (const event of client.event.subscribe({ signal: controller.signal })) events.push(event) }
    catch (error) { if (!controller.signal.aborted) consumerFailure = error }
  })()
  const finishConsumer = async () => {
    controller.abort()
    await consume
    if (consumerFailure) throw consumerFailure
  }
  let info
  try {
    await delay(200)
    if (consumerFailure) throw consumerFailure
    info = await client.server.info()
    if (consumerFailure) throw consumerFailure
  } catch (error) {
    try { await finishConsumer() }
    finally { await provider.release() }
    throw error
  }
  const before = { pid: info.pid, promptSessionID: promptSession.id, resourceSessionID: resourceSession.id, formID: form.id, shellID: shell.id, ptyID: pty.id }
  return {
    before,
    async observe() {
      try {
        const result = async promise => {
          try { return { value: await promise } }
          catch (error) { return { error: { tag: error._tag, message: error.message, status: error.cause?.status, reason: error.reason } } }
        }
        const after = {
          pid: (await client.server.info()).pid,
          forms: await client.session.form.list({ sessionID: resourceSession.id }),
          formReply: await result(client.session.form.reply({ sessionID: resourceSession.id, formID: form.id, answer: { answer: "Still here" } })),
          shell: await result(client.shell.get({ location: resourcesLocation, id: shell.id })),
          pty: await result(client.pty.get({ location: resourcesLocation, ptyID: pty.id })),
          active: await client.session.active(),
        }
        await provider.release()
        await client.session.wait({ sessionID: promptSession.id }, { signal: AbortSignal.timeout(20_000) })
        after.promptContext = await client.session.context({ sessionID: promptSession.id })
        after.primaryRequests = (await provider.requests()).filter(request => request.primary).length
        after.events = events.filter(event => event.type === "form.cancelled" || event.type === "location.shutdown" || event.type.startsWith("session.execution."))
        assert.equal(after.pid, before.pid, "Reload keeps the daemon PID, which does not imply resource continuity")
        assert.equal(after.active[promptSession.id]?.type, "running", "The original provider stream is still running after reload")
        assert.equal(after.primaryRequests, 1, "A held model request must not be replayed")
        assert.ok(after.promptContext.some(message => message.type === "assistant" && message.content.some(part => part.type === "text" && part.text === "Before reload. After reload.")))
        assert.ok(after.promptContext.some(message => message.type === "idle" && message.outcome === "succeeded"))
        assert.ok(after.events.some(event => event.type === "form.cancelled" && event.data.id === form.id), "Characterization must observe native Form cancellation")
        assert.equal(after.forms.length, 0)
        assert.equal(after.formReply.error?.tag, "FormNotFoundError")
        assert.equal(after.shell.error?.tag, "ShellNotFoundError")
        assert.equal(after.pty.error?.tag, "PtyNotFoundError")
        return { before, after, automaticReloadSafe: false }
      } finally { await finishConsumer() }
    },
    async dispose() { try { await finishConsumer() } finally { await provider.release() } },
  }
}
